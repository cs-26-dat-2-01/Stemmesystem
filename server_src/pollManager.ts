import {
  ballotPrivacy,
  OpenpollResult,
  Poll,
  PollOption,
  ResultsPayload,
  voteHashMessage,
} from "../client_src/WebLib.ts";
import { WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { createHash } from "node:crypto";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { blindSign, keygen, verify } from "./blindRsa.ts";
import { secureShuffle, VoteBuffer } from "./voteBuffer.ts";
import type { PendingVoteInsert, VoteInsert } from "./database.ts";
import {
  timestampCommitment,
  verifyTimestampCommitment,
} from "./timestamping.ts";
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
  private voteBuffer: VoteBuffer;

  constructor(db: WebappDatabase) {
    this.DB = db;
    this.voteBuffer = new VoteBuffer(db);
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
    previousHash: string,
    UUID: string,
    optionId: number,
    pollId: number,
    ballotPrivacy: ballotPrivacy | null,
    showTopN: number | null,
  ): string {
    const hashMsg = voteHashMessage({
      previousHash: previousHash,
      uuid: UUID,
      optionId: optionId,
      pollId: pollId,
      ballotPrivacy: ballotPrivacy,
      showTopN: showTopN,
    });
    return createHash("sha256").update(hashMsg, "utf8").digest("hex");
  }
  /**
   * Builds the close commitment: a single SHA-256 hash binding together the
   * final hash-chain tip, the per-option vote counts, the poll metadata, and
  the
   * close timestamp. This commitment is what gets sent to the TSA
   * timestamp so the closed poll can later be verified end-to-end.
   *
   * @param poll - The poll being closed (metadata fields are included in the
  commitment).
   * @param finalVotes - Votes in chain order; the last vote's `currentHash`
  seals the chain.
   * @param closedAt - Timestamp marking when the poll was closed.
   * @returns Hex-encoded SHA-256 close commitment.
   */
  private buildCloseCommitment(
    poll: Poll,
    finalVotes: VoteInsert[],
    closedAt: Date,
  ): string {
    const finalChainHash = finalVotes.at(-1)?.currentHash ?? "0";

    const countByOptionId = new Map<number, number>();
    for (const vote of finalVotes) {
      countByOptionId.set(
        vote.optionId,
        (countByOptionId.get(vote.optionId) ?? 0) + 1,
      );
    }

    const sortedCounts = JSON.stringify(
      [...countByOptionId.entries()]
        .sort(([a], [b]) => a - b)
        .map(([optionId, count]) => ({ optionId, count })),
    );

    const pollMetadata = JSON.stringify({
      pollId: poll.id,
      ballotPrivacy: poll.ballotPrivacy,
      pollVisibility: poll.pollVisibility,
      showTopN: poll.showTopN,
      ballotLimit: poll.ballotLimit,
      startsAt: poll.startsAt ?? null,
      endsAt: poll.endsAt ?? null,
    });

    const countsHash = this.sha256Hex(sortedCounts);
    const metadataHash = this.sha256Hex(pollMetadata);

    return this.sha256Hex(
      `${finalChainHash}${countsHash}${metadataHash}${closedAt.toISOString()}`,
    );
  }

  /** Computes a SHA-256 hash
   */
  private sha256Hex(message: string): string {
    return createHash("sha256").update(message, "utf8").digest("hex");
  }
  /**
   * Verifies that a poll is safe to close by comparing issued signatures
  against
   * persisted votes (final + pending) and ensuring the RAM buffer is fully
  drained.
   *
   * Three outcomes:
   * - Buffered votes remain: aborts the close (snapshot not trustworthy).
   * - persisted > issued: marks the poll as invalidated (more votes than
  signatures issued indicates a serious integrity breach) and aborts.
   * - persisted < issued: logs a `POLL_INTEGRITY_GAP_AT_CLOSE` audit entry and
  warns about lost votes, but still allows the close to proceed.
   *
   * @param pollId - ID of the poll being closed.
   * @returns True if the poll may proceed to close; false if the buffer is not
  drained
   *          or the poll was invalidated.
   */
  private async verifyPollCloseIntegrity(pollId: number): Promise<boolean> {
    const issuedVotes = await this.DB.countIssuedSignatures(pollId);
    const persistedVotes = await this.DB.countPersistedVotes(pollId);

    const bufferedVotes = this.voteBuffer.countBuffered(pollId);

    // After a poll has been moved to "closing", the RAM buffer should have been
    // drained into pendingVote. If not, the close snapshot is not trustworthy.
    if (bufferedVotes !== 0) {
      logger.error`Poll ${pollId} still has ${bufferedVotes} buffered vote(s)
  during integrity check`;
      return false;
    }

    if (persistedVotes > issuedVotes) {
      const reason =
        `expected:${issuedVotes}, persisted:${persistedVotes}, buffered:${bufferedVotes}`;

      const invalidated = await this.DB.markPollInvalidated(pollId, reason);
      if (!invalidated.success) {
        logger.error`Failed to invalidate poll ${pollId}:
  ${invalidated.errorMsg}`;
      }
      return false;
    }

    if (persistedVotes < issuedVotes) {
      this.DB.insertAuditLog(
        "POLL_INTEGRITY_GAP_AT_CLOSE",
        `Tried to close pollId: ${pollId}, issued:${issuedVotes}, persisted: ${persistedVotes}, buffered:${bufferedVotes}`,
      );
      logger.warn`${pollId} has an integrity gap, might have lost some votes!`;
    }

    return true;
  }

  /**
   * Casts an anonymous vote. Called from `POST /api/poll/:pollId/vote`.
   *
   * @remarks
   * No `userId` is taken or expected — the cast endpoint is unauthenticated
   * by design. Authorization comes from the blind signature: only a user
   * who completed the issuance phase under `/blindsign` can produce a
   * valid signature on the UUID. The server verifies the signature
   * against the poll's public key and inserts the vote.
   *
   * Each `(uuid, signature)` pair is single-use: the UNIQUE constraint on
   * `Vote.id` rejects replay at the DB layer with a `409`.
   *
   * Security/privacy invariants:
   * - Caller-side: no JWT, no cookie, no userId — the route handler MUST
   *   NOT pass any user identity into this method, even if it has one
   *   from a stray cookie.
   * - Audit-log records only `uuid` (the public UUID), never any user
   *   identifier or IP. A DB-admin reading the log can see "this UUID
   *   was cast" but nothing tying it to a person.
   *
   * @param pollId      the poll being voted on.
   * @param uuidB64     base64 of the prepared message (`= Vote.id`).
   * @param signatureB64 base64 of the finalized RSA-PSS signature on uuid.
   * @param optionId    the option being voted for. Must belong to this poll.
   * @returns `{success: true}` on insert;
   *   `{success: false, errorMsg, httpStatusCode}` on failure:
   *   `400` malformed input / invalid signature / bad option;
   *   `403` poll not open;
   *    '404' "poll not found";
   *   `409` UUID already cast (replay).
   *   '500'"Poll has no signing key"
   */
  public async castVote(
    pollId: number,
    uuidB64: string,
    signatureB64: string,
    optionId: number,
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    await this.tickPollStatuses();

    if (typeof uuidB64 !== "string" || uuidB64.length === 0) {
      return { success: false, errorMsg: "Invalid uuid", httpStatusCode: 400 };
    }
    if (typeof signatureB64 !== "string" || signatureB64.length === 0) {
      return {
        success: false,
        errorMsg: "Invalid signature",
        httpStatusCode: 400,
      };
    }
    if (!Number.isInteger(optionId)) {
      return {
        success: false,
        errorMsg: "Invalid optionId",
        httpStatusCode: 400,
      };
    }

    const pollResult = await this.DB.getPollFromDB(pollId);
    if (pollResult.httpStatusCode !== 200 || !pollResult.poll) {
      return {
        success: false,
        errorMsg: "Poll not found",
        httpStatusCode: 404,
      };
    }
    if (pollResult.poll.status !== "started") {
      return {
        success: false,
        errorMsg: "Voting is not open for this poll",
        httpStatusCode: 403,
      };
    }

    const publicKeyPem = await this.DB.getPollPublicKey(pollId);
    if (!publicKeyPem) {
      return {
        success: false,
        errorMsg: "Poll has no signing key",
        httpStatusCode: 500,
      };
    }

    // Decode the base64 uuid back to the prepared-message bytes that the
    // signature is verified against. Bad base64 → invalid signature.
    let uuidBytes: Uint8Array;
    try {
      const binary = atob(uuidB64);
      uuidBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        uuidBytes[i] = binary.charCodeAt(i);
      }
    } catch {
      return {
        success: false,
        errorMsg: "Invalid uuid encoding",
        httpStatusCode: 400,
      };
    }

    const sigOk = await verify(publicKeyPem, uuidBytes, signatureB64);
    if (!sigOk) {
      return {
        success: false,
        errorMsg: "Invalid signature",
        httpStatusCode: 400,
      };
    }

    const validOptionIds = new Set(
      (await this.DB.getPollOptionsFromDB(pollId)).map((o) => o.id),
    );
    if (!validOptionIds.has(optionId)) {
      return {
        success: false,
        errorMsg: `Option ${optionId} does not belong to poll ${pollId}`,
        httpStatusCode: 400,
      };
    }

    const insertResult = await this.voteBuffer.add(pollId, {
      optionId,
      uuid: uuidB64,
      signature: signatureB64,
    });

    if (!insertResult.success) {
      return {
        success: false,
        errorMsg: insertResult.errorMsg ?? "Error while inserting vote",
        httpStatusCode: insertResult.httpStatusCode,
      };
    }

    const bufferedVotes = this.voteBuffer.countBuffered(pollId);
    const pendingVotes = await this.DB.countReceivedVotes(pollId);
    const receivedTotal = bufferedVotes + pendingVotes;
    const totalAllowed = await this.DB.countTotalVotesAllowed(pollId);

    if (receivedTotal === totalAllowed) {
      this.finishPollWithVoteDrain(pollId);
    }

    return { success: true, httpStatusCode: 200 };
  }

  /**
   * Issues a blind signature on a client-supplied blinded message
   * (RFC 9474 §4.3). Called from `POST /api/poll/:pollId/blindsign`.
   *
   * @remarks
   * This is the only point where `userId` and any vote-related data
   * touch each other server-side — and even here the server sees only
   * the *blinded* message, not the underlying UUID. The audit-log entry
   * deliberately records only `(pollId, userId)` and never the blinded
   * bytes, so a DB-admin can see "user U claimed a signature for poll P"
   * but nothing tying U to any concrete vote.
   *
   * Quota check, counter increment, and the actual signing all happen
   * inside a single Prisma transaction (see `DB.issueBlindSignature`):
   * if the crypto step throws — e.g. the client uploaded malformed
   * bytes — the `signaturesIssued` counter is rolled back so the user
   * does not lose a quota slot to a malformed request.
   *
   * Security: `userId` MUST come from a verified JWT payload, never
   * from the request body. Status checks (`voteStatus === "started"`)
   * also happen inside the transaction to close the race between
   * "poll opens" and "user requests signature".
   *
   * @param pollId            the poll being voted on.
   * @param userId            the requesting user (must originate from JWT).
   * @param blindedMessageB64 base64 of the blinded message from the client.
   * @returns `{ blindSignatureB64, httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure.
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

    if (
      typeof blindedMessageB64 !== "string" || blindedMessageB64.length === 0
    ) {
      return {
        errorMsg: "Missing or invalid 'blinded' field",
        httpStatusCode: 400,
      };
    }

    const result = await this.DB.issueBlindSignature(
      pollId,
      userId,
      (privateKeyPem) => blindSign(privateKeyPem, blindedMessageB64),
    );

    if (result.errorMsg || !result.blindSignatureB64) {
      this.DB.insertAuditLog(
        "BLIND_SIG_ISSUEFAIL",
        `pollId:${pollId}`,
      );
      return result;
    }

    this.DB.insertAuditLog(
      "BLIND_SIG_ISSUED",
      `pollId:${pollId}`,
    );

    return {
      blindSignatureB64: result.blindSignatureB64,
      httpStatusCode: 200,
    };
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

    const [options, votesResult, counts, blindRsaPublicKey, closeArtifacts] =
      await Promise.all(
        [
          this.DB.getPollOptionsFromDB(pollId),
          this.DB.listVotesForPoll(pollId),
          this.DB.getPollResultCounts(pollId),
          this.DB.getPollPublicKey(pollId),
          this.DB.getPollCloseArtifacts(pollId),
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
    } else { // full-results gets  everything (not rank!)
      countsWithText = fullCounts;
    }

    if (poll.ballotPrivacy === "secret") {
      return {
        result: {
          ballotPrivacy: "secret",
          showTopN: poll.showTopN ?? 0,
          closeCommitment: closeArtifacts.closeCommitment,
          closedAt: closeArtifacts.closedAt,
          hasCloseTimestampQuery: closeArtifacts.closeTimestampQuery !== null,
          hasCloseTimestampToken: closeArtifacts.closeTimestampToken !== null,
          counts: countsWithText,
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

    return {
      result: {
        ballotPrivacy: "open",
        showTopN: poll.showTopN ?? 0,
        closeCommitment: closeArtifacts.closeCommitment,
        closedAt: closeArtifacts.closedAt,
        hasCloseTimestampQuery: closeArtifacts.closeTimestampQuery !== null,
        hasCloseTimestampToken: closeArtifacts.closeTimestampToken !== null,
        counts: countsWithText,
        votes: votesResult.votes.map((v) => ({
          uuid: v.id,
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
   * Authorization is delegated to `loadEditableDraft`: the caller must
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
   *   voters, or whatever status `loadEditableDraft` / `DB.updatePoll`
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
    const draft = await this.loadEditableDraft(userId, pollId);
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
   *    `loadEditableDraft`.
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
   *   authorization (via `loadEditableDraft`) and for the audit log.
   * @param pollId the id of the draft poll to publish.
   * @param input the final state to publish: poll fields, eligible
   *   voters with per-voter `votesAllowed`, and option texts.
   * @returns `{ pollId, httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure — `400` for unknown
   *   voters or validation failures, or whatever status
   *   `loadEditableDraft` / `DB.updatePoll` propagate (e.g. `403`,
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
    const draft = await this.loadEditableDraft(userId, pollId);
    if (!draft.ok) {
      return { errorMsg: draft.errorMsg, httpStatusCode: draft.httpStatusCode };
    }

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
      "POLL_PUBLISHED",
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
   * Returns a discriminated union: `{ ok: true, poll }` when editing is
   * permitted; otherwise `{ ok: false, errorMsg, httpStatusCode }` with
   * the appropriate status — `404` if the poll does not exist, `500` on
   * a database error, `403` if the caller is not the poll's creator, or
   * `409` if the poll has left draft state and is no longer editable.
   *
   * @param userId the id of the authenticated caller (from a verified
   *   JWT).
   * @param pollId the id of the poll to load.
   */
  private async loadEditableDraft(
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
    if (result.poll.status !== "draft") {
      return {
        ok: false,
        errorMsg: "Only drafts can be edited",
        httpStatusCode: 409,
      };
    }
    return { ok: true, poll: result.poll };
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
   * 3. Poll must be in `"draft"` or `"saved"` state (`403` otherwise).
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
      statusofVote.poll.status !== "saved"
    ) {
      return {
        errorMsg: "Only drafts and saved polls can be deleted",
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
    const draft = await this.loadEditableDraft(userId, pollId);
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

  private async finishPollWithVoteDrain(pollId: number): Promise<boolean> {
    const pollSatToClosing = await this.DB.markPollClosing(pollId);
    if (pollSatToClosing.httpStatusCode !== 200) {
      logger
        .error`Cannot set poll to closing, ${pollId}, err:${pollSatToClosing.errorMsg}`;
      return false;
    }

    const pollResult = await this.DB.getPollFromDB(pollId);
    if (!pollResult.poll) {
      logger.error`Cannot finish poll ${pollId}: poll not found`;
      return false;
    }

    const bufferedVotes = this.voteBuffer.takeBufferedVotes(pollId);
    const BufferedVotesIntoPending = await this.DB.insertPendingVoteBatch(
      pollId,
      bufferedVotes,
    );
    if (!BufferedVotesIntoPending.success) {
      logger
        .error`Cannot insert buffered into pending - poll ${pollId}: ${BufferedVotesIntoPending.errorMsg}`;
      this.voteBuffer.requeue(
        pollId,
        bufferedVotes.map((vote) => ({ pollId, ...vote })),
      );
      this.DB.insertAuditLog(
        "POLL_CLOSE_BUFFER_PERSIST_FAILED",
        `${pollId}, count: ${bufferedVotes.length} tried to insert buffer to pending, but failed, now the votebuffer is requeued in memory!`,
      );
      return false;
    }

    const integrityOk = await this.verifyPollCloseIntegrity(pollId);
    if (!integrityOk) {
      logger.error`Cannot finish poll ${pollId}: integrity check failed`;
      return false;
    }

    const pendingResult = await this.DB.listPendingVotesForPoll(pollId);
    if (pendingResult.httpStatusCode !== 200) {
      logger.error`Cannot finish poll ${pollId}: ${pendingResult.errorMsg}`;
      return false;
    }

    const allVotes = pendingResult.votes;

    const shuffled = secureShuffle(allVotes);

    const latesthashFromDB = await this.DB.getLatestHash(pollId);
    if (latesthashFromDB.httpStatusCode !== 200) {
      logger
        .error`Cannot finish poll ${pollId}: could not retrieve latest hash`;
      return false;
    }

    let previousHash = latesthashFromDB.hash ?? "0";
    const finalVotes: VoteInsert[] = shuffled.map((vote) => {
      const currentHash = this.createVoteHash(
        previousHash,
        vote.uuid,
        vote.optionId,
        pollId,
        pollResult.poll!.ballotPrivacy,
        pollResult.poll!.showTopN,
      );
      const finalVote = {
        optionId: vote.optionId,
        uuid: vote.uuid,
        signature: vote.signature,
        previousHash,
        currentHash,
      };
      previousHash = currentHash;
      return finalVote;
    });

    const closedAt = new Date();
    const closeCommitment = this.buildCloseCommitment(
      pollResult.poll,
      finalVotes,
      closedAt,
    );

    let closeTimestampQuery: Uint8Array;
    let closeTimestampToken: Uint8Array;
    try {
      const timestampArtifacts = await timestampCommitment(closeCommitment);
      closeTimestampQuery = timestampArtifacts.timestampQuery;
      closeTimestampToken = timestampArtifacts.timestampToken;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error`Cannot timestamp poll ${pollId}: ${msg}`;
      return false;
    }

    const finalizeResult = await this.DB.finalizePollClose(
      pollId,
      finalVotes,
      closeCommitment,
      closeTimestampQuery,
      closeTimestampToken,
      closedAt,
    );
    if (!finalizeResult.success) {
      logger
        .error`Cannot finish poll ${pollId}: could not finalizeresult, err: ${finalizeResult.errorMsg}`;
      return false;
    }

    this.DB.insertAuditLog(
      "POLL_CLOSED_AND_TIMESTAMPED",
      `pollId:${pollId}, count:${finalVotes.length}`,
    );
    return true;
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
      pollsReadyToFinish.map((pollId) => this.finishPollWithVoteDrain(pollId)),
    );
    const finishedCount = finishResults.filter(Boolean).length + finished;
    if (finishedCount > 0) {
      this.DB.insertAuditLog("POLL_AUTO_FINISHED", `count:${finishedCount}`);
    }
  }

  private async verifyPollIntegrityAtStartUp(pollId: number): Promise<boolean> {
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

    const isCreator = poll.createdBy === userId;
    const isEligible = isCreator
      ? true
      : await this.DB.isUserEligible(pollId, userId);

    if (!isCreator && !isEligible) {
      return { errorMsg: "Forbidden", httpStatusCode: 403 };
    }

    const options = await this.DB.getPollOptionsFromDB(pollId);
    const voters = await this.DB.getEligibleVoters(pollId);
    return { result: { poll, options, voters }, httpStatusCode: 200 };
  }
}
