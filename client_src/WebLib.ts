/*
 * Library for containing some standard functions for working with web related stuff.
 * Can be shared across the client- and server code.
 */

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
  | "draft" // Ongoing editing by poll creator.
  | "saved" // Edits saved but poll haven't been published.
  | "not started" // Poll have been published and will start at the given start time.
  | "started" // Poll is started and eligible voters can cast their ballot.
  | "finished"; // Poll is finished and users with correct access rights can see the poll results.

export interface PollOption {
  id: pollOptionId;
  pollId: pollId;
  optionText: string | null;
  displayOrder: number;
}

export interface VoteToken {
  id: number;
  pollId: pollId;
  userId: userId;
  UUID: string;
  createdAt: string;
  used: boolean;
}

export interface Vote {
  id: string;
  pollId: pollId;
  pollOptionId: pollOptionId;
  timestamp: string;
  previousHash: string;
  currentHash: string;
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
}

export interface VoteInput {
  optionId: number;
  UUID: string;
}

export type ResultsPayload =
  | {
    ballotPrivacy: "secret";
    showTopN: number;
    counts: { optionId: number; optionText: string; count: number }[];
    votes: { uuid: string }[];
  }
  | {
    ballotPrivacy: "open";
    showTopN: number;
    counts: { optionId: number; optionText: string; count: number }[];
    votes: { uuid: string; optionId: number; optionText: string }[];
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
}

/**
 * Calculate the time remaining until the deadline is reached for a poll.
 * @param poll - The poll object to calculate for.
 */
export function calculateTimeRemaining(poll: Poll) {
  let timeLeft = "00:00:00";
  if (poll.endsAt) {
    const diffMs = new Date(poll.endsAt).getTime() - Date.now();
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / 3_600_000);
      const mins = Math.floor((diffMs % 3_600_000) / 60_000);
      const secs = Math.floor((diffMs % 60_000) / 1_000);
      timeLeft = `${String(hours).padStart(2, "0")}:${
        String(mins).padStart(2, "0")
      }:${String(secs).padStart(2, "0")}`;
    }
  }
  return timeLeft;
}
