// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#password-hashing-algorithms
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
import * as argon2 from "npm:argon2@0.44.0"; // used for hashing
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";
import {
  ballotPrivacy,
  FrontEndPoll,
  Poll,
  PollOption,
  pollStatus,
  pollVisibility,
  User,
  Vote,
} from "../client_src/WebLib.ts";

import { Prisma, PrismaClient } from "../generated/prisma/client.ts";

/**
 * The result of the getUserFromDB function, which is used to fetch a user from the database based on a username.
 *
 * @property user the user object if a user with the provided username exists in the database, otherwise undefined.
 * @property errorMsg an error message if an error occurred during fetching the user from the database, otherwise undefined.
 * @property httpStatusCode the http status code which should be sent to the client based on the result of fetching a user from the database.
 */
interface getUserFromDBResult {
  user?: User;
  errorMsg?: string;
  httpStatusCode: ContentfulStatusCode;
}

interface getPollFromDBResult {
  poll?: Poll;
  errorMsg?: string;
  httpStatusCode: ContentfulStatusCode;
}

export interface AuditLogEntry {
  id: number;
  action: string;
  timestamp: string;
  details: string | null;
}

export interface VoteInsert {
  optionId: number;
  UUID: string;
  previousHash: string;
  currentHash: string;
}

export interface PollCreateInput {
  title?: string | null;
  description?: string | null;
  voteStatus: pollStatus | null;
  createdBy: number;
  startsAt?: string | null;
  endsAt?: string | null;
  pollVisibility?: pollVisibility | null;
  ballotPrivacy?: ballotPrivacy | null;
  showTopN?: number | null;
  ballotLimit?: number | null;
  useBuffer?: number | null;
  optionTexts?: string[];
  voterUserIds?: number[];
}
export interface PollUpdateInput {
  title?: string | null;
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  pollVisibility?: pollVisibility | null;
  ballotPrivacy?: ballotPrivacy | null;
  showTopN?: number | null;
  ballotLimit?: number | null;
  useBuffer?: number | null;
  voteStatus?: pollStatus;
  optionTexts?: string[];
  voters?: Array<{ userId: number; votesAllowed: number }>;
}

/**
 * Class for creating an ad hoc database object for the web application.
 */
export class WebappDatabase {
  private prisma!: PrismaClient;

  /**
   * Disabled public use of constructor due to async limitation.
   *
   * @param adminPassword
   */
  private constructor(databaseUrl = env.DATABASE_URL) {
    this.prisma = new PrismaClient({
      adapter: new PrismaLibSql({ url: databaseUrl }),
    });
  }

  private async ensureAdminUser(adminPassword: string): Promise<void> {
    await this.prisma.user.upsert({
      where: { username: "admin" },
      update: {}, // Do not update if admin user already exists
      create: {
        username: "admin",
        passwordHash: adminPassword,
      },
    }).then(() => {
      logger.info("Admin user created or already exists in database.");
    }).catch((err: { message: string }) => {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.fatal`Error while creating admin user in database: ${errMsg}`;
      throw new Error("Error while creating admin user in database.");
    });
  }
  private async logDatabaseState(): Promise<void> {
    try {
      const rows = await this.prisma.user.findMany({
        select: { id: true, username: true, passwordHash: true },
      });
      logger.trace("DB | Users: {rows}", { rows });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error`Error fetching users via Prisma: ${errMsg}`;
    }

    try {
      const polls = await this.prisma.poll.findMany();
      logger.trace("DB | Polls: {polls}", { polls });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error`Error fetching polls via Prisma: ${errMsg}`;
    }
  }
  /**
   * Initialize the SQLite database for the web application.
   *
   * @param filePath the path to the database file. If not found a new file will be created.
   */
  public static async initDatabase(
    databaseUrl = env.DATABASE_URL,
  ): Promise<WebappDatabase> {
    const adminPassword = await argon2.hash(env.ADMIN_USER_PASSWORD); // https://github.com/ranisalt/node-argon2
    const dbInstance = new WebappDatabase(databaseUrl);
    await dbInstance.ensureAdminUser(adminPassword);
    await dbInstance.logDatabaseState();

    // Get admin from database
    const { user, httpStatusCode, errorMsg } = await dbInstance.getUserFromDB(
      "admin",
    );

    if (!user) {
      logger
        .fatal`Admin user not found in database after initialization. Status code: ${httpStatusCode}, error message: ${errorMsg}`;
      throw new Error("Admin user not found in database after initialization.");
    }

    // Check if admin user is in database
    if (httpStatusCode !== 200) {
      throw new Error(`Admin user not found in the database: ${errorMsg}`);
    }

    // Verify password from database with password from .env
    const passwordMatches = await argon2.verify(
      user.passwordHash,
      env.ADMIN_USER_PASSWORD,
    );

    // Throw error if password from database doesn't match password from .env
    if (!passwordMatches) {
      throw new Error(
        "Admin password in database does not match .env password.",
      );
    }

    logger.info("Admin password successfully validated.");
    return dbInstance;
  }

  /**
   * Fetches a user from the db based on a username, if that user exists.
   *
   * @param username used that will be looked up and fetched from the db.
   */
  public async getUserFromDB(username: string): Promise<getUserFromDBResult> {
    try {
      const sqlResult = await this.prisma.user.findUnique({
        where: { username },
        select: { id: true, username: true, passwordHash: true },
      });

      if (typeof sqlResult === "undefined" || sqlResult === null) {
        logger.info`User with username: ${username} not found in database.`;
        return { errorMsg: "User not found in database", httpStatusCode: 400 };
      }

      const user: User = {
        id: sqlResult.id,
        name: sqlResult.username,
        passwordHash: sqlResult.passwordHash,
      };

      return { user, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error`Error fetching user via Prisma: ${errMsg}`;
      return { errorMsg: "Error fetching user", httpStatusCode: 500 };
    }
  }

  /**
   * Creates a new user in the database.
   * On duplicate entry a username no entry is added and the query is ignored.
   *
   * @param username of the user going to be created.
   * @param password of the user going to be created.
   */
  public async addUserToDB(
    username: string,
    password: string,
  ): Promise<ContentfulStatusCode> {
    try {
      // Check existence of user first to avoid duplicate and unnecessary work.
      const exists = await this.prisma.user.findUnique({
        where: { username },
      });
      if (exists) {
        logger.info`User with username: ${username} already exists.`;
        return 200; // user already present
      }

      // https://github.com/ranisalt/node-argon2
      const passwordHash = await argon2.hash(password);

      // Attempt to create; handle possible race where user was created concurrently
      try {
        await this.prisma.user.create({ data: { username, passwordHash } });
        logger.info`Created user in database with username: ${username}`;
        return 201;
      } catch (createErr) {
        // Prisma unique constraint error code `P2002` means username was created concurrently.
        const errorCode = (createErr as Prisma.PrismaClientKnownRequestError)
          ?.code;
        if (errorCode === "P2002") {
          logger
            .info`User with username: ${username} already exists (concurrent create).`;
          return 200;
        }
        throw createErr;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while adding user to database with username: ${username}. Error: ${errMsg}`;
      return 500;
    }
  }

  /**
   * Deletes a user entry from the database.
   *
   * @param username of the user going to be deleted from the database
   */
  public async deleteUserFromDB(username: string) {
    try {
      await this.prisma.user.delete({ where: { username } });
      logger.info`Deleted user from database with username: ${username}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If the user does not exist Prisma throws a `P2025` error; log as info.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2025") {
        logger.info`User with username: ${username} not found while deleting.`;
        return;
      }
      logger
        .error`Error deleting user with username: ${username}. Error: ${errMsg}`;
    }
  }

  /**
   * Closes the internal application database.
   *
   * @todo tie this in with a proper destructor.
   */
  public closeDB() {
    return this.prisma.$disconnect();
  }

  /**
   * Fetches a poll from the database based on its ID.
   *
   * @param pollId the ID of the poll to be fetched from the database.
   * @returns Promise<getPollFromDBResult> a promise that resolves to an object containing the poll if found, an optional error message, and an HTTP status code representing the result of fetching the poll. If the poll is not found, the result will contain an error message and a 400 status code. If an error occurs during fetching, the result will contain an error message and a 500 status code.
   */
  public async getPollFromDB(pollId: number): Promise<getPollFromDBResult> {
    try {
      const sqlResult = await this.prisma.poll.findUnique({
        where: { id: pollId },
        select: {
          id: true,
          title: true,
          description: true,
          voteStatus: true,
          createdBy: true,
          createdAt: true,
          startsAt: true,
          endsAt: true,
          pollVisibility: true,
          ballotPrivacy: true,
          showTopN: true,
          ballotLimit: true,
          useBuffer: true,
        },
      });

      if (!sqlResult) {
        logger.info`Poll with ID: ${pollId} not found in database.`;
        return { errorMsg: "Poll not found in database", httpStatusCode: 400 };
      }

      const poll: Poll = {
        id: sqlResult.id,
        title: sqlResult.title as Poll["title"],
        description: sqlResult.description as Poll["description"],
        status: sqlResult.voteStatus as pollStatus,
        createdBy: sqlResult.createdBy,
        createdAt: sqlResult.createdAt.toString(),
        startsAt: sqlResult.startsAt
          ? sqlResult.startsAt.toString()
          : undefined,
        endsAt: sqlResult.endsAt ? sqlResult.endsAt.toString() : undefined,
        pollVisibility: sqlResult.pollVisibility as pollVisibility | null,
        ballotPrivacy: sqlResult.ballotPrivacy as ballotPrivacy | null,
        showTopN: sqlResult.showTopN,
        ballotLimit: sqlResult.ballotLimit,
        useBuffer: sqlResult.useBuffer,
      };

      return { poll, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error`Error fetching poll via Prisma: ${errMsg}`;
      return { errorMsg: "Error fetching poll", httpStatusCode: 500 };
    }
  }

  /**
   * Fetches the poll options for a given poll from the database.
   * Returns an empty array if no options are found or if an error occurs during fetching.
   * The options are ordered by their `displayOrder` in ascending order.
   *
   * @param pollId the ID of the poll for which the options should be fetched.
   * @returns Promise<PollOption[]> a promise that resolves to an array of PollOption objects representing the options for the specified poll. If no options are found or if an error occurs, the promise resolves to an empty array.
   */
  public async getPollOptionsFromDB(pollId: number): Promise<PollOption[]> {
    try {
      return await this.prisma.pollOption.findMany({
        where: { pollId },
        select: {
          id: true,
          pollId: true,
          optionText: true,
          displayOrder: true,
        },
        orderBy: { displayOrder: "asc" },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger
        .error`Error fetching poll options via Prisma for poll ID: ${pollId}. Error: ${errMsg}`;
      return [];
    }
  }

  /**
   * Inserts a batch of votes into the database as a single transaction.
   * The batch is rejected entirely (no partial acceptance) if the user has no voting power for the poll,
   * or if the number of votes in the batch combined with the user's already cast votes exceeds the user's allowed votes for the poll.
   *
   * @param pollId the ID of the poll the votes are being cast for.
   * @param userId the ID of the user casting the votes.
   * @param votes an array of VoteInsert objects representing the votes to be inserted, each containing a UUID, the ID of the chosen poll option, the previous hash, and the current hash.
   * @returns An object indicating the success of the operation, an optional error message if the operation failed, and an HTTP status code representing the result of the operation. Returns 200 on success, 403 if the user has no voting power, 400 if the user's quota is exceeded, and 500 for any other error.
   */
  public async insertVoteBatch(
    pollId: number,
    userId: number,
    votes: VoteInsert[],
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const eligibleVoter = await tx.pollEligibleVoter.findUnique({
          where: {
            pollId_userId: {
              pollId,
              userId,
            },
          },
          select: { votesAllowed: true },
        });

        const votesAllowed = eligibleVoter?.votesAllowed ?? 0;
        const alreadyCast = await tx.voteToken.count({
          where: { pollId, userId },
        });

        if (votesAllowed <= 0) {
          throw new Error("NO_VOTING_POWER");
        }

        // Does not have partial acceptance. If user tries to cast more votes than allowed, the entire batch is rejected?
        if (votes.length + alreadyCast > votesAllowed) {
          throw new Error("QUOTA_EXCEEDED");
        }

        for (const v of votes) {
          await tx.voteToken.create({
            data: {
              pollId,
              userId,
              uuid: v.UUID,
            },
          });

          await tx.vote.create({
            data: {
              id: v.UUID,
              pollId,
              pollOptionId: v.optionId,
              previousHash: v.previousHash,
              currentHash: v.currentHash,
            },
          });
        }
      });

      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      if (errMsg === "NO_VOTING_POWER") {
        return {
          success: false,
          errorMsg: "User has no voting power for this poll.",
          httpStatusCode: 403,
        };
      }

      if (errMsg === "QUOTA_EXCEEDED") {
        return {
          success: false,
          errorMsg: "Quota exceeded.",
          httpStatusCode: 400,
        };
      }

      logger
        .error`InsertVoteBatch failed for pollId ${pollId}. Error: ${errMsg}`;
      return {
        success: false,
        errorMsg: "Error while inserting vote",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Fetches the most recent vote hash for a given poll, used as the previous hash when inserting the next vote in the chain.
   * Votes are ordered by timestamp descending and then by id descending to break ties between votes cast in the same instant.
   *
   * @param pollId the ID of the poll for which the latest hash should be fetched.
   * @returns An object containing the latest hash (or `null` if no votes have been cast yet — the "genesis" case), an HTTP status code, and an optional error message if the operation failed. Returns 200 on success (including when no votes exist) and 500 if an error occurs during fetching.
   */
  public async getLatestHash(
    pollId: number,
  ): Promise<{
    hash: string | null;
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const sqlResult = await this.prisma.vote.findFirst({
        where: { pollId },
        select: { currentHash: true },
        orderBy: [
          { timestamp: "desc" },
          { id: "desc" },
        ],
      });

      if (!sqlResult) {
        // Ingen stemmer endnu → "genesis" — første stemme i kæden
        return { hash: null, httpStatusCode: 200 };
      }

      return { hash: sqlResult.currentHash, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error fetching latest hash for poll ID: ${pollId}. Error: ${errMsg}`;
      return {
        hash: null,
        errorMsg: "Error fetching latest hash.",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Inserts a new entry into the audit log table.
   *
   * @param action a short string describing the action being logged.
   * @param details optional additional details about the action, or `null` if no further context is needed.
   * @returns An object indicating the success of the operation, an optional error message if the operation failed, and an HTTP status code representing the result of the operation. Returns 200 on success and 500 if an error occurs during insertion.
   */
  public async insertAuditLog(
    action: string,
    details: string | null,
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action,
          details,
        },
      });

      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while inserting audit log with action: ${action}, Error: ${errMsg}`;
      return {
        success: false,
        errorMsg: "Error while inserting audit log",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Fetches all entries from the audit log table.
   * Entries are ordered by timestamp descending and then by id descending to break ties between entries logged in the same instant.
   *
   * @returns An object containing an array of AuditLogEntry objects, an HTTP status code, and an optional error message if the operation failed. Returns 200 on success (with an empty array if no entries exist) and 500 if an error occurs during fetching, in which case `logs` is an empty array.
   */
  public async getAuditLog(): Promise<{
    logs: AuditLogEntry[];
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const logs = await this.prisma.auditLog.findMany({
        select: {
          id: true,
          action: true,
          timestamp: true,
          details: true,
        },
        orderBy: [
          { timestamp: "desc" },
          { id: "desc" },
        ],
      });
      return {
        logs: logs.map((log) => ({
          id: log.id,
          action: log.action,
          timestamp: log.timestamp.toString(), // This date type is the cause of the need for a map to assert types of SQL result.
          details: log.details,
        })),
        httpStatusCode: 200,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error fetching audit log. Error: ${errMsg}`;

      return {
        logs: [],
        errorMsg: "Error fetching audit log",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Lists all votes for a given poll, ordered chronologically (timestamp ascending, with id ascending as a tiebreaker).
   * The ascending order makes it possible to verify the hash chain from start to finish: each vote's `previousHash` must match the `currentHash` of the preceding vote.
   * Votes are only returned if the poll's `voteStatus` is `"finished"`; otherwise the votes are considered private until voting closes.
   *
   * @param pollId the ID of the poll for which the votes should be listed.
   * @returns An object containing an array of Vote objects, an HTTP status code, and an optional error message if the operation failed. Returns 200 on success, 404 if the poll does not exist, 403 if the poll is not finished yet, and 500 if an error occurs during fetching. In all non-success cases `votes` is an empty array.
   */
  public async listVotesForPoll(pollId: number): Promise<{
    votes: Vote[];
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const poll = await this.prisma.poll.findUnique({
        where: { id: pollId },
        select: { voteStatus: true },
      });

      if (!poll) {
        return { votes: [], errorMsg: "Poll not found", httpStatusCode: 404 };
      }

      // Must return forbidden if voteStatus is not finished.
      if (poll.voteStatus !== "finished") {
        return {
          votes: [],
          errorMsg:
            "Polls is not finished - votes are not public until voting closes",

          httpStatusCode: 403,
        };
      }
      const sqlResults = await this.prisma.vote.findMany({
        where: { pollId },
        select: {
          id: true,
          pollId: true,
          pollOptionId: true,
          timestamp: true,
          previousHash: true,
          currentHash: true,
        },
        orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      });

      const votes: Vote[] = sqlResults.map((row) => ({
        id: row.id,
        pollId: row.pollId,
        pollOptionId: row.pollOptionId,
        timestamp: row.timestamp.toString(), // This date type is the cause of the need for a map to assert types of SQL result.
        previousHash: row.previousHash,
        currentHash: row.currentHash,
      }));

      return { votes, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error listing votes for poll ID: ${pollId}. Error: ${errMsg}`;
      return {
        votes: [],
        errorMsg: "Error listing votes",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Aggregates the vote counts for each option in a given poll, by grouping the `vote` table on `pollOptionId`.
   * Options with zero votes are not included in the result — callers that need a complete list (e.g. for displaying every option even when no one voted for it) should join this with `getPollOptionsFromDB`.
   * Access control (e.g. only exposing counts when the poll is finished) is the responsibility of the caller, not this function.
   *
   * @param pollId the ID of the poll for which the result counts should be aggregated.
   * @returns Promise<{ optionId: number; count: number }[]> a promise that resolves to an array of objects, each containing the ID of an option and the number of votes cast for it. Returns an empty array if no votes exist or if an error occurs during fetching.
   */
  public async getPollResultCounts(
    pollId: number,
  ): Promise<{ optionId: number; count: number }[]> {
    try {
      const rows = await this.prisma.vote.groupBy({
        by: ["pollOptionId"],
        where: { pollId },
        _count: { _all: true },
      });

      return rows.map((r) => ({
        optionId: r.pollOptionId,
        count: r._count._all,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error fetching poll result counts for poll ID: ${pollId}. Error: ${errMsg}`;
      return [];
    }
  }

  /**
   * Checks whether a given user is eligible to vote in a given poll by looking up an entry in the `pollEligibleVoter` table.
   * On error the function fails safely by returning `false`, so access is denied rather than accidentally granted.
   *
   * @param pollId the ID of the poll to check eligibility for.
   * @param userId the ID of the user whose eligibility is being checked.
   * @returns Promise<boolean> a promise that resolves to `true` if the user has an eligibility entry for the poll, and `false` otherwise (including when an error occurs during the lookup).
   */
  public async isUserEligible(
    pollId: number,
    userId: number,
  ): Promise<boolean> {
    try {
      const sqlResult = await this.prisma.pollEligibleVoter.findUnique({
        where: {
          pollId_userId: {
            pollId,
            userId,
          },
        },
        select: { pollId: true },
      });

      return sqlResult !== null;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Uknown error";
      logger
        .error`Error checking eligibility for poll ID: ${pollId}, user ID: ${userId}. Error: ${errMsg}`;
      return false; // Fail-safe: on error refuse to access to the poll.
    }
  }

  /**
   * Unsafe function to run custom SQL on the database, use with caution.
   * This function was for testing and debugging purposes but have not been translated into prisma yet,
   * as the entire testing database setup is not yet migrated.
   *
   * @param customSQL A custom SQL statements to be run on the database.
   */
  // public runCustomSQL(customSQL: string) {
  //   logger.info`Running custom SQL statement: \n ${customSQL}`;
  //   this.DB.exec(customSQL);
  // }

  /**
   * Returns the number of votes a given user is allowed to cast in a given poll, based on the `votesAllowed` field of the user's `pollEligibleVoter` entry.
   * On error or if the user has no eligibility entry for the poll, the function returns 0 as a fail-safe to prevent accidentally granting voting power.
   *
   * @param pollId the ID of the poll to check the allowed vote count for.
   * @param userId the ID of the user whose allowed vote count is being looked up.
   * @returns Promise<number> a promise that resolves to the number of votes the user is allowed to cast. Returns 0 if the user has no eligibility entry or if an error occurs during fetching.
   */
  public async getVotesAllowed(
    pollId: number,
    userId: number,
  ): Promise<number> {
    try {
      const sqlResult = await this.prisma.pollEligibleVoter.findUnique({
        where: {
          pollId_userId: {
            pollId,
            userId,
          },
        },
        select: { votesAllowed: true },
      });
      if (!sqlResult) {
        return 0;
      }
      return sqlResult.votesAllowed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error getting number of votes allowed for poll ID: ${pollId}, user ID: ${userId}. Error: ${errMsg}`;
      return 0;
    }
  }

  /**
   * Returns the number of votes a given user has already cast in a given poll, by counting the user's entries in the `voteToken` table.
   * Used together with `getVotesAllowed` to determine how many votes the user has remaining before reaching their quota.
   *
   * @param pollId the ID of the poll to count cast votes for.
   * @param userId the ID of the user whose cast votes are being counted.
   * @returns Promise<number> a promise that resolves to the number of votes the user has already cast for the poll. Returns 0 if an error occurs during fetching.
   */
  public async countCastVotes(
    pollId: number,
    userId: number,
  ): Promise<number> {
    try {
      const count = await this.prisma.voteToken.count({
        where: { pollId, userId },
      });
      return count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error getting number of votes casted for poll ID: ${pollId}, user ID: ${userId}. Error: ${errMsg}`;
      return 0;
    }
  }

  /**
   * Calculate the vote progress based on entries in eligble voters.
   *
   * @param pollId - The id of the poll to get progress report on.
   */
  public async getVoteProgress(
    pollId: number,
  ): Promise<string> {
    const totalEligible = await this.prisma.pollEligibleVoter.count({
      where: { pollId: pollId },
    });
    const ballotsCast = await this.prisma.vote.count({
    	where: {pollId},
    });

    return `${ballotsCast}/${totalEligible}`;
  }

  /**
   * Henter alle afstemninger fra databasen og beregner ekstra info til oversigts-siden:
   * - Om den indloggede bruger har stemt (hasVoted)
   * - Om brugeren er stemmeberettiget (isEligible)
   * - Tid tilbage til deadline formateret som "TT:MM:SS"
   * - Stemmefremdrift som "afgivne/totale" f.eks. "3/14"
   *
   * @param userId ID på den indloggede bruger
   */
  public async getFrontEndPollObj(userId: number): Promise<FrontEndPoll[]> {
    try {
      // Fetch all polls for a user, but only votes they are allowed to see!
      const polls = await this.prisma.poll.findMany({
        include: {
          // Hent ejers brugernavn i stedet for blot userId
          creator: { select: { username: true } },
          // Brug til at tælle unikke stemmeafgivere
          voteTokens: { select: { userId: true } },
          // Tjek om den indloggede bruger er stemmeberettiget
          eligibleVoters: {
            where: { userId },
            select: { userId: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return await Promise.all(polls.map(async (poll) => {
        // Tjek om den indloggede bruger har stemt
        const userVoteCount = await this.prisma.voteToken.count({
          where: { pollId: poll.id, userId },
        });

        const result: FrontEndPoll = {
          poll: {
            id: poll.id,
            title: poll.title,
            description: poll.description,
            status: poll.voteStatus as pollStatus,
            createdBy: poll.createdBy,
            createdAt: poll.createdAt.toString(),
            startsAt: poll.startsAt ? poll.startsAt.toString() : undefined,
            endsAt: poll.endsAt ? poll.endsAt.toString() : undefined,
            pollVisibility: poll.pollVisibility as pollVisibility | null,
            ballotPrivacy: poll.ballotPrivacy as ballotPrivacy | null,
            showTopN: poll.showTopN,
            ballotLimit: poll.ballotLimit,
            useBuffer: poll.useBuffer,
          },
          isUserEligibleVoter: poll.eligibleVoters.length > 0,
          hasVoted: userVoteCount > 0,
          pollProgress: await this.getVoteProgress(poll.id),
          timeLeft: "not initialized",
          pollOwnerUsername: poll.creator.username,
        };
        return result;
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error fetching all polls for userId ${userId}: ${errMsg}`;
      return [];
    }
  }

  /**
   * Looks up userIds for a list of usernames in a single query.
   * Used when creating a poll: the frontend submits voter usernames from
   * step 2, and the manager needs userIds to populate `PollEligibleVoter`.
   *
   * @param usernames the usernames to resolve.
   * @returns `userIds` for the names that exist, and `notFound` for any
   *   that did not match a User row, so callers can reject the request
   *   with a precise error instead of silently dropping voters.
   */
  public async getUsersByUsernames(
    usernames: string[],
  ): Promise<{
    users: Array<{ id: number; username: string }>;
    notFound: string[];
  }> {
    if (usernames.length === 0) return { users: [], notFound: [] };
    try {
      const found = await this.prisma.user.findMany({
        where: { username: { in: usernames } },
        select: { id: true, username: true },
      });
      const foundNames = new Set(found.map((u) => u.username));
      const notFound = usernames.filter((n) => !foundNames.has(n));
      return { users: found, notFound };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error looking up users by usernames. Error: ${errMsg}`;
      return { users: [], notFound: usernames };
    }
  }

  /**
   * Inserts a new poll, optionally along with its options and eligible
   * voters, in a single transaction. The three inserts are atomic: if any
   * step fails, nothing is persisted.
   *
   * Options and voters are both optional — a poll may be created on its
   * own and have them added later. Empty or missing `optionTexts` /
   * `voterUserIds` simply skip the corresponding insert.
   *
   * @param input the data needed to materialize the poll. `createdBy`
   *   must originate from a verified JWT, never from the request body.
   * @returns `{ pollId, httpStatusCode: 201 }` on success;
   *   `{ errorMsg, httpStatusCode: 500 }` if the transaction fails.
   */

  public async createPoll(input: PollCreateInput): Promise<{
    pollId?: number;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      const pollId = await this.prisma.$transaction(async (tx) => {
        const poll = await tx.poll.create({
          data: {
            title: input.title,
            description: input.description,
            voteStatus: input.voteStatus ?? "draft",
            createdBy: input.createdBy,
            startsAt: input.startsAt ? new Date(input.startsAt) : null,
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            pollVisibility: input.pollVisibility,
            ballotPrivacy: input.ballotPrivacy,
            showTopN: input.showTopN,
            ballotLimit: input.ballotLimit,
            useBuffer: input.useBuffer,
          },
        });

        if (input.optionTexts && input.optionTexts.length > 0) {
          await tx.pollOption.createMany({
            data: input.optionTexts.map((text, i) => ({
              pollId: poll.id,
              optionText: text,
              displayOrder: i,
            })),
          });
        }

        if (input.voterUserIds && input.voterUserIds.length > 0) {
          await tx.pollEligibleVoter.createMany({
            data: input.voterUserIds.map((userId) => ({
              pollId: poll.id,
              userId,
              votesAllowed: input.ballotLimit ?? 1,
            })),
          });
        }

        return poll.id;
      });

      return { pollId, httpStatusCode: 201 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error creating poll. Error: ${errMsg}`;
      return { errorMsg: "Error creating poll", httpStatusCode: 500 };
    }
  }

/**
 * Deletes the poll identified by 'pollId'. Cascades to related rows 
 * (options, eligible voters, votes) which are governed by the schema's 
 * foreign-key rules, not by this method. 
 *
 * @param pollId the id of the poll to delete.
 * @returns `httpStatuscode 200 on success; 500 if the delete fails - including 
 * 	the case where no poll with 'pollId' exists 
 */
  public async deletePoll(
    pollId: number,
  ): Promise<{ errorMsg?: string; httpStatusCode: ContentfulStatusCode }> {
    try {
      const DeletePoll = await this.prisma.poll.delete(
        { where: { id: pollId } },
      );

      return { httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown error";
      logger.error`Error while deleting poll. Error: ${errMsg}`;
      return { errorMsg: "Error while deleting poll", httpStatusCode: 500 };
    }
  }

  /** 
   * Looks up every eligible voter for a given poll along with how many
   * votes each is allowed to cast. Joins through 'pollEligibleVoter' so
   * the usernames come from the the 'user' table. 
   *
   * @param pollId the id of the poll whose eligible voters to fetch
   * @returns an array of '{username, votesAllowed}'. Empty if the poll has 
   * 	no eligible voters or does not exists. Errors are not caught and will 
   * 	propagte to the caller. 
   */
  public async getEligibleVoters(
    pollId: number,
  ): Promise<Array<{ username: string; votesAllowed: number }>> {
    const rows = await this.prisma.pollEligibleVoter.findMany({
      where: { pollId },
      select: {
        votesAllowed: true,
        user: { select: { username: true } },
      },
    });
    return rows.map((r) => ({
      username: r.user.username,
      votesAllowed: r.votesAllowed,
    }));
  }
/** 
 * Applies a partial update to a poll, optionally replacing its options
 * and/or eligible voters, in a single atomic transaction. The poll update,
 * options replacement, and voters replacement all succeed or all roll back
 * together. 
 *
 * Only fields explicitly set on 'input' are written; 'undefined' leaves
 * the existing value untouched, while 'null' clears it (where the column
 * allows it). 'startsAt' / 'endsAt' accept ISO strings and are converted 
 * to 'Date' 
 *
 * Options and voters are full replacements, not merges: if 'optionTexts' is 
 * provided, all existing options for the poll are deleted and recreated from 
 * the new array (an empty array clears them). The same applies to 'voters'.
 * If either field is 'undefined' the corresponding rows are left as-is. 
 *
 * @param pollId the id of the poll to update. 
 * @param input the fields to change. Per-voter 'votesAllowed' is taken directly 
 * 	form each entry in 'voters'
 * @returns httpstatuscode: 200 on success, 500 if the transaction fails. 
 */ 
  public async updatePoll(
    pollId: number,
    input: PollUpdateInput,
  ): Promise<{ errorMsg?: string; httpStatusCode: ContentfulStatusCode }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.PollUpdateInput = {};
        if (input.title !== undefined) data.title = input.title;
        if (input.description !== undefined) {
          data.description = input.description;
        }
        if (input.startsAt !== undefined) {
          data.startsAt = input.startsAt ? new Date(input.startsAt) : null;
        }
        if (input.endsAt !== undefined) {
          data.endsAt = input.endsAt ? new Date(input.endsAt) : null;
        }
        if (input.pollVisibility !== undefined) {
          data.pollVisibility = input.pollVisibility;
        }
        if (input.ballotPrivacy !== undefined) {
          data.ballotPrivacy = input.ballotPrivacy;
        }
        if (input.showTopN !== undefined) data.showTopN = input.showTopN;
        if (input.ballotLimit !== undefined) {
          data.ballotLimit = input.ballotLimit;
        }
        if (input.useBuffer !== undefined) data.useBuffer = input.useBuffer;
        if (input.voteStatus !== undefined) data.voteStatus = input.voteStatus;

        await tx.poll.update({ where: { id: pollId }, data });

        if (input.optionTexts !== undefined) {
          await tx.pollOption.deleteMany({ where: { pollId } });
          if (input.optionTexts.length > 0) {
            await tx.pollOption.createMany({
              data: input.optionTexts.map((text, i) => ({
                pollId,
                optionText: text,
                displayOrder: i,
              })),
            });
          }
        }

        if (input.voters !== undefined) {
          await tx.pollEligibleVoter.deleteMany({ where: { pollId } });
          if (input.voters.length > 0) {
            await tx.pollEligibleVoter.createMany({
              data: input.voters.map((v) => ({
                pollId,
                userId: v.userId,
                votesAllowed: v.votesAllowed,
              })),
            });
          }
        }
      });
      return { httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error updating poll. Error: ${errMsg}`;
      return { errorMsg: "Error updating poll", httpStatusCode: 500 };
    }
  }

  /**
   * Moves polls that has hit their time limit:
   * 	1. Polls in 'not started' whose 'startsAt' is now in the past 
   * 	   are moved to 'started'.
   * 	2. Polls in 'started' whose 'endsAt' is now in the past are 
   * 	   moved to 'finished'. 
   *
   * Both passes share the same 'now' timestamp so if a poll has already
   * passed it startsAt and endsAt will progress to 'finished' in a single call. 
   *
   * Errors are caught and logged: the method never throws: on failure
   * the returned counts are started: 0 finished: 0, which is indistringuishable
   * from a tick which just havent done anything - so it is required to check the logs
   * to tell them apart. 
   *
   * @returns number of rows changed (for logging/debuggin):
   */
  public async tickPollStatuses(): Promise<
    { started: number; finished: number }
  > {
    const now = new Date();
    try {
      const started = await this.prisma.poll.updateMany({
        where: {
          voteStatus: "not started",
          startsAt: { lte: now },
        },
        data: { voteStatus: "started" },
      });
      const finished = await this.prisma.poll.updateMany({
        where: {
          voteStatus: "started",
          endsAt: { lte: now },
        },
        data: { voteStatus: "finished" },
      });
      return { started: started.count, finished: finished.count };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error`tickPollStatuses failed: ${errMsg}`;
      return { started: 0, finished: 0 };
    }
  }

  /**
   * Fetches the id and username of every user in the database. Used to 
   * populate user pickers (e.g.  when assigning eligible voters to a poll), 
   * so the passwords and other sensitive columns are deliberately excluded 
   * from the projection. 
   *
   * @returns ' {users, httpStatuscode: 200}' on success. If the table is empty
   * 	'usersø is '[]' and errorMsg is set to a descriptive message - the status
   * 	is still 200 because an empty user list is not an error. On a qury failure, 'users'
   * 	is '[]', and errorMsg is set and the status is now 500. 
   */
  public async getAllUsersFromDB(): Promise<{
    users: { id: number; username: string }[];
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const users = await this.prisma.user.findMany({
        select: { id: true, username: true },
      });

      if (users.length === 0) {
        return {
          users: [],
          httpStatusCode: 200,
          errorMsg: "Didnt get users from DB",
        };
      }

      return {
        users: users,
        httpStatusCode: 200,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error fetching audit log. Error: ${errMsg}`;
      return {
        users: [],
        errorMsg: "Error fetching all users from DB",
        httpStatusCode: 500,
      };
    }
  }
}
