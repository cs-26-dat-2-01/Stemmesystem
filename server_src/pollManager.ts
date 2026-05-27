import {
  OpenpollResult,
  Poll,
  PollOption,
  ResultsPayload,
} from "../client_src/WebLib.ts";
import { WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { keygen } from "./blindRsa.ts";
import { SecretPollManager } from "./secretPollManager.ts";
import { verifyTimestampCommitment } from "./timestamping.ts";
import { VoteBuffer } from "./voteBuffer.ts";
import { OpenPollManager } from "./openPollManager.ts";

type CastInput =
  | {
    ballotPrivacy: "secret";
    uuid: string;
    signature: string;
    optionId: number;
  }
  | {
    ballotPrivacy: "open";
    userId: number;
    votes: { uuid: string; optionId: number }[];
  };

/**
 * Validates that a poll has all the fields and invariants required to
 * leave draft state and be published. Used as the gate in
 * `publishPoll` before any database writes happen.
 *
 * @param poll the poll fields to publish.
 * @param optionTexts the final list of option texts for the poll.
 * @param voters the final eligible voter roll, with each voter's
 *   `votesAllowed`.
 * @returns `null` when the input is valid; otherwise a human-readable
 *   error message describing the first violation found. Returning
 *   `null` for the success case means the caller can write
 *   `const err = validateForPublish(...); if (err) return err;` and
 *   forward the message straight to the client without an extra
 *   wrapper object or thrown exception.
 */
function validateForPublish(
  poll: Partial<Poll>,
  optionTexts: string[],
  voters: Array<{ username: string; votesAllowed: number }>,
): string | null {
  if (!poll.title || poll.title.trim().length === 0) return "Title is required";
  if (optionTexts.length === 0) return "At least one option is required";
  if (poll.pollVisibility !== "public" && poll.pollVisibility !== "private") {
    return "Invalid pollVisibility";
  }
  if (poll.ballotPrivacy !== "open" && poll.ballotPrivacy !== "secret") {
    return "Invalid ballotPrivacy";
  }
  if (!poll.startsAt) return "startsAt is required";
  if (!poll.endsAt) return "endsAt is required";
  const startDateTime = new Date(poll.startsAt);
  const endDateTime = new Date(poll.endsAt);
  if (Number.isNaN(startDateTime.getTime())) {
    return "startsAt is not a valid date";
  }
  if (Number.isNaN(endDateTime.getTime())) return "endsAt is not a valid date";

  const TOLERANCE_MS = 60_000;
  if (startDateTime.getTime() < Date.now() - TOLERANCE_MS) {
    return "startsAt must not be in the past";
  }
  if (endDateTime <= startDateTime) {
    return "endsAt must be after startsAt";
  }
  if (
    poll.ballotLimit === undefined ||
    !Number.isInteger(poll.ballotLimit) ||
    poll.ballotLimit === null ||
    poll.ballotLimit < 1
  ) {
    return "ballotLimit must be a positive integer";
  }
  const overLimit = voters.filter((v) => v.votesAllowed > poll.ballotLimit!);
  if (overLimit.length > 0) {
    return `Voters exceed ballotLimit (${poll.ballotLimit}): ${
      overLimit.map((v) => v.username).join(", ")
    }`;
  }
  const invalidVotes = voters.filter(
    (v) => !Number.isInteger(v.votesAllowed) || v.votesAllowed < 1,
  );
  if (invalidVotes.length > 0) {
    return `Voters have invalid votesAllowed: ${
      invalidVotes.map((v) => v.username).join(", ")
    }`;
  }
  return null;
}

/**
 * Orchestrates poll-related logic between the HTTP layer and the database. Route handlers
 * should parse input and translate results; all decision about *whether* an action is allowed live here.
 *
 * @remarks
 * Responsibilities:
 * - Enforcing poll-state preconditions (poll exists, is open for voting).
 * - Enforcing user-level constraints (eligibility, vote quota, batch limits).
 * - Building tamper-evident audit records by chaining vote hashes
 *   	(see `createVoteHash` in `voteIntegrity.ts`)
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
  private secret: SecretPollManager;
  private voteBuffer: VoteBuffer;
  private open: OpenPollManager;

  constructor(db: WebappDatabase) {
    this.DB = db;
    this.secret = new SecretPollManager(db);
    this.voteBuffer = new VoteBuffer(db);
    this.open = new OpenPollManager(db);
  }

  /**
   * Public facade for the anonymous (secret) cast. Advances poll statuses,
   * then delegates to {@link SecretPollManager.castVote}, which is where the
   * blind-signature verification and privacy invariants live. Kept on
   * `PollManager` so `server.ts` has a single entry point.
   */

  public async castVote(
    pollId: number,
    input: CastInput,
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    await this.tickPollStatuses();
    if (input.ballotPrivacy === "secret") {
      return this.secret.castVote(
        pollId,
        input.uuid,
        input.signature,
        input.optionId,
      );
    }
    return this.open.castVoteOpen(pollId, input.userId, input.votes);
  }

  /**
   * Public facade for blind-signature issuance. Advances poll statuses, then
   * delegates to {@link SecretPollManager.issueBlindSignature}.
   */
  public async issueBlindSignature(
    pollId: number,
    userId: number,
    blindedMessageB64: string,
  ): Promise<{
    blindSignatureB64?: string;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    await this.tickPollStatuses();
    return this.secret.issueBlindSignature(pollId, userId, blindedMessageB64);
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
    await this.tickPollStatuses();
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

    if (!poll || poll.status !== "started") {
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

    // "Already cast" is now derived from signaturesIssued — after the
    // blind-RSA redesign, the server cannot observe which Vote rows belong
    // to which user, so we count issuance instead. With Late Issuance on
    // the client, the two are equivalent.
    const alreadyCast = await this.DB.countSignaturesIssued(pollId, userId);
    const votesRemaining = votesAllowed - alreadyCast;

    if (votesRemaining < 0) {
      logger.warn`Negative votesRemaining for poll ${pollId}, user ${userId}`;
      return { errorMsg: "Votes remaining is negative" };
    }

    const blindRsaPublicKey = await this.DB.getPollPublicKey(pollId);
    if (!blindRsaPublicKey) {
      logger.error`Poll ${pollId} has no blindRsaPublicKey`;
      return { errorMsg: "Poll has no signing key" };
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
        userId,
        blindRsaPublicKey,
      },
    };
  }

  /**
   * Builds the result payload for a finished poll, combining aggregated vote counts with the per-vote UUID list.
   *
   * @remarks
   * Called from `GET /api/poll/:pollId/results`. The route handler is responsible for shape-validating `:pollId`;
   * this method enforces all logic preconditions:
   * - Poll exists.
   * - Poll has `voteStatus === "finished"` — results are not exposed before voting closes.
   *
   * Privacy enforcement:
   * - For `ballotPrivacy === "secret"`, only the UUID of each vote is returned. The vote's `pollOptionId`
   *   is intentionally dropped at this layer so that the option a UUID was cast for never leaves the server.
   * - For `ballotPrivacy === "open"`, each vote is returned with both its UUID and the option it was cast for
   *   (joined to `optionText` so the client does not need a second lookup).
   *
   * Aggregated counts are returned for all options of the poll, including options with zero votes.
   * The DB-level `getPollResultCounts` only returns options that received at least one vote, so this
   * method joins the result against `getPollOptionsFromDB` and defaults missing entries to 0.
   *
   * @param pollId - The poll whose results should be fetched.
   *
   * @returns `{result}` with aggregated counts and the per-vote UUID list shaped according to `ballotPrivacy`.
   *   `{errorMsg, httpStatusCode}` if any precondition fails — the route handler maps the status code
   *   to the HTTP response (400 if the poll does not exist, 403 if the poll is not finished, 500 on DB error).
   */
  public async getResults(
    pollId: number,
  ): Promise<{
    result?: ResultsPayload;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    await this.tickPollStatuses();
    const pollResult = await this.DB.getPollFromDB(pollId);
    if (!pollResult.poll) {
      return {
        errorMsg: pollResult.errorMsg ?? "Poll not found",
        httpStatusCode: pollResult.httpStatusCode,
      };
    }
    const poll = pollResult.poll;

    if (poll.status !== "finished") {
      return {
        errorMsg:
          "Poll is not finished - results are not public until voting closes",
        httpStatusCode: 403,
      };
    }

    const [
      options,
      votesResult,
      counts,
      blindRsaPublicKey,
      closeArtifacts,
      eligibleStatuses,
    ] = await Promise.all(
      [
        this.DB.getPollOptionsFromDB(pollId),
        this.DB.listVotesForPoll(pollId),
        this.DB.getPollResultCounts(pollId),
        this.DB.getPollPublicKey(pollId),
        this.DB.getPollCloseArtifacts(pollId),
        this.DB.getEligibleVoterStatuses(pollId),
      ],
    );

    if (votesResult.errorMsg) {
      return {
        errorMsg: votesResult.errorMsg,
        httpStatusCode: votesResult.httpStatusCode,
      };
    }
    if (!blindRsaPublicKey) {
      return {
        errorMsg: "Poll has no signing key",
        httpStatusCode: 500,
      };
    }
    if (closeArtifacts.httpStatusCode !== 200) {
      return {
        errorMsg: closeArtifacts.errorMsg ?? "Could not fetch close artifacts",
        httpStatusCode: closeArtifacts.httpStatusCode,
      };
    }

    const optionTextById = new Map(options.map((o) => [o.id, o.optionText]));
    const countByOptionId = new Map(counts.map((c) => [c.optionId, c.count]));
    const useTopN = !!poll.showTopN && poll.showTopN > 0;

    const fullCounts = options.map((o) => ({
      optionId: o.id,
      optionText: o.optionText ?? "",
      count: countByOptionId.get(o.id) ?? 0,
    }));

    let countsWithText: {
      optionId: number;
      optionText: string;
      count: number | null;
    }[];

    if (useTopN) {
      // we need to check to see if there is tie between the topN and topN+1, if there are we want to include them.
      const sorted = [...fullCounts].sort((a, b) => b.count - a.count);

      // We will use standard competition ranking (this will also show us if there are ties!.
      let currentRank = 0;
      let lastCount = Infinity;
      const ranked = sorted.map((c, i) => {
        if (c.count !== lastCount) {
          currentRank = i + 1;
          lastCount = c.count;
        }
        return { ...c, rank: currentRank };
      });

      // We will inklude all that are tied with showTopN place
      const threshold = ranked[poll.showTopN! - 1]?.count ?? 0;
      const inTop = ranked.filter((r) => r.count >= threshold);

      countsWithText = inTop.map((c) => ({
        optionId: c.optionId,
        optionText: c.optionText,
        count: null,
        rank: c.rank,
      }));
    } else { // full-results gets everything (not rank!), sorted most votes first
      countsWithText = [...fullCounts].sort((a, b) => b.count - a.count);
    }

    const eligibleCount = eligibleStatuses.length;
    const totalVotesAllowed = await this.DB.countTotalVotesAllowed(pollId);

    if (poll.ballotPrivacy === "secret") {
      // Anonymous: the only signal for "hasn't voted" is that the voter never
      // requested a ballot (signaturesIssued === 0). A voter who was issued a
      // ballot but never cast it is indistinguishable, by design.
      const nonVoterCount = eligibleStatuses.filter((s) =>
        s.signaturesIssued === 0
      ).length;
      return {
        result: {
          ballotPrivacy: "secret",
          showTopN: poll.showTopN ?? 0,
          closeCommitment: closeArtifacts.closeCommitment,
          closedAt: closeArtifacts.closedAt,
          hasCloseTimestampQuery: closeArtifacts.closeTimestampQuery !== null,
          hasCloseTimestampToken: closeArtifacts.closeTimestampToken !== null,
          closeTsaName: closeArtifacts.closeTsaName,
          counts: countsWithText,
          nonVoterCount,
          eligibleCount,
          totalVotesAllowed,
          // previousHash + currentHash enable hash-chain verification.
          // signature lets anyone verify (under the public key) that each
          // vote was authorized — universal verifiability without
          // de-anonymizing voters.
          votes: votesResult.votes.map((v) => ({
            uuid: v.id,
            previousHash: v.previousHash,
            currentHash: v.currentHash,
            signature: v.signature,
          })),
          blindRsaPublicKey,
        },
        httpStatusCode: 200,
      };
    }

    const voterIds = votesResult.votes
      .map((v) => v.userId)
      .filter((id): id is number => id !== null);
    const votedUserIds = new Set(voterIds);

    // One lookup for both voters (results table) and the eligible voters who
    // did NOT vote (the "har ikke stemt" list).
    const usernamesById = await this.DB.getUsernamesByIds([
      ...new Set([...voterIds, ...eligibleStatuses.map((s) => s.userId)]),
    ]);

    // Open polls carry userId, so non-voters are exact: eligible minus voted.
    const nonVoters = eligibleStatuses
      .filter((s) => !votedUserIds.has(s.userId))
      .map((s) => ({
        userId: s.userId,
        username: usernamesById.get(s.userId) ?? "(unknown)",
      }));

    return {
      result: {
        ballotPrivacy: "open",
        showTopN: poll.showTopN ?? 0,
        closeCommitment: closeArtifacts.closeCommitment,
        closedAt: closeArtifacts.closedAt,
        hasCloseTimestampQuery: closeArtifacts.closeTimestampQuery !== null,
        hasCloseTimestampToken: closeArtifacts.closeTimestampToken !== null,
        closeTsaName: closeArtifacts.closeTsaName,
        counts: countsWithText,
        nonVoters,
        eligibleCount,
        totalVotesAllowed,
        votes: votesResult.votes.map((v) => ({
          uuid: v.id,
          userId: v.userId,
          username: v.userId !== null
            ? (usernamesById.get(v.userId) ?? "(unknown)")
            : "(unknown)",
          optionId: v.pollOptionId,
          optionText: optionTextById.get(v.pollOptionId) ?? "(unknown)",
          previousHash: v.previousHash,
          currentHash: v.currentHash,
          signature: v.signature,
        })),
        blindRsaPublicKey,
      },
      httpStatusCode: 200,
    };
  }

  public async verifyResultsTimestamp(
    pollId: number,
  ): Promise<{
    verified?: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    await this.tickPollStatuses();

    const pollResult = await this.DB.getPollFromDB(pollId);
    if (!pollResult.poll) {
      return {
        errorMsg: pollResult.errorMsg ?? "Poll not found",
        httpStatusCode: pollResult.httpStatusCode,
      };
    }
    if (pollResult.poll.status !== "finished") {
      return {
        errorMsg: "Poll is not finished",
        httpStatusCode: 403,
      };
    }

    const closeArtifacts = await this.DB.getPollCloseArtifacts(pollId);
    if (closeArtifacts.httpStatusCode !== 200) {
      return {
        errorMsg: closeArtifacts.errorMsg ?? "Could not fetch close artifacts",
        httpStatusCode: closeArtifacts.httpStatusCode,
      };
    }
    if (
      !closeArtifacts.closeCommitment || !closeArtifacts.closeTimestampToken
    ) {
      return {
        errorMsg: "Poll has no timestamp data",
        httpStatusCode: 404,
      };
    }

    const verified = await verifyTimestampCommitment(
      closeArtifacts.closeCommitment,
      closeArtifacts.closeTimestampToken,
      closeArtifacts.closeTsaName,
    );
    return { verified, httpStatusCode: 200 };
  }

  /**
   * Creates a new poll in `draft` state, owned by the given user. Only
   * the poll's own fields are set here — options and eligible voters
   * are added later via `updatePoll` / `publishPoll`.
   *
   * No validation of the poll's fields is performed at this stage; a
   * draft is allowed to be incomplete. The full publish-time invariants
   * (title required, voters within `ballotLimit`, etc.) are enforced
   * by `validateForPublish` when the poll is later promoted out of
   * draft.
   *
   * @param createdByUserId the id of the authenticated user who will
   *   own the poll. Must come from a verified JWT, never from the
   *   request body.
   * @param input the poll fields to seed the draft with.
   * @returns `{ pollId, httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` propagated from the database layer
   *   on failure. Note the status is normalized from the DB layer's
   *   `201` down to `200` for the API surface.
   */
  public async createPoll(
    createdByUserId: number,
    input: {
      poll: Partial<Poll>;
    },
  ): Promise<{
    pollId?: number;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    const keypair = await keygen();

    const result = await this.DB.createPoll({
      title: input.poll.title,
      description: input.poll.description,
      voteStatus: "draft",
      createdBy: createdByUserId,
      startsAt: input.poll.startsAt,
      endsAt: input.poll.endsAt,
      pollVisibility: input.poll.pollVisibility,
      ballotPrivacy: input.poll.ballotPrivacy,
      showTopN: input.poll.showTopN,
      ballotLimit: input.poll.ballotLimit,
      useBuffer: input.poll.useBuffer,
      blindRsaPublicKey: keypair.publicKeyPem,
      blindRsaPrivateKey: keypair.privateKeyPem,
    });

    if (result.httpStatusCode !== 201) {
      return {
        errorMsg: result.errorMsg ?? "Error creating poll",
        httpStatusCode: result.httpStatusCode,
      };
    }

    // Audit-log only references the pollId — never the private key material.
    this.DB.insertAuditLog(
      "BLIND_RSA_KEY_GENERATED",
      `pollId:${result.pollId}, bits:2048`,
    );

    return { pollId: result.pollId, httpStatusCode: 200 };
  }

  /**
   * Applies a partial update to an existing draft, optionally replacing
   * its options and/or eligible voters. Used as the autosave path while
   * the user is editing — every step in the create-flow patches the
   * draft via this method, and `publishPoll` later promotes it out of
   * draft.
   *
   * Authorization is delegated to `loadEditablePoll`: the caller must
   * be the poll's creator and the poll must still be in `"draft"`.
   *
   * Pre-processing on `input.voters` (when provided): usernames are
   * trimmed, empty entries dropped, and duplicates collapsed (last
   * entry per username wins). The resulting names are resolved to user
   * ids; if any name does not match a `User` row, the request is
   * rejected with `400 Unknown voters: …` and no DB write happens.
   *
   * No publish-time validation is performed here — invariants like
   * "title is required" or "voters within ballotLimit" are only checked
   * when the draft is later published via `publishPoll`. A draft is
   * allowed to be incomplete.
   *
   * The actual write is a single transaction in `DB.updatePoll`: poll
   * fields, options, and voters all succeed or all roll back together.
   * Options and voters are full replacements when their corresponding
   * field is provided (`optionTexts` / `voters`); leaving a field
   * `undefined` keeps the existing rows untouched.
   *
   * @param userId the id of the authenticated caller (from a verified
   *   JWT).
   * @param pollId the id of the draft to update.
   * @param input the fields to change. `poll` carries partial poll
   *   fields; `voters` and `optionTexts` are optional and trigger full
   *   replacement of the corresponding rows when present.
   * @returns `{ httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure — `400` for unknown
   *   voters, or whatever status `loadEditablePoll` / `DB.updatePoll`
   *   propagate (`403` / `404` / `409` / `500`).
   */
  public async updatePoll(
    userId: number,
    pollId: number,
    input: {
      poll: Partial<Poll>;
      voters?: Array<{ username: string; votesAllowed: number }>;
      optionTexts?: string[];
    },
  ): Promise<{ errorMsg?: string; httpStatusCode: ContentfulStatusCode }> {
    const draft = await this.loadEditablePoll(userId, pollId);
    if (!draft.ok) {
      return { errorMsg: draft.errorMsg, httpStatusCode: draft.httpStatusCode };
    }

    let resolvedVoters:
      | Array<{ userId: number; votesAllowed: number }>
      | undefined;
    if (input.voters !== undefined) {
      const dedup = new Map<
        string,
        { username: string; votesAllowed: number }
      >();
      for (const v of input.voters) {
        const name = v.username.trim();
        if (name.length === 0) continue;
        dedup.set(name, { username: name, votesAllowed: v.votesAllowed });
      }
      const uniqueVoters = [...dedup.values()];
      const lookup = await this.DB.getUsersByUsernames(
        uniqueVoters.map((v) => v.username),
      );
      if (lookup.notFound.length > 0) {
        return {
          errorMsg: `Unknown voters: ${lookup.notFound.join(", ")}`,
          httpStatusCode: 400,
        };
      }
      const usernameToId = new Map(
        lookup.users.map((u) => [u.username, u.id]),
      );
      resolvedVoters = uniqueVoters.map((v) => ({
        userId: usernameToId.get(v.username)!,
        votesAllowed: v.votesAllowed,
      }));
    }

    const result = await this.DB.updatePoll(pollId, {
      title: input.poll.title,
      description: input.poll.description,
      startsAt: input.poll.startsAt,
      endsAt: input.poll.endsAt,
      pollVisibility: input.poll.pollVisibility,
      ballotPrivacy: input.poll.ballotPrivacy,
      showTopN: input.poll.showTopN,
      ballotLimit: input.poll.ballotLimit,
      useBuffer: input.poll.useBuffer,
      optionTexts: input.optionTexts,
      voters: resolvedVoters,
    });

    if (result.httpStatusCode !== 200) {
      return {
        errorMsg: result.errorMsg ?? "Error updating poll",
        httpStatusCode: result.httpStatusCode,
      };
    }
    return { httpStatusCode: 200 };
  }

  /**
   * Promotes a draft poll to a published state, applying the final
   * options and eligible voter roll in the same call. The poll
   * transitions to `"not started"` so the scheduled tick can move it to
   * `"started"` once `startsAt` elapses.
   *
   * Pipeline (each step short-circuits on failure):
   * 1. Load the draft and verify the caller is allowed to edit it via
   *    `loadEditablePoll`.
   * 2. Trim option texts and drop empty entries.
   * 3. Trim voter usernames, drop empty entries, and deduplicate by
   *    username (last entry per name wins).
   * 4. Resolve usernames to user ids; reject with `400` if any voter
   *    name is unknown.
   * 5. Run `validateForPublish` on the cleaned input; reject with `400`
   *    on the first invariant violation.
   * 6. Apply the update via `DB.updatePoll` in a single transaction
   *    (poll fields, options, and voters are replaced atomically).
   * 7. On success, write a `POLL_PUBLISHED` audit log entry.
   *
   * @param userId the id of the authenticated caller. Must come from a
   *   verified JWT, never from the request body. Used both for
   *   authorization (via `loadEditablePoll`) and for the audit log.
   * @param pollId the id of the draft poll to publish.
   * @param input the final state to publish: poll fields, eligible
   *   voters with per-voter `votesAllowed`, and option texts.
   * @returns `{ pollId, httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure — `400` for unknown
   *   voters or validation failures, or whatever status
   *   `loadEditablePoll` / `DB.updatePoll` propagate (e.g. `403`,
   *   `404`, `500`).
   *
   * @remarks
   * The audit-log write on step 7 is fire-and-forget — it is not
   * awaited and its failure does not affect the response. The poll is
   * already published at that point.
   */
  public async publishPoll(
    userId: number,
    pollId: number,
    input: {
      poll: Poll;
      voters: Array<{ username: string; votesAllowed: number }>;
      optionTexts: string[];
    },
  ): Promise<{
    pollId?: number;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    const draft = await this.loadEditablePoll(userId, pollId);
    if (!draft.ok) {
      return { errorMsg: draft.errorMsg, httpStatusCode: draft.httpStatusCode };
    }
    const wasAlreadyPublished = draft.poll.status === "not started";

    const optionTexts = input.optionTexts
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const dedup = new Map<
      string,
      { username: string; votesAllowed: number }
    >();
    for (const v of input.voters) {
      const name = v.username.trim();
      if (name.length === 0) continue;
      dedup.set(name, { username: name, votesAllowed: v.votesAllowed });
    }
    const uniqueVoters = [...dedup.values()];
    const lookup = await this.DB.getUsersByUsernames(
      uniqueVoters.map((v) => v.username),
    );
    if (lookup.notFound.length > 0) {
      return {
        errorMsg: `Unknown voters: ${lookup.notFound.join(", ")}`,
        httpStatusCode: 400,
      };
    }

    const validationError = validateForPublish(
      input.poll,
      optionTexts,
      uniqueVoters,
    );
    if (validationError !== null) {
      return { errorMsg: validationError, httpStatusCode: 400 };
    }

    const usernameToId = new Map(lookup.users.map((u) => [u.username, u.id]));
    const resolvedVoters = uniqueVoters.map((v) => ({
      userId: usernameToId.get(v.username)!,
      votesAllowed: v.votesAllowed,
    }));

    const result = await this.DB.updatePoll(pollId, {
      title: input.poll.title,
      description: input.poll.description,
      startsAt: input.poll.startsAt,
      endsAt: input.poll.endsAt,
      pollVisibility: input.poll.pollVisibility,
      ballotPrivacy: input.poll.ballotPrivacy,
      showTopN: input.poll.showTopN,
      ballotLimit: input.poll.ballotLimit,
      useBuffer: input.poll.useBuffer,
      voteStatus: "not started",
      optionTexts,
      voters: resolvedVoters,
    });

    if (result.httpStatusCode !== 200) {
      return {
        errorMsg: result.errorMsg ?? "Error publishing poll",
        httpStatusCode: result.httpStatusCode,
      };
    }

    this.DB.insertAuditLog(
      wasAlreadyPublished ? "POLL_EDITED" : "POLL_PUBLISHED",
      `pollId:${pollId}, createdBy:${userId}, options:${optionTexts.length}, voters:${resolvedVoters.length}`,
    );

    return { pollId, httpStatusCode: 200 };
  }

  /**
   * Loads a poll and verifies that the caller is allowed to edit it.
   * Used as the authorization gate for `updatePoll`, `publishPoll`, and
   * `getDraft` so the same rules apply across all edit-related paths
   * (delete uses its own slightly looser rule).
   *
   * Editing is permitted in two lifecycle phases:
   * - `"draft"` — the poll has never been published.
   * - `"not started"` — the poll has been published but its `startsAt`
   *   is still in the future. Once `startsAt` elapses, the scheduled
   *   tick flips it to `"started"` and edits are refused.
   *
   * Returns a discriminated union: `{ ok: true, poll }` when editing is
   * permitted; otherwise `{ ok: false, errorMsg, httpStatusCode }` with
   * the appropriate status — `404` if the poll does not exist, `500` on
   * a database error, `403` if the caller is not the poll's creator, or
   * `409` if the poll is past the editable phase.
   *
   * @param userId the id of the authenticated caller (from a verified
   *   JWT).
   * @param pollId the id of the poll to load.
   */
  private async loadEditablePoll(
    userId: number,
    pollId: number,
  ): Promise<
    | { ok: true; poll: Poll }
    | { ok: false; errorMsg: string; httpStatusCode: ContentfulStatusCode }
  > {
    const result = await this.DB.getPollFromDB(pollId);
    if (!result.poll) {
      if (result.httpStatusCode === 500) {
        return {
          ok: false,
          errorMsg: result.errorMsg ?? "Database error",
          httpStatusCode: 500,
        };
      }
      return { ok: false, errorMsg: "Poll not found", httpStatusCode: 404 };
    }
    if (result.poll.createdBy !== userId) {
      return { ok: false, errorMsg: "Forbidden", httpStatusCode: 403 };
    }
    if (result.poll.status === "draft") {
      return { ok: true, poll: result.poll };
    }
    if (result.poll.status === "not started") {
      const startsAt = result.poll.startsAt
        ? new Date(result.poll.startsAt).getTime()
        : 0;
      if (startsAt <= Date.now()) {
        return {
          ok: false,
          errorMsg: "Poll has already started and can no longer be edited",
          httpStatusCode: 409,
        };
      }
      return { ok: true, poll: result.poll };
    }
    return {
      ok: false,
      errorMsg: "Poll is past the editable phase",
      httpStatusCode: 409,
    };
  }

  /**
   * Deletes a poll, gated by ownership and lifecycle state. Used both
   * to discard drafts the creator no longer wants and to retract polls
   * that have been saved but not yet started — once a poll has moved
   * past those states (e.g. `"started"`, `"finished"`), deletion is
   * refused so vote history cannot be erased.
   *
   * Authorization checks, in order:
   * 1. Poll must exist (`404` otherwise; `500` on database error).
   * 2. Caller must be the poll's creator (`403` otherwise).
   * 3. Poll must be in `"draft"` or `"not started"` state (`403` otherwise).
   *
   * On success, writes a `POLL_DELETED` audit log entry. The audit-log
   * write is fire-and-forget and does not affect the response.
   *
   * @param userId the id of the authenticated caller (from a verified
   *   JWT). Used for both authorization and the audit log.
   * @param pollId the id of the poll to delete.
   * @returns `{ httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure (`403` / `404` / `500`
   *   per the rules above, or whatever `DB.deletePoll` propagates).
   */
  public async deletePoll(
    userId: number,
    pollId: number,
  ): Promise<{
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    const statusofVote = await this.DB.getPollFromDB(pollId);
    if (!statusofVote.poll) {
      if (statusofVote.httpStatusCode === 500) {
        return {
          errorMsg: statusofVote.errorMsg ?? "Database error",
          httpStatusCode: 500,
        };
      }
      return { errorMsg: "Poll not found", httpStatusCode: 404 };
    }

    if (statusofVote.poll.createdBy !== userId) {
      return { errorMsg: "Forbidden", httpStatusCode: 403 };
    }

    if (
      statusofVote.poll.status !== "draft" &&
      statusofVote.poll.status !== "not started"
    ) {
      return {
        errorMsg: "Only drafts and not-started polls can be deleted",
        httpStatusCode: 403,
      };
    }

    const result = await this.DB.deletePoll(pollId);

    if (result.httpStatusCode !== 200) {
      return {
        errorMsg: result.errorMsg ?? "Error while deleting poll",
        httpStatusCode: result.httpStatusCode,
      };
    }
    this.DB.insertAuditLog(
      "POLL_DELETED",
      `pollId:${pollId}, createdBy:${userId}}`,
    );
    return { httpStatusCode: 200 };
  }

  /**
   * Loads a poll's full editable state — poll fields, options, and the
   * eligible voter roll — for the create/edit UI. Restricted to the
   * poll's creator while it is still in `"draft"`; any other state returns
   * 409 (the poll has moverd past the editable phase..)
   *
   * @param userId the id of the authenticated caller (from a verified
   *   JWT).
   * @param pollId the id of the poll to load.
   * @returns `{ result, httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure (`403` / `404` / `500`).
   */
  public async getDraft(userId: number, pollId: number): Promise<{
    result?: {
      poll: Poll;
      options: PollOption[];
      voters: Array<{ username: string; votesAllowed: number }>;
    };
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    const draft = await this.loadEditablePoll(userId, pollId);
    if (!draft.ok) {
      return { errorMsg: draft.errorMsg, httpStatusCode: draft.httpStatusCode };
    }
    const options = await this.DB.getPollOptionsFromDB(pollId);
    const voters = await this.DB.getEligibleVoters(pollId);
    return {
      result: { poll: draft.poll, options, voters },
      httpStatusCode: 200,
    };
  }

  /**
   * Advances poll lifecycle states based on the current time, by
   * delegating to `DB.tickPollStatuses` (which moves polls from
   * `"not started"` → `"started"` and `"started"` → `"finished"` based
   * on `startsAt` / `endsAt`). Intended to be called on a internval and
   * whenever someone tries to cast vote, openPoll and getResults and get /api/polls.
   *
   * Writes one audit log entry per non-empty transition bucket:
   * `POLL_AUTO_STARTED` and/or `POLL_AUTO_FINISHED`, each carrying the
   * count of polls moved in that pass. Buckets with zero transitions
   * are skipped to keep the audit log free of empty heartbeats.
   */
  public async tickPollStatuses(): Promise<void> {
    const { started, finished } = await this.DB.tickPollStatuses();
    if (started > 0) {
      this.DB.insertAuditLog("POLL_AUTO_STARTED", `count:${started}`);
    }

    const pollsReadyToFinish = await this.DB.getPollIdsReadyToFinish();
    const finishResults = await Promise.all(
      pollsReadyToFinish.map(async (pollId) => {
        // Branch on the STORED ballotPrivacy: open polls seal in place (votes
        // are already live), secret polls drain buffer/pending and shuffle.
        const ballotPrivacy = await this.DB.getPollPrivacyLabel(pollId);
        return ballotPrivacy === "open"
          ? this.open.sealOpenPollClose(pollId)
          : this.secret.finishPollWithVoteDrain(pollId);
      }),
    );
    const finishedCount = finishResults.filter(Boolean).length + finished;
    if (finishedCount > 0) {
      this.DB.insertAuditLog("POLL_AUTO_FINISHED", `count:${finishedCount}`);
    }
  }

  /**
   * Loads a poll's overview view — poll fields, options, and the
   * eligible voter roll — for read-only display (the status / progress
   * page, as opposed to the editor served by `getDraft`). Available in
   * any lifecycle state, not just drafts.
   *
   * Visibility rules: the poll's creator always has access; otherwise
   * the caller must appear in the poll's eligible voter list. Anyone
   * else gets `403` — there is no public read path through this method.
   *
   * @param userId the id of the authenticated caller (from a verified
   *   JWT).
   * @param pollId the id of the poll to load.
   * @returns `{ result, httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure (`403` / `404` / `500`).
   */
  public async getPollOverview(userId: number, pollId: number): Promise<{
    result?: {
      poll: Poll;
      options: PollOption[];
      voters: Array<{ username: string; votesAllowed: number }>;
    };
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    const { poll, httpStatusCode } = await this.DB.getPollFromDB(pollId);
    if (!poll) {
      return {
        errorMsg: "Poll not found",
        httpStatusCode: httpStatusCode === 500 ? 500 : 404,
      };
    }
    const options = await this.DB.getPollOptionsFromDB(pollId);
    const voters = await this.DB.getEligibleVoters(pollId);
    return { result: { poll, options, voters }, httpStatusCode: 200 };
  }

  private async verifyPollIntegrityAtStartUp(pollId: number): Promise<boolean> {
    const privacy = await this.DB.getPollPrivacyLabel(pollId);
    if (privacy === "secret") {
      const issued = await this.DB.countIssuedSignatures(pollId);
      const persisted = await this.DB.countPersistedVotes(pollId);
      const buffered = this.voteBuffer.countBuffered(pollId);
      const total = persisted + buffered;

      // HARD: more votes than signatures is impossible without fraud or a bug.
      if (total > issued) {
        const reason =
          `more votes than signatures: issued:${issued}, persisted:${persisted}, buffered:${buffered}`;
        const invalidated = await this.DB.markPollInvalidated(pollId, reason);
        if (!invalidated.success) {
          logger
            .error`Failed to invalidate poll ${pollId}: ${invalidated.errorMsg}`;
        }
        return false;
      }

      // SOFT: signatures were issued but the corresponding votes were not
      // persisted. Could be legitimate user abandonment OR server-side vote loss
      // (e.g. crash before buffer flush). The server cannot distinguish these
      // cases from its own state, so we surface the gap via the audit log
      // and let an operator decide whether further investigation is needed.
      if (total < issued) {
        this.DB.insertAuditLog(
          "POLL_INTEGRITY_GAP",
          `pollId:${pollId}, issued:${issued}, persisted:${persisted}, buffered:${buffered}`,
        );
        logger
          .warn`Poll ${pollId} integrity gap: issued ${issued}, recorded ${total} (could be user abandonment or vote loss)`;
      }
    } else {
      const persisted = await this.DB.countPersistedVotes(pollId);
      const votesAllowed = await this.DB.countTotalVotesAllowed(pollId);
      if (persisted > votesAllowed) {
        const reason =
          `more votes than allowed: persisted:${persisted}, votesAllowed:${votesAllowed}`;
        const invalidated = await this.DB.markPollInvalidated(pollId, reason);
        if (!invalidated.success) {
          logger
            .error`Failed to invalidate poll ${pollId}: ${invalidated.errorMsg}`;
        }
        return false;
      }
    }
    return true;
  }

  public async runStartupIntegrityCheck(): Promise<void> {
    const startedPollIds = await this.DB.listStartedPollIds();

    for (const pollId of startedPollIds) {
      const integrityOk = await this.verifyPollIntegrityAtStartUp(pollId);
      if (!integrityOk) {
        logger.error`Startup integrity check failed for poll ${pollId}`;
      }
    }
  }
}
