/*
 * Library for containing some standard functions for working with web related stuff.
 * Can be shared across the client- and server code.
 */

/**
 * Types of callbacks that can be sent via the websocket connection. The client and server can use this enum to specify the type of callback they want to send, so the receiver can handle it accordingly.
 * E.g. if the client sends a message with the type `refetchVoteCount`, the server can handle this by refetching the vote count for the relevant poll and sending it back to the client.
 */
export const callbackTypes = {
  nil: "nil",
  refetchVoteCount: "refetchVoteCount",
} as const;

/**
 * Gets the cookies from a string containing cookies.
 *
 * @param name
 * @param cookies
 * @returns
 */
export const getCookie = (
  name: string,
  cookies: string,
): string | undefined => {
  const value = `; ${cookies}`;
  const parts = value.split(`; ${name}=`);

  if (parts.length === 2) {
    return parts.pop()?.split(";").shift();
  }

  return undefined;
};

export type userId = number;

/**
 * The TypeScript equivalent of the User object stored in the database.
 *
 * @param id A uniqe number representing the user.
 * @param name A uniqe name representing the user
 * @parm passwordHash The password stored as a Argon2id hash.
 */
export interface User {
  id: userId;
  name: string;
  passwordHash: string;
}

export type pollOptionId = number;

export type pollId = number;
export type pollVisibility = "public" | "private";
export type ballotPrivacy = "secret" | "open";
export type pollStatus =
  | "draft"
  | "not started"
  | "started"
  | "closing" // intermediate state to handle proper closing of poll
  | "finished"
  | "invalidated";

export interface PollOption {
  id: pollOptionId;
  pollId: pollId;
  optionText: string | null;
  displayOrder: number;
}

export interface Vote {
  id: string;
  pollId: pollId;
  pollOptionId: pollOptionId;
  userId: number | null;
  timestamp: string; // publication/drain time not the original cast time for "secret poll"
  chainPosition: number;
  previousHash: string;
  currentHash: string;
  signature: string | null; // RSA signature on the prepared message (id)
}

/**
 * @param showTopN - Instead of showing the distribution of votes, the top n votes will be shown.
 * E.g. if a ballot has options: x, y, and z, where x got 10 votes, y got 5 and z got 1.
 * Then instead of showing the exact vote distribution, if for example showTopN=2, then x and y will be shown as being in "top 2".
 * @param ballotLimit - The amount of ballot options a user can select per vote.
 * E.g. if ballotLimit=2 and the user can vote for ballot options: x, y, and z, the user could for an example vote for x and z.
 */
export interface Poll {
  id: pollId;
  title: string | null;
  description: string | null;
  status: pollStatus;
  createdBy: userId;
  createdAt: string;
  startsAt?: string;
  endsAt?: string;
  pollVisibility: pollVisibility | null;
  ballotPrivacy: ballotPrivacy | null;
  showTopN: number | null;
  ballotLimit: number | null;
  useBuffer: number | null;
}

export interface OpenpollResult {
  poll: Poll;
  options: PollOption[];
  votesAllowed: number;
  votesRemaining: number;
  userId: number;
  blindRsaPublicKey: string; // PEM-encoded blind-RSA
}

export interface VoteInput {
  optionId: number;
  uuid: string;
  signature: string; // Base64 of the finalized RSA-PSS signature on `uuid`.
}

export type ResultsPayload =
  | {
    ballotPrivacy: "secret";
    showTopN: number;
    closeCommitment: string | null;
    closedAt: string | null;
    hasCloseTimestampQuery: boolean;
    hasCloseTimestampToken: boolean;
    closeTsaName: string | null;
    counts: {
      optionId: number;
      optionText: string;
      count?: number | null;
      rank?: number;
    }[];
    votes: {
      uuid: string;
      previousHash: string;
      currentHash: string;
      signature: string | null;
    }[];
    // folowwing is for reporting how many have not voted (nonvoter since anon)
    nonVoterCount: number;
    eligibleCount: number;
    totalVotesAllowed: number;
    blindRsaPublicKey: string; //PEM-encoded
  }
  | {
    ballotPrivacy: "open";
    showTopN: number;
    closeCommitment: string | null;
    closedAt: string | null;
    hasCloseTimestampQuery: boolean;
    hasCloseTimestampToken: boolean;
    closeTsaName: string | null;
    counts: {
      optionId: number;
      optionText: string;
      count: number | null;
      rank?: number;
    }[];
    votes: {
      uuid: string;
      username: string;
      userId: number | null;
      optionId: number;
      optionText: string;
      previousHash: string;
      currentHash: string;
      signature: string | null;
    }[];
    nonVoters: { userId: number; username: string }[];
    eligibleCount: number;
    totalVotesAllowed: number;
    blindRsaPublicKey: string | null;
  };

/**
 * Interface for descirbing a entry into the poll overview page.
 * The object is specfic to the client is it instantiated in.
 *
 * @param poll - The poll object to be shown as a entry in the overview page.
 * @param folder - The folder the poll entry is stored in on the overview page.
 * @param pollProgress - Progress indicator showing the ratio of ballots cast.
 * e.g. `3/14`, shows that 3 ballots are cast and 11 are yet to be cast.
 * @param timeLeft - The remaning time left until a poll closes.
 */
export interface FrontEndPoll {
  poll: Poll;
  folder?: string;
  isUserEligibleVoter: boolean;
  hasVoted: boolean;
  pollProgress: string;
  timeLeft: string;
  pollOwnerUsername: string;
}

/**
 * The local "receipt" written to localStorage after each successful vote.
 * Together with the poll's public key + the public results page, this is
 * everything needed to later prove "my vote is in the tally". The server
 * never has the link from userId to these fields.
 */
export interface VoteReceipt {
  pollId: number;
  optionId: number;
  uuidB64: string;
  signatureB64?: string;
  userId?: number;
  castAt: string;
}

/**
 * Calculate the time remaining until the deadline is reached for a poll.
 * @param pollEndsAt - ISO end timestamp of the poll, or undefined if it has no deadline.
 * @param now - Optional reference timestamp used for derived rendering.
 */
export function calculateTimeRemaining(
  pollEndsAt: string | undefined,
  now = Date.now(),
): string {
  if (!pollEndsAt) {
    return "Ingen deadline";
  }

  let timeLeft = "00:00:00";
  if (pollEndsAt) {
    const diffMs = new Date(pollEndsAt).getTime() - now;
    if (diffMs > 0) {
      timeLeft = formatTime(diffMs);
    }
  }
  return timeLeft;
}

// Formats milliseconds into an HH:MM:SS string.
export function formatTime(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${
    String(secs).padStart(2, "0")
  }`;
}

/**
 * Builds the message string that goes into the vote hash. Same logic
 * must run on the server (when inserting a vote) and on the client
 * (during self-verify) — keep this in one place so they cannot drift.
 * "Ultra-secret" mode: when the poll is BOTH `secret` AND has `showTopN`
 * active, optionId is dropped from the hash so the brute-force tally
 * attack (low-entropy optionId → recover counts) is no longer possible.
 * The trade-off is that we can no longer detect DB-admin tampering with
 * `optionId` on individual rows; only "UUID is in this position in the
 * chain" stays verifiable.
 */
export function voteHashMessage(opts: {
  previousHash: string;
  uuid: string;
  optionId: number;
  userId?: number | null;
  pollId: number;
  ballotPrivacy: ballotPrivacy | null;
  showTopN: number | null;
}): string {
  if (opts.ballotPrivacy === "open") {
    return `PreviousHash:${opts.previousHash}|UUID:${opts.uuid}|UserId:${opts.userId}|pollOptionId:${opts.optionId}|pollid:${opts.pollId}`;
  }

  const ultraSecret = opts.ballotPrivacy === "secret" &&
    !!opts.showTopN && opts.showTopN > 0;
  return ultraSecret
    ? `PreviousHash:${opts.previousHash}|UUID:${opts.uuid}|pollId:${opts.pollId}`
    : `PreviousHash:${opts.previousHash}|UUID:${opts.uuid}|pollOptionId:${opts.optionId}|pollId:${opts.pollId}`;
}
