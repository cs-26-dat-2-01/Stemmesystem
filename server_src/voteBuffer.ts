import { env } from "./secret_handling.ts";
import { PendingVoteInsert, WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_FLUSH_TIMEOUT_MS = 30_000;

export interface BufferedVote {
  uuid: string;
  optionId: number;
  signature: string;
}

interface BufferedPollVote extends BufferedVote {
  pollId: number;
}

export class VoteBuffer {
  private buffers = new Map<number, BufferedPollVote[]>();
  private queuedUuids = new Set<string>();
  private timers = new Map<number, number>(); // timers is a map which keep track of the polldId and the timeoutId for when votes need to be flushed to pending table even if the buffer is not up to the batch size.
  private flushing = new Map<number, Promise<FlushResult>>(); // map that functions as a flush is already happining for this poll, we use the promise to see if a flush is happening.

  constructor(
    private db: WebappDatabase,
    private batchSize = readPositiveIntEnv(
      "VOTE_BUFFER_BATCH_SIZE",
      DEFAULT_BATCH_SIZE,
    ),
    private flushTimeoutMs = readPositiveIntEnv(
      "VOTE_BUFFER_FLUSH_MS",
      DEFAULT_FLUSH_TIMEOUT_MS,
    ),
  ) {}

  /**
   * Takes a pollId and a vote that needs to be added to the buffer
   * First it will check if the vote already exists by checking the UUID
   * Next up we check to see if there currently is a buffer for the pollId,
   * if not we create one. We add out vote to the buffer. Next we check to see
   * if the buffer has more than the batch size, if it does we will flush the votes
   * to the pending vote table in the database. When we will check to see if we have a
   * timer, if timer already set we will do nothing, but if not we will set one to the flushtimeoutMs
   * variable from .env.
   *
   *  @param pollId
   *  @param vote only containing uuid, optionid and signature.
   *
   * @returns succes: true and statuscode 200. if Error will return false, 409 and with a distinct error message.
   * :
   */
  async add(
    pollId: number,
    vote: BufferedVote,
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    if (this.queuedUuids.has(vote.uuid)) {
      return {
        success: false,
        errorMsg: "Vote already queued",
        httpStatusCode: 409,
      };
    }

    const existing = await this.db.voteExistsInAnyVoteStore(vote.uuid);
    if (existing.errorMsg) {
      return {
        success: false,
        errorMsg: existing.errorMsg,
        httpStatusCode: existing.httpStatusCode,
      };
    }
    if (existing.exists) {
      return {
        success: false,
        errorMsg: "Vote already cast",
        httpStatusCode: 409,
      };
    }

    const buffered = { pollId, ...vote };
    const buffer = this.buffers.get(pollId) ?? []; // either get the buffer or if it doesnt exists for poll, create a new one.
    buffer.push(buffered);
    this.buffers.set(pollId, buffer);
    this.queuedUuids.add(vote.uuid);

    if (buffer.length >= this.batchSize) {
      const flush = await this.flushToPending(pollId);
      return flush.success ? { success: true, httpStatusCode: 200 } : flush;
    }

    if (!this.timers.has(pollId)) {
      const timer = setTimeout(() => {
        this.flushToPending(pollId).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger
            .error`VoteBuffer timed flush failed for pollId ${pollId}: ${msg}`;
        });
      }, this.flushTimeoutMs);
      this.timers.set(pollId, timer);
    }

    return { success: true, httpStatusCode: 200 };
  }

  /**
   * Function which flushes the poll, it first check to see if there is an ongoing flush happening for the
   * poll, it does this by looking at the promise in the map flushing. If no flush is happening we set the
   * flag on the map flushing and call the fuction "doFlushToPending". afterwards it deletes the flag if the call was successful.
   */
  async flushToPending(pollId: number): Promise<FlushResult> {
    const existing = this.flushing.get(pollId);
    if (existing) return await existing;

    const promise = this.doFlushToPending(pollId);
    this.flushing.set(pollId, promise);
    try {
      return await promise;
    } finally {
      this.flushing.delete(pollId);
    }
  }
  /**
   * Is called in pollmanager.
   * Purpose is to get the last buffered votes "out of memory" and returned so
   * they can be shuffled together will all votes in pending votesi
   */
  takeBufferedVotes(pollId: number): PendingVoteInsert[] {
    const buffered = this.buffers.get(pollId) ?? [];
    this.buffers.set(pollId, []);
    this.clearTimer(pollId);
    for (const vote of buffered) this.queuedUuids.delete(vote.uuid);
    return buffered.map((vote) => ({
      optionId: vote.optionId,
      uuid: vote.uuid,
      signature: vote.signature,
    }));
  }

  /**
   * Function that takes buffered votes and inputs it into pending table in db
   * First check to see if batch is empty, nextup we set the buffer to empty
   * and clear all timers. Next up we secure shuffle the batch so you cant be
   * sure of the order the votes came in. then insert it into table, if this fails
   * it reques all the votes to be tried again. Before returning we delete all the
   * buffered votes uuid from our uuid map, and writes to auditlog and returns success true
   * 200
   * This function does not return any error messages as it simply reques the votes if it fails.
   */
  private async doFlushToPending(pollId: number): Promise<FlushResult> {
    const batch = this.buffers.get(pollId) ?? [];
    if (batch.length === 0) {
      this.clearTimer(pollId);
      return { success: true, httpStatusCode: 200 };
    }

    this.buffers.set(pollId, []);
    this.clearTimer(pollId);

    const shuffled = secureShuffle(batch).map((vote) => ({
      optionId: vote.optionId,
      uuid: vote.uuid,
      signature: vote.signature,
    }));
    const inserted = await this.db.insertPendingVoteBatch(pollId, shuffled);
    if (!inserted.success) {
      this.requeue(pollId, batch);
      return inserted;
    }

    for (const vote of batch) this.queuedUuids.delete(vote.uuid);
    this.db.insertAuditLog(
      "PENDING_VOTES_BUFFERED",
      `pollId:${pollId}, count:${shuffled.length}`,
    );
    return { success: true, httpStatusCode: 200 };
  }

  // clears the timer on a specific poll
  private clearTimer(pollId: number): void {
    const timer = this.timers.get(pollId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(pollId);
    }
  }

  //inserts the votes in the buffer again.
  private requeue(pollId: number, votes: BufferedPollVote[]): void {
    const current = this.buffers.get(pollId) ?? [];
    this.buffers.set(pollId, [...votes, ...current]);
  }
  public countBuffered(pollId: number): number {
    const buffered = this.buffers.get(pollId) ?? [];
    return buffered.length;
  }
}

interface FlushResult {
  success: boolean;
  errorMsg?: string;
  httpStatusCode: ContentfulStatusCode;
}

// Radnomly-Permute ALG s. 136
export function secureShuffle<T>(items: readonly T[]): T[] { // T is generic
  const out = [...items];
  for (let i = 0; i < out.length; i++) {
    const j = randomIntInclusive(i, out.length - 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** Draw a cryptographically random 32-bit integer and map it into [min,max].
 * Values in the small uyper tail are rejected to avoid modulo bias.
 */
function randomIntInclusive(min: number, max: number): number {
  const range = max - min + 1;
  if (range <= 1) return min;

  const maxUnbiased = Math.floor(0x1_0000_0000 / range) * range;
  const random = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(random);
    if (random[0] < maxUnbiased) {
      return min + (random[0] % range);
    }
  }
}
// get the env. and asserts that it must be positive.
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  logger.warn`${name} must be a positive integer; using ${fallback}`;
  return fallback;
}
