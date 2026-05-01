// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#password-hashing-algorithms
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
import * as argon2 from "npm:argon2@0.44.0"; // used for hashing
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";
import {
  ballotPrivacy,
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
  private constructor(adminPassword: string, databaseUrl = env.DATABASE_URL) {
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
    const dbInstance = new WebappDatabase(adminPassword, databaseUrl);
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
        title: sqlResult.title,
        description: sqlResult.description,
        voteStatus: sqlResult.voteStatus as pollStatus,
        createdBy: sqlResult.createdBy,
        createdAt: sqlResult.createdAt.toString(),
        startsAt: sqlResult.startsAt
          ? sqlResult.startsAt.toString()
          : undefined,
        endsAt: sqlResult.endsAt ? sqlResult.endsAt.toString() : undefined,
        pollVisibility: sqlResult.pollVisibility as pollVisibility,
        ballotPrivacy: sqlResult.ballotPrivacy as ballotPrivacy,
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
   * Inserts a batch of votes into the database.
   *
   * @param pollId
   * @param userId
   * @param votes
   * @returns An object indicating the success of the operation, an optional error message if the operation failed, and an HTTP status code representing the result of the operation.
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

  /*
    Jeg har valgt at simpelthen gøre det på "database" niveau at tjekke om pollStatus er finished, logikken kan evt alt flyttes et andet sted hen
    Har valgt at det skal være stigende grad istedet for faldende. For verifikation vil man gerne følge kæden fra start til slut: vote 1 --> vote 2 --> vote 3, hver stemmes previousHash skal matche den forriges currentHash.

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
   * Returns the number of votes a current User already has "cast"
   *
   * @param pollId
   * @param userId
   *
   * @returns the number of votes a current User already has "cast" for a given poll. Returns 0 if an error occurs during fetching.
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
   * Henter alle afstemninger fra databasen og beregner ekstra info til oversigts-siden:
   * - Om den indloggede bruger har stemt (hasVoted)
   * - Om brugeren er stemmeberettiget (isEligible)
   * - Tid tilbage til deadline formateret som "TT:MM:SS"
   * - Stemmefremdrift som "afgivne/totale" f.eks. "3/14"
   *
   * @param userId ID på den indloggede bruger
   */
  public async getAllPolls(userId: number): Promise<{
    id: number;
    title: string;
    status: "active" | "finished" | "not_started";
    voteProgress: string;
    timeLeft: string;
    isPublic: boolean;
    isAnonymous: boolean;
    owner: string;
    hasVoted: boolean;
    isEligible: boolean;
  }[]> {
    try {
      const polls = await this.prisma.poll.findMany({
        include: {
          // Hent ejers brugernavn i stedet for blot userId
          createdByUser: { select: { username: true } },
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
        // Oversæt Prisma voteStatus til frontend-format
        let status: "active" | "finished" | "not_started";
        if (poll.voteStatus === "started") status = "active";
        else if (poll.voteStatus === "finished") status = "finished";
        else status = "not_started";

        // Beregn tid tilbage til deadline
        let timeLeft = "00:00:00";
        if (poll.endsAt) {
          const diffMs = new Date(poll.endsAt).getTime() - Date.now();
          if (diffMs > 0) {
            const hours = Math.floor(diffMs / 3_600_000);
            const mins = Math.floor((diffMs % 3_600_000) / 60_000);
            const secs = Math.floor((diffMs % 60_000) / 1_000);
            timeLeft = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
          }
        }

        // Tæl totalt antal stemmeberettigede
        const totalEligible = await this.prisma.pollEligibleVoter.count({
          where: { pollId: poll.id },
        });

        // Tæl unikke brugere der har afgivet mindst én stemme
        const uniqueVoters = new Set(poll.voteTokens.map((v) => v.userId)).size;

        // Tjek om den indloggede bruger har stemt
        const userVoteCount = await this.prisma.voteToken.count({
          where: { pollId: poll.id, userId },
        });

        return {
          id: poll.id,
          title: poll.title,
          status,
          voteProgress: `${uniqueVoters}/${totalEligible}`,
          timeLeft,
          isPublic: poll.pollVisibility === "public",
          isAnonymous: poll.ballotPrivacy === "secret",
          owner: poll.createdByUser?.username ?? "ukendt",
          hasVoted: userVoteCount > 0,
          isEligible: poll.eligibleVoters.length > 0,
        };
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error fetching all polls for userId ${userId}: ${errMsg}`;
      return [];
    }
  }
}
