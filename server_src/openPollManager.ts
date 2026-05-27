import { WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import type { VoteInsert } from "./database.ts";
import { timestampCommitment } from "./timestamping.ts";
import { buildCloseCommitment, createVoteHash } from "./voteIntegrity.ts";

export class OpenPollManager {
  private DB: WebappDatabase;
  private openCastLocks = new Map<number, Promise<unknown>>(); // Serialising lock

  constructor(db: WebappDatabase) {
    this.DB = db;
  }

  /* Function to make the casting of votes sequential
	 */
  private runExclusive<T>(pollId: number, task: () => Promise<T>): Promise<T> {
    const prev = this.openCastLocks.get(pollId) ?? Promise.resolve();
    const result = prev.catch(() => {}).then(task);
    const tail = result.catch(() => {}); // if promise fails, we will simply "ignore it" with empty function.
    this.openCastLocks.set(pollId, tail);
    tail.finally(() => {
      if (this.openCastLocks.get(pollId) === tail) {
        this.openCastLocks.delete(pollId);
      }
    });
    return result;
  }

  private async ensurePollCanBeClosed(pollId: number): Promise<boolean> {
    const pollResult = await this.DB.getPollFromDB(pollId);
    if (!pollResult.poll) {
      logger.error`Cannot finish poll ${pollId}: poll not found`;
      return false;
    }

    if (pollResult.poll.status === "closing") {
      return true;
    }

    if (pollResult.poll.status !== "started") {
      logger
        .error`Cannot finish poll ${pollId}: poll is ${pollResult.poll.status}`;
      return false;
    }

    const pollSatToClosing = await this.DB.markPollClosing(pollId);
    if (pollSatToClosing.httpStatusCode !== 200) {
      logger
        .error`Cannot set poll to closing, ${pollId}, err:${pollSatToClosing.errorMsg}`;
      return false;
    }

    return true;
  }

  public async sealOpenPollClose(pollId: number): Promise<boolean> {
    const canClose = await this.ensurePollCanBeClosed(pollId);
    if (!canClose) return false;

    const pollResult = await this.DB.getPollFromDB(pollId);
    if (!pollResult.poll) {
      logger.error`Cannot finish poll ${pollId}: poll not found`;
      return false;
    }

    const votes = await this.DB.listVotesForCommitment(pollId);
    if (votes.httpStatusCode !== 200) {
      logger.error`Cannot get votes for commitment poll: ${pollId}`;
      return false;
    }

    const closedAt = new Date();
    const closeCommitment = buildCloseCommitment(
      pollResult.poll,
      votes.votes,
      closedAt,
    );
    let closeTimestampQuery: Uint8Array;
    let closeTimestampToken: Uint8Array;
    let closeTsaName: string;
    try {
      const timestampArtifacts = await timestampCommitment(closeCommitment);
      closeTimestampQuery = timestampArtifacts.timestampQuery;
      closeTimestampToken = timestampArtifacts.timestampToken;
      closeTsaName = timestampArtifacts.tsaName;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error`Cannot timestamp poll ${pollId}: ${msg}`;
      return false;
    }

    const finalizeResult = await this.DB.setCloseArtifacts(
      pollId,
      closeCommitment,
      closeTimestampQuery,
      closeTimestampToken,
      closeTsaName,
      closedAt,
    );
    if (finalizeResult.success !== true) {
      logger.error`Could not finalize result pollId: ${pollId}`;
      return false;
    }

    this.DB.insertAuditLog(
      "POLL_CLOSED_AND_TIMESTAMPED",
      `pollId:${pollId}, count:${votes.votes.length}`,
    );
    return true;
  }

  public async castVoteOpen(
    pollId: number,
    userId: number,
    votes: { uuid: string; optionId: number }[],
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    if (votes.length <= 0) {
      return {
        success: false,
        errorMsg: "Invalid no votes",
        httpStatusCode: 400,
      };
    }

    for (const vote of votes) {
      if (typeof vote.uuid !== "string" || vote.uuid.length === 0) {
        return {
          success: false,
          errorMsg: "Invalid uuid",
          httpStatusCode: 400,
        };
      }
      if (!Number.isInteger(vote.optionId)) {
        return {
          success: false,
          errorMsg: "Invalid optionId",
          httpStatusCode: 400,
        };
      }
    }
    const poll = await this.DB.getPollFromDB(pollId);
    if (poll.httpStatusCode !== 200 || !poll.poll) {
      return {
        success: false,
        errorMsg: "Poll not found",
        httpStatusCode: 404,
      };
    }
    const pollData = poll.poll; // narrowed so typescript does not say it can be undefined.
    if (poll.poll.status !== "started") {
      return {
        success: false,
        errorMsg: "Voting is not open for this poll",
        httpStatusCode: 403,
      };
    }

    if (poll.poll?.ballotPrivacy !== "open") {
      return {
        success: false,
        errorMsg: "Vote is not open",
        httpStatusCode: 403,
      };
    }

    const Eligiblity = await this.DB.isUserEligible(pollId, userId);
    if (!Eligiblity) {
      return {
        success: false,
        errorMsg: "User is not eligible",
        httpStatusCode: 403,
      };
    }
    // Every optionId must belong to THIS poll — otherwise a caller could cast
    // for an option from another poll (the Vote.pollOptionId FK only checks the
    // option exists, not that it belongs here). Reject the whole batch.
    const validOptionIds = new Set(
      (await this.DB.getPollOptionsFromDB(pollId)).map((o) => o.id),
    );
    for (const vote of votes) {
      if (!validOptionIds.has(vote.optionId)) {
        return {
          success: false,
          errorMsg: "optionId does not belong to this poll",
          httpStatusCode: 400,
        };
      }
    }

    const insertResult = await this.runExclusive(pollId, async () => {
      const LatestHash = await this.DB.getLatestHash(pollId);
      let prev = LatestHash.hash ?? "0";
      let pos = LatestHash.chainposition ?? 0;
      const built = [];
      for (const { uuid, optionId } of votes) {
        pos += 1;
        const currentHash = createVoteHash(
          prev,
          uuid,
          optionId,
          userId,
          pollId,
          pollData.ballotPrivacy,
          pollData.showTopN,
        );
        built.push({
          optionId,
          uuid,
          userId,
          signature: null,
          chainPosition: pos,
          previousHash: prev,
          currentHash,
        });
        prev = currentHash;
      }
      return this.DB.insertVoteBatch(pollId, userId, built);
    });

    // The batch insert is awaited above; surface its failure (quota,
    // constraint, ...) instead of falsely reporting success.
    if (!insertResult.success) {
      return insertResult;
    }

    this.DB.insertAuditLog(
      "OPEN_VOTES_CAST",
      `pollId:${pollId}, userId:${userId}, voteCount:${votes.length}`,
    );

    const votesAllowed = await this.DB.countTotalVotesAllowed(pollId);
    const castedVotes = await this.DB.countCastVotesTotal(pollId);
    if (votesAllowed === castedVotes) {
      await this.sealOpenPollClose(pollId);
    }

    return { success: true, httpStatusCode: 200 };
  }
}
