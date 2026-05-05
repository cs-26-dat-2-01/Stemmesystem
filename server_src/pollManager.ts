import {
  OpenpollResult,
  Poll,
  PollOption,
  VoteInput,
} from "../client_src/WebLib.ts";
import { VoteInsert, WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { createHash } from "node:crypto";

export class PollManager {
  private DB: WebappDatabase;

  constructor(db: WebappDatabase) {
    this.DB = db;
  }

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

  public async castVote(
    pollId: number,
    userId: number,
    votes: VoteInput[],
  ): Promise<{ success: boolean; errorMsg?: string }> {
    // 1. Validate input
    if (votes.length === 0) {
      return { success: false, errorMsg: "No valid input" };
    }
    const pollResult = await this.DB.getPollFromDB(pollId);
    // 2. check if poll is open for voting
    if (pollResult.httpStatusCode !== 200 || !pollResult.poll) {
      return { success: false, errorMsg: "Poll not found." };
    }
    if (pollResult.poll?.status !== "started") {
      return { success: false, errorMsg: "Voting is not open for this poll." };
    }

    // 3. check if user i eligble to vote
    const eligible = await this.DB.isUserEligible(pollId, userId);
    if (eligible === false) {
      return { success: false, errorMsg: "User not eliglbe" };
    }
    // 4. Check quota
    const votesAllowed = await this.DB.getVotesAllowed(pollId, userId);
    const alreadyCast = await this.DB.countCastVotes(pollId, userId);
    if (votes.length + alreadyCast > votesAllowed) {
      return { success: false, errorMsg: "Too many votes casted already" };
    }
    // 5. validate UUID inside of batch  and validate options ids
    // we use Set since is lets us store unique values so its a quick way to see if UUID send from client is the same
    const seen = new Set<string>();
    const validOptionIds = new Set(
      (await this.DB.getPollOptionsFromDB(pollId)).map((o) => o.id),
    );
    for (const v of votes) {
      if (typeof v.UUID !== "string" || v.UUID.length === 0) {
        return { success: false, errorMsg: "Invalid UUID in votes." };
      }
      if (seen.has(v.UUID)) {
        return { success: false, errorMsg: "Duplicate UUID in batch" };
      }
      if (!validOptionIds.has(v.optionId)) {
        return {
          success: false,
          errorMsg: `Option ${v.optionId} does not belong to poll ${pollId}.`,
        };
      }
      seen.add(v.UUID);
    }
    // 6. Create hash for votes
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

    // 7. insert the votes to DB
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

    // 8. submit to audit log
    this.DB.insertAuditLog(
      "VOTES_CAST",
      `pollId:${pollId}, userId:${userId}, voteCount:${votes.length}`,
    );

    return { success: true };
  }

  public async openPoll(
    pollId: number,
    userId: number,
  ): Promise<{ result?: OpenpollResult; errorMsg?: string }> {
    const isUserEligible = await this.DB.isUserEligible(pollId, userId);
    // 1. Check if user is eligible for opening the vote.
    if (!isUserEligible) {
      logger.warn(`User ${userId} is not eligible for poll ${pollId}.`);
      return { errorMsg: "User is not eligible for poll" };
    }
    // 2. Get poll data.
    const { poll, httpStatusCode: pollStatuscode } = await this.DB
      .getPollFromDB(pollId);
    if (pollStatuscode !== 200) {
      logger.error(
        `Failed to retrieve poll with ID ${pollId} from database. Status code: ${pollStatuscode}`,
      );
      return { errorMsg: "Could not retrieve pollData" };
    }

    // 3. Check if poll is close.
    if (!poll || poll.status !== "started") {
      logger.warn(
        `Attempted to open poll with ID ${pollId}, but it is closed.`,
      );
      return { errorMsg: "Poll is closed" };
    }

    // 4. get poll options.
    const options = await this.DB.getPollOptionsFromDB(pollId);
    if (options.length === 0) {
      logger.warn(`No options found for poll with ID ${pollId}.`);
      return { errorMsg: "No options found" };
    }
    // 5 . Get allowed votes.
    const votesAllowed = await this.DB.getVotesAllowed(pollId, userId);
    if (votesAllowed <= 0) {
      logger.warn(`votesAllowed is 0`);
      return { errorMsg: "VotesAllowed is 0" };
    }

    // 6. Calculate votes remaining.
    const alreadyCast = await this.DB.countCastVotes(pollId, userId);
    const votesRemaining = votesAllowed - alreadyCast;

    if (votesRemaining < 0) {
      logger.warn`Negative votesRemaining for poll ${pollId}, user ${userId}`;
      return { errorMsg: "Votes remaining is negative" };
    }

    // 7. Audit log.
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
