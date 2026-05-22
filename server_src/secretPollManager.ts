import { WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { blindSign, verify } from "./blindRsa.ts";
import { secureShuffle, VoteBuffer } from "./voteBuffer.ts";
import type { VoteInsert } from "./database.ts";
import { timestampCommitment } from "./timestamping.ts";
import { buildCloseCommitment, createVoteHash } from "./voteIntegrity.ts";

/**
 * Owns the secret (anonymous) voting flow built on blind RSA signatures
 * (RFC 9474): blind-signature issuance, the unauthenticated cast, the RAM vote
 * buffer, and the drain → shuffle → hash-chain → timestamp close path.
 *
 * Extracted from `PollManager` so the anonymity-critical machinery lives in one
 * place, isolated from the identified (open-poll) flow. `PollManager` remains
 * the public facade: it advances poll lifecycle (`tickPollStatuses`) and then
 * delegates secret operations here. This class never calls back into
 * `PollManager` — it depends only on the database and its own vote buffer — so
 * there is no cycle between the two.
 */
export class SecretPollManager {
  private DB: WebappDatabase;
  private voteBuffer: VoteBuffer;

  constructor(db: WebappDatabase) {
    this.DB = db;
    this.voteBuffer = new VoteBuffer(db);
  }

  /**
   * Casts an anonymous vote. Reached via `PollManager.castVote`, which is
   * called from `POST /api/poll/:pollId/vote` and advances poll statuses
   * before delegating here.
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
   * (RFC 9474 §4.3). Reached via `PollManager.issueBlindSignature`, called
   * from `POST /api/poll/:pollId/blindsign`.
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
   * Drains the RAM buffer to pending, verifies close integrity, shuffles the
   * pending votes, builds the hash chain, timestamps the close commitment, and
   * finalizes the poll. Called both from `castVote` (when the last allowed vote
   * arrives) and from `PollManager.tickPollStatuses` (when `endsAt` elapses).
   *
   * @returns `true` if the poll was closed and timestamped; `false` if any
   *   step failed (the poll is left for a later retry, or invalidated).
   */
  public async finishPollWithVoteDrain(pollId: number): Promise<boolean> {
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
      const currentHash = createVoteHash(
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
    const closeCommitment = buildCloseCommitment(
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
   * Verifies that a poll is safe to close by comparing issued signatures
   * against persisted votes (final + pending) and ensuring the RAM buffer is
   * fully drained.
   *
   * Three outcomes:
   * - Buffered votes remain: aborts the close (snapshot not trustworthy).
   * - persisted > issued: marks the poll as invalidated (more votes than
   *   signatures issued indicates a serious integrity breach) and aborts.
   * - persisted < issued: logs a `POLL_INTEGRITY_GAP_AT_CLOSE` audit entry and
   *   warns about lost votes, but still allows the close to proceed.
   *
   * @param pollId - ID of the poll being closed.
   * @returns True if the poll may proceed to close; false if the buffer is not
   *          drained or the poll was invalidated.
   */
  private async verifyPollCloseIntegrity(pollId: number): Promise<boolean> {
    const issuedVotes = await this.DB.countIssuedSignatures(pollId);
    const persistedVotes = await this.DB.countPersistedVotes(pollId);

    const bufferedVotes = this.voteBuffer.countBuffered(pollId);

    // After a poll has been moved to "closing", the RAM buffer should have been
    // drained into pendingVote. If not, the close snapshot is not trustworthy.
    if (bufferedVotes !== 0) {
      logger.error`Poll ${pollId} still has ${bufferedVotes} buffered vote(s) during integrity check`;
      return false;
    }

    if (persistedVotes > issuedVotes) {
      const reason =
        `expected:${issuedVotes}, persisted:${persistedVotes}, buffered:${bufferedVotes}`;

      const invalidated = await this.DB.markPollInvalidated(pollId, reason);
      if (!invalidated.success) {
        logger.error`Failed to invalidate poll ${pollId}: ${invalidated.errorMsg}`;
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
}
