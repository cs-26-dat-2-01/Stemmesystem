import {
  OpenpollResult,
  Poll,
  PollOption,
  VoteInput,
} from "../client_src/WebLib.ts";
import { VoteInsert, WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { createHash } from "node:crypto";

/**
 * Orchestrates poll-related logic between the HTTP layer and the database. Route handlers
 * should parse input and translate results; all decision about *whether* an action is allowed live here.
 *
 * @remarks
 * Responsibilities:
 * - Enforcing poll-state preconditions (poll exists, is open for voting).
 * - Enforcing user-level constraints (eligibility, vote quota, batch limits).
 * - Building tamper-evident audit records by chaining vote hashes
 *   	(see {@link PollManager.createVoteHash})
 * Layering:
 * - `server.ts` route handlers -> parse HTTP input, return HTTP responses
 * - `PollManager`-> logic rules, and orchestration.
 * - `WebappDatabase`-> raw persistence; no logic.
 *
 * New poll-related logic should be added here, not in the route handler.
 * Route handlers should remain thin enough to read in one screen.
 */
export class PollManager {
  private DB: WebappDatabase;

  constructor(db: WebappDatabase) {
    this.DB = db;
  }

  /**
   * Computes a SHA-256 hash that chains this vote to the previous one in the votes table.
   * If the hash is for the first vote casted, the previousHash is 0.
   * The purpose is to produce a tamper-evident record.
   *
   * @remarks
   * Each vote's hash is computed over the *previous* vote's hash plus this
   * vote's identifying fields. Modifying any earlier vote breaks the chain
   * for every subsequent vote, so the integrity of the entire vote can be
   * verified by recomputing the chain from a known starting point.
   *
   * Pipe-separated key:value format is used to avoid ambiguity if any field
   * happens to contain the delimiter - keep this format stable: changing it
   * would invalidate all previously stored hashes.
   */
  private createVoteHash(
    previoushHash: string,
    UUID: string,
    optionId: number,
    pollId: number,
  ): string {
    const hashMsg =
      `PreviousHash:${previoushHash}|UUID:${UUID}|pollOptionId:${optionId}|pollId:${pollId}`;
    return createHash("sha256").update(hashMsg, "utf8").digest("hex");
  }

  /**
   * Validates and atomically persits a batch of votes for a single user,
   * extending the poll's tamper-evident hash-chain.
   *
   * @remarks
   * Called from `POST /api/poll/:/pollId/vote`. The route handler is
   * responsible for shape-validating the request (votes is a non-empty array of `{optionId, UUID}`)
   * This method enforces all the logic rules:
   * - Poll exists and has `voteStatus === "started"
   * - User is on the eligible-voters list and has remaining vote(s) to cast.
   * - Every UUID is unique within the batch, and every `optionId`belongs to this poll.
   *
   * Each vote in the batch is hashed over the previous vote's hash
   * (see {@link PollManager.createVoteHash}), and the entire batch is
   * inserted in a single DB transaction - partial acceptance is not allowed,
   * so any failure rolls back all votes in the batch.
   *
   * Security: `userId` MUST come from a verified JWT payload, never from the request
   * body, otherwise a client could vote on behalf of another user.
   *
   * @param pollId- the poll being voted on.
   * @param userId - the voting user (must originate from a verified JWT).
   * @ param votes - The votes to cast. Each vote's UUID must be uniqie across the entire DB;
   * 			the underlying `VoteToken.uuid`UNIQUE constraint guarantees no replay or collision.
   *
   * @returns `{success:true}`on full insert; `{success:false, errorMsg}`if any logic rule fails or the DB rejects the batch.
   */
  public async castVote(
    pollId: number,
    userId: number,
    votes: VoteInput[],
  ): Promise<{ success: boolean; errorMsg?: string }> {
    if (votes.length === 0) {
      return { success: false, errorMsg: "No valid input" };
    }

    const pollResult = await this.DB.getPollFromDB(pollId);
    if (pollResult.httpStatusCode !== 200 || !pollResult.poll) {
      return { success: false, errorMsg: "Poll not found." };
    }
    if (pollResult.poll?.voteStatus !== "started") {
      return { success: false, errorMsg: "Voting is not open for this poll." };
    }

    const eligible = await this.DB.isUserEligible(pollId, userId);
    if (eligible === false) {
      return { success: false, errorMsg: "User not eliglbe" };
    }
    const votesAllowed = await this.DB.getVotesAllowed(pollId, userId);
    const alreadyCast = await this.DB.countCastVotes(pollId, userId);
    if (votes.length + alreadyCast > votesAllowed) {
      return { success: false, errorMsg: "Too many votes casted already" };
    }

    const isUUIDSeenBefore = new Set<string>();
    const validOptionIds = new Set(
      (await this.DB.getPollOptionsFromDB(pollId)).map((o) => o.id),
    );
    for (const v of votes) {
      if (typeof v.UUID !== "string" || v.UUID.length === 0) {
        return { success: false, errorMsg: "Invalid UUID in votes." };
      }
      if (isUUIDSeenBefore.has(v.UUID)) {
        return { success: false, errorMsg: "Duplicate UUID in batch" };
      }
      if (!validOptionIds.has(v.optionId)) {
        return {
          success: false,
          errorMsg: `Option ${v.optionId} does not belong to poll ${pollId}.`,
        };
      }
      isUUIDSeenBefore.add(v.UUID);
    }

    const latesthashFromDB = await this.DB.getLatestHash(pollId);
    if (latesthashFromDB.httpStatusCode !== 200) {
      return { success: false, errorMsg: "Could not retrieve latest hash" };
    }
    let previousHash = latesthashFromDB.hash ?? "0";

    const votesToInsert: VoteInsert[] = [];
    for (const vote of votes) {
      const currentHash = this.createVoteHash(
        previousHash,
        vote.UUID,
        vote.optionId,
        pollId,
      );
      votesToInsert.push({
        optionId: vote.optionId,
        UUID: vote.UUID,
        previousHash,
        currentHash,
      });
      previousHash = currentHash;
    }

    const insertResult = await this.DB.insertVoteBatch(
      pollId,
      userId,
      votesToInsert,
    );

    if (!insertResult.success) {
      return {
        success: false,
        errorMsg: insertResult.errorMsg ?? "Error while inserting votes",
      };
    }

    this.DB.insertAuditLog(
      "VOTES_CAST",
      `pollId:${pollId}, userId:${userId}, voteCount:${votes.length}`,
    );

    return { success: true };
  }
  /**
   * Returns the data needed to render the ballot page for a specific user and poll.
   * No vote records are created or modified.
   *
   * @remarks
   * Called from `POST /api/poll/:pollId/open` (despite being read-only - the verb "open" is conceptual).
   * The route hbandler is responsible for shape-validating `:pollId`; this method enforces all logic
   * preconditions:
   * - User is on the eligible-voters list for this poll
   * - Poll exists and has `voteStatus === "started"`.
   * - Poll has at least one option configured.
   * - User has a non-zero vote quota and a non-negative number of remaining votes (
   *   the latter is a definsive invariant - it should only ever be triggered if DB state
   *   is corrupt).
   *
   *   On success, a `POLL_OPENED` audit-log entry is written together with
   *   the user's vote-quota state. Failed attempts produce application-log
   *   warnings only - they are NOT recorded in the audit log.
   *
   *   Security: `userId` MUSTY come from a verified JWT payload, never from
   *   the URL or request body - otherwise a client could enumerate other
   *   user' remaining-votes counts.
   *
   *   @param pollId - The poll the user wants to view a ballot for.
   *   @param userId - the viewing user (must originate from a verified JWT).
   *
   *   @returns `{result}`with poll metadata, options, total quota, and
   *   		remaining votes - consumed by `<Ballotpage />` to render
   *   		the ballot. `{errorMsg}`if any precondition fails; the route handler
   *   		maps this to HTTP 403.
   */
  public async openPoll(
    pollId: number,
    userId: number,
  ): Promise<{ result?: OpenpollResult; errorMsg?: string }> {
    const isUserEligible = await this.DB.isUserEligible(pollId, userId);
    if (!isUserEligible) {
      logger.warn(`User ${userId} is not eligible for poll ${pollId}.`);
      return { errorMsg: "User is not eligible for poll" };
    }

    const { poll, httpStatusCode: pollStatuscode } = await this.DB
      .getPollFromDB(pollId);
    if (pollStatuscode !== 200) {
      logger.error(
        `Failed to retrieve poll with ID ${pollId} from database. Status code: ${pollStatuscode}`,
      );
      return { errorMsg: "Could not retrieve pollData" };
    }

    if (!poll || poll.voteStatus !== "started") {
      logger.warn(
        `Attempted to open poll with ID ${pollId}, but it is closed.`,
      );
      return { errorMsg: "Poll is closed" };
    }

    const options = await this.DB.getPollOptionsFromDB(pollId);
    if (options.length === 0) {
      logger.warn(`No options found for poll with ID ${pollId}.`);
      return { errorMsg: "No options found" };
    }

    const votesAllowed = await this.DB.getVotesAllowed(pollId, userId);
    if (votesAllowed <= 0) {
      logger.warn(`votesAllowed is 0`);
      return { errorMsg: "VotesAllowed is 0" };
    }

    const alreadyCast = await this.DB.countCastVotes(pollId, userId);
    const votesRemaining = votesAllowed - alreadyCast;

    if (votesRemaining < 0) {
      logger.warn`Negative votesRemaining for poll ${pollId}, user ${userId}`;
      return { errorMsg: "Votes remaining is negative" };
    }

    this.DB.insertAuditLog(
      "POLL_OPENED",
      `pollId:${pollId}, userId:${userId}, votesAllowed:${votesAllowed},votesRemaining:${votesRemaining}`,
    );

    return {
      result: {
        poll,
        options,
        votesAllowed,
        votesRemaining,
      },
    };
  }
}
