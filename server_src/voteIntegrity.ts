import { ballotPrivacy, Poll, voteHashMessage } from "../client_src/WebLib.ts";
import { createHash } from "node:crypto";
import type { VoteInsert } from "./database.ts";

/**
 * The exact byte layout produced here is consensus-critical: the same logic
 * runs during close (server) and during client-side self-verification, and any
 * drift between secret and open would break verification. Keep these as pure
 * functions and change their output format only with extreme care.
 */

/** Computes a SHA-256 hash (hex). */
export function sha256Hex(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
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
export function createVoteHash(
  previousHash: string,
  UUID: string,
  optionId: number,
  userId: number | null, 
  pollId: number,
  ballotPrivacy: ballotPrivacy | null,
  showTopN: number | null,
): string {
  const hashMsg = voteHashMessage({
    previousHash: previousHash,
    uuid: UUID,
    optionId: optionId,
    userId, 
    pollId: pollId,
    ballotPrivacy: ballotPrivacy,
    showTopN: showTopN,
  });
  return createHash("sha256").update(hashMsg, "utf8").digest("hex");
}

/**
 * Builds the close commitment: a single SHA-256 hash binding together the
 * final hash-chain tip, the per-option vote counts, the poll metadata, and the
 * close timestamp. This commitment is what gets sent to the TSA
 * timestamp so the closed poll can later be verified end-to-end.
 *
 * @param poll - The poll being closed (metadata fields are included in the commitment).
 * @param finalVotes - Votes in chain order; the last vote's `currentHash` seals the chain.
 * @param closedAt - Timestamp marking when the poll was closed.
 * @returns Hex-encoded SHA-256 close commitment.
 */
export function buildCloseCommitment(
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

  const countsHash = sha256Hex(sortedCounts);
  const metadataHash = sha256Hex(pollMetadata);

  return sha256Hex(
    `${finalChainHash}${countsHash}${metadataHash}${closedAt.toISOString()}`,
  );
}
