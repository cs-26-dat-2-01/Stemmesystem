import { env } from "./secret_handling.ts";
import { WebappDatabase, PendingVoteInsert } from "./database.ts";
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
  private timers = new Map<number, number>();
  private flushing = new Map<number, Promise<FlushResult>>();

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
   * if 
   *:
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
      return flush.success
        ? { success: true, httpStatusCode: 200 }
        : flush;
    }

    if (!this.timers.has(pollId)) {
      const timer = setTimeout(() => {
        this.flushToPending(pollId).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error`VoteBuffer timed flush failed for pollId ${pollId}: ${msg}`;
        });
      }, this.flushTimeoutMs);
      this.timers.set(pollId, timer);
    }

    return { success: true, httpStatusCode: 200 };
  }

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

  private clearTimer(pollId: number): void {
    const timer = this.timers.get(pollId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(pollId);
    }
  }

  private requeue(pollId: number, votes: BufferedPollVote[]): void {
    const current = this.buffers.get(pollId) ?? [];
    this.buffers.set(pollId, [...votes, ...current]);
  }
}

interface FlushResult {
  success: boolean;
  errorMsg?: string;
  httpStatusCode: ContentfulStatusCode;
}

export function secureShuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = 0; i < out.length; i++) {
    const j = randomIntInclusive(i, out.length - 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

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

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  logger.warn`${name} must be a positive integer; using ${fallback}`;
  return fallback;
}
