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

// Formats a Date as "YYYY-MM-DDTHH:MM:SS" in the server's local timezone.
// Why: the create-poll UI splits on "T" to pull dato/tid back into separate
// inputs, which broke when we returned the default Date.toString() format
// ("Mon May 18 2026 ...") — the "T" inside "Time" split that off as garbage.
function formatLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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
  uuid: string;
  signature: string | null; // null for open
  previousHash: string;
  currentHash: string;
}

// Open-batch insert: positionen er PRÆKÆDET i OpenPollManager (modsat secret,
// hvor finalizePollClose selv beregner chainPosition via startPosition + index).
export interface OpenVoteInsert {
  uuid: string;
  optionId: number;
  chainPosition: number;
  previousHash: string;
  currentHash: string;
}

export interface PendingVoteInsert {
  optionId: number;
  uuid: string;
  signature: string;
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
  // Per-poll blind-RSA keypair (PEM). See server_src/blindRsa.ts.
  // Public key is publishable; private key is server-only.
  blindRsaPublicKey?: string | null;
  blindRsaPrivateKey?: string | null;
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
    await this.prisma.user
      .upsert({
        where: { username: "admin" },
        update: {}, // Do not update if admin user already exists
        create: {
          username: "admin",
          passwordHash: adminPassword,
        },
      })
      .then(() => {
        logger.info("Admin user created or already exists in database.");
      })
      .catch((err: { message: string }) => {
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
        return 409; // user already present
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
  public async deleteUserFromDB(
    username: string,
  ): Promise<{ msg: string; statusCode: ContentfulStatusCode }> {
    try {
      await this.prisma.user.delete({ where: { username } });
      logger.info`Deleted user from database with username: ${username}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // If the user does not exist Prisma throws a `P2025` error; log as info.
      if ((err as Prisma.PrismaClientKnownRequestError)?.code === "P2025") {
        logger.info`User with username: ${username} not found while deleting.`;
        return { msg: "user not found", statusCode: 404 };
      }
      logger
        .error`Error deleting user with username: ${username}. Error: ${errMsg}`;
    }
    return { msg: "user successfully deleted", statusCode: 200 };
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
          ? formatLocalDatetime(sqlResult.startsAt)
          : undefined,
        endsAt: sqlResult.endsAt
          ? formatLocalDatetime(sqlResult.endsAt)
          : undefined,
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
  /** Checks to see if the vote is in vote or pending vote table.
   *
   * @param the UUID you are searching for
   * @returns Promise< exists: boolean
   */
  public async voteExistsInAnyVoteStore(uuid: string): Promise<{
    exists: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      const [vote, pendingVote] = await Promise.all([
        this.prisma.vote.findUnique({
          where: { id: uuid },
          select: { id: true },
        }),
        this.prisma.pendingVote.findUnique({
          where: { uuid },
          select: { uuid: true },
        }),
      ]);
      return {
        exists: vote !== null || pendingVote !== null,
        httpStatusCode: 200,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger
        .error`voteExistsInAnyVoteStore failed for uuid ${uuid}. Error: ${msg}`;
      return {
        exists: false,
        errorMsg: "Error while checking vote uniqueness",
        httpStatusCode: 500,
      };
    }
  }

  /** Inserts votes into pendinvVote table from the buffer. The votes should be shuffled before.
   *
   * @param pollId
   * @param votes: from the buffer
   * @returns success: boolean and httpStatusCode: 200 if success, 409 for vote already cast, 500 for error "uknown"
   */
  public async insertPendingVoteBatch(
    pollId: number,
    votes: PendingVoteInsert[],
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    if (votes.length === 0) return { success: true, httpStatusCode: 200 };
    try {
      await this.prisma.pendingVote.createMany({
        data: votes.map((vote) => ({
          id: crypto.randomUUID(),
          pollId,
          pollOptionId: vote.optionId,
          uuid: vote.uuid,
          signature: vote.signature,
        })),
      });
      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("P2002") || msg.includes("Unique constraint")) {
        return {
          success: false,
          errorMsg: "Vote already cast",
          httpStatusCode: 409,
        };
      }
      logger
        .error`insertPendingVoteBatch failed for pollId ${pollId}. Error: ${msg}`;
      return {
        success: false,
        errorMsg: "Error while inserting pending vote batch",
        httpStatusCode: 500,
      };
    }
  }

  /** returns all votes specific to a poll in pendingvote table
   * @param the pollId for the wanted votes
   * @returns Promise with votes: array with all the votes, httpstatuscode: 200 if success, 500 if err together with a err msg.
   */
  public async listPendingVotesForPoll(
    pollId: number,
  ): Promise<{
    votes: PendingVoteInsert[];
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const rows = await this.prisma.pendingVote.findMany({
        where: { pollId },
        select: {
          pollOptionId: true,
          uuid: true,
          signature: true,
        },
      });
      return {
        votes: rows.map((row) => ({
          optionId: row.pollOptionId,
          uuid: row.uuid,
          signature: row.signature,
        })),
        httpStatusCode: 200,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger
        .error`listPendingVotesForPoll failed for pollId ${pollId}. Error: ${msg}`;
      return {
        votes: [],
        errorMsg: "Error while listing pending votes",
        httpStatusCode: 500,
      };
    }
  }
  /**
   * Finalizes poll closure: inserts remaining votes into the hash chain, clears
   pending votes,
   * and marks the poll as finished with its close commitment and timestamp
  proof.
   *
   * @param pollId - ID of the poll being closed.
   * @param votes - Votes to append to the chain, in order.
   * @param closeCommitment - Commitment hash sealing the final chain state.
   * @param closeTimestampQuery - timestamp query bytes for the close
  commitment.
   * @param closeTimestampToken - timestamp token bytes returned by the
   TSA.
   * @param closedAt - Timestamp marking when the poll was closed.
   * @returns Success flag, optional error message, and HTTP status code.
   */
  public async finalizePollClose(
    pollId: number,
    votes: VoteInsert[],
    closeCommitment: string,
    closeTimestampQuery: Uint8Array<ArrayBufferLike>,
    closeTimestampToken: Uint8Array<ArrayBufferLike>,
    closedAt: Date,
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const latest = await tx.vote.findFirst({
          where: { pollId },
          select: { chainPosition: true },
          orderBy: { chainPosition: "desc" },
        });
        const startPosition = (latest?.chainPosition ?? 0) + 1;

        if (votes.length > 0) {
          await tx.vote.createMany({
            data: votes.map((vote, index) => ({
              id: vote.uuid,
              pollId,
              pollOptionId: vote.optionId,
              chainPosition: startPosition + index,
              signature: vote.signature,
              previousHash: vote.previousHash,
              currentHash: vote.currentHash,
            })),
          });
        }

        await tx.pendingVote.deleteMany({ where: { pollId } });

        await tx.poll.update({
          where: { id: pollId },
          data: {
            voteStatus: "finished",
            closeCommitment,
            closeTimestampQuery: new Uint8Array(closeTimestampQuery),
            closeTimestampToken: new Uint8Array(closeTimestampToken),
            closedAt,
          },
        });
      });

      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger
        .error`finalizePollClose failed for pollId ${pollId}. Error: ${msg}`;
      return {
        success: false,
        errorMsg: "Error while finalizing poll close",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Returns the PEM-encoded blind-RSA public key for a poll, or null if
   * the poll does not exist or has no key. Used by the cast endpoint to
   * verify signatures, and by `/open` to ship the key to the client.
   */
  public async getPollPublicKey(pollId: number): Promise<string | null> {
    try {
      const result = await this.prisma.poll.findUnique({
        where: { id: pollId },
        select: { blindRsaPublicKey: true },
      });
      return result?.blindRsaPublicKey ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error fetching public key for pollId ${pollId}: ${msg}`;
      return null;
    }
  }

  /**
   * Fetches the close artifacts for a finished poll: the close commitment and
  its timestamp query/token, along with the close timestamp.
   * @param pollId - ID of the poll to fetch artifacts for.
   * @returns Close commitment, timestamp query/token bytes, closedAt, and HTTP
  status code;
   *          fields are null and status is 404 if the poll does not exist.
   */
  public async getPollCloseArtifacts(pollId: number): Promise<{
    closeCommitment: string | null;
    closeTimestampQuery: Uint8Array<ArrayBuffer> | null;
    closeTimestampToken: Uint8Array<ArrayBuffer> | null;
    closedAt: string | null;
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const poll = await this.prisma.poll.findUnique({
        where: { id: pollId },
        select: {
          closeCommitment: true,
          closeTimestampQuery: true,
          closeTimestampToken: true,
          closedAt: true,
        },
      });
      if (!poll) {
        return {
          closeCommitment: null,
          closeTimestampQuery: null,
          closeTimestampToken: null,
          closedAt: null,
          errorMsg: "Poll not found",
          httpStatusCode: 404,
        };
      }
      return {
        closeCommitment: poll.closeCommitment,
        closeTimestampQuery: poll.closeTimestampQuery
          ? new Uint8Array(poll.closeTimestampQuery)
          : null,
        closeTimestampToken: poll.closeTimestampToken
          ? new Uint8Array(poll.closeTimestampToken)
          : null,
        closedAt: poll.closedAt ? poll.closedAt.toString() : null,
        httpStatusCode: 200,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error`Error fetching close artifacts for pollId ${pollId}: ${msg}`;
      return {
        closeCommitment: null,
        closeTimestampQuery: null,
        closeTimestampToken: null,
        closedAt: null,
        errorMsg: "Error fetching poll close artifacts",
        httpStatusCode: 500,
      };
    }
  }
  /**
   * Fetches timestamp query bytes stored for a closed poll.
   *
   * @param pollId - ID of the poll to fetch the timestamp query for.
   * @returns Timestamp query bytes (or null if missing/not found) and HTTP
  status code;         status is 404 if the poll does not exist.
  */
  public async getPollTimestampQuery(pollId: number): Promise<{
    timestampQuery: Uint8Array<ArrayBuffer> | null;
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const poll = await this.prisma.poll.findUnique({
        where: { id: pollId },
        select: { closeTimestampQuery: true },
      });

      if (!poll) {
        return {
          timestampQuery: null,
          errorMsg: "Poll not found",
          httpStatusCode: 404,
        };
      }

      return {
        timestampQuery: poll.closeTimestampQuery
          ? new Uint8Array(poll.closeTimestampQuery)
          : null,
        httpStatusCode: 200,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error`Error fetching timestamp query for pollId ${pollId}: ${msg}`;
      return {
        timestampQuery: null,
        errorMsg: "Error fetching timestamp query",
        httpStatusCode: 500,
      };
    }
  }
  /**
   * Fetches timestamp token bytes stored for a closed poll.
   *
   * @param pollId - ID of the poll to fetch the timestamp token for.
   * @returns Timestamp token bytes (or null if missing/not found) and HTTP
  status code;
   *          status is 404 if the poll does not exist.
   */
  public async getPollTimestampToken(pollId: number): Promise<{
    timestampToken: Uint8Array<ArrayBuffer> | null;
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const poll = await this.prisma.poll.findUnique({
        where: { id: pollId },
        select: { closeTimestampToken: true },
      });

      if (!poll) {
        return {
          timestampToken: null,
          errorMsg: "Poll not found",
          httpStatusCode: 404,
        };
      }

      return {
        timestampToken: poll.closeTimestampToken
          ? new Uint8Array(poll.closeTimestampToken)
          : null,
        httpStatusCode: 200,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error`Error fetching timestamp token for pollId ${pollId}: ${msg}`;
      return {
        timestampToken: null,
        errorMsg: "Error fetching timestamp token",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Fetches the most recent vote hash for a given poll, used as the previous hash when inserting the next vote in the chain.
   * Votes are ordered by their public hash-chain position.
   *
   * @param pollId the ID of the poll for which the latest hash should be fetched.
   * @returns An object containing the latest hash (or `null` if no votes have been cast yet — the "genesis" case), an HTTP status code, and an optional error message if the operation failed. Returns 200 on success (including when no votes exist) and 500 if an error occurs during fetching.
   */
  public async getLatestHash(pollId: number): Promise<{
    hash: string | null;
    chainposition: number | null;
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const sqlResult = await this.prisma.vote.findFirst({
        where: { pollId },
        select: { currentHash: true, chainPosition: true },
        orderBy: { chainPosition: "desc" },
      });

      if (!sqlResult) {
        // Ingen stemmer endnu → "genesis" — første stemme i kæden
        return { hash: null, chainposition: null, httpStatusCode: 200 };
      }

      return {
        hash: sqlResult.currentHash,
        chainposition: sqlResult.chainPosition,
        httpStatusCode: 200,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error fetching latest hash for poll ID: ${pollId}. Error: ${errMsg}`;
      return {
        hash: null,
        chainposition: null,
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
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
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
   * Lists all votes for a given poll, ordered by public hash-chain position.
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
          userId: true,
          timestamp: true,
          chainPosition: true,
          previousHash: true,
          currentHash: true,
          signature: true,
        },
        orderBy: { chainPosition: "asc" },
      });

      const votes: Vote[] = sqlResults.map((row) => ({
        id: row.id,
        pollId: row.pollId,
        pollOptionId: row.pollOptionId,
        userId: row.userId,
        timestamp: row.timestamp.toString(),
        chainPosition: row.chainPosition,
        previousHash: row.previousHash,
        currentHash: row.currentHash,
        signature: row.signature,
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
   * Returns the number of blind signatures already issued to this USER for
   * this poll. Replaces the old `countCastVotes` — after the blind-RSA
   * redesign there is no userId on `Vote` rows, so "how many has this user
   * cast" is no longer a meaningful server-side question. The closest
   * approximation is "how many signatures has this user claimed?", which
   * is tracked atomically in `PollEligibleVoter.signaturesIssued`.
   *
   * Useful for "votes remaining" display logic and as the quota proxy.
   *
   * @param pollId the ID of the poll.
   * @param userId the ID of the user.
   * @returns count of signatures issued, or 0 on error/missing eligibility.
   */
  public async countSignaturesIssued(
    pollId: number,
    userId: number,
  ): Promise<number> {
    try {
      const row = await this.prisma.pollEligibleVoter.findUnique({
        where: { pollId_userId: { pollId, userId } },
        select: { signaturesIssued: true },
      });
      return row?.signaturesIssued ?? 0;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error counting signaturesIssued for pollId ${pollId}, userId ${userId}: ${errMsg}`;
      return 0;
    }
  }
  /**
   * Sums `votesAllowed` across all eligible voters for a poll, giving the total
   * number of votes that may be cast.
   *
   * @param pollId - ID of the poll to count allowed votes for.
   * @returns Total allowed votes, or 0 if none exist or an error occurs.
   */
  public async countTotalVotesAllowed(pollId: number): Promise<number> {
    try {
      const result = await this.prisma.pollEligibleVoter.aggregate(
        { where: { pollId }, _sum: { votesAllowed: true } },
      );
      return result._sum.votesAllowed ?? 0;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error counting totalVotesAllowed for pollId ${pollId}: ${errMsg}`;
      return 0;
    }
  }
  /**
   * Counts the number of votes currently sitting in `pendingVote` for a poll
   * (i.e. received but not yet finalized into the hash chain).
   *
   * @param pollId - ID of the poll to count pending votes for.
   * @returns Number of pending votes, or 0 if none exist or an error occurs.
   */
  public async countReceivedVotes(pollId: number): Promise<number> {
    try {
      const rows = await this.prisma.pendingVote.aggregate({
        where: { pollId },
        _count: { _all: true },
      });
      return rows._count._all;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error counting received votes in pending for pollId ${pollId}: ${errMsg}`;
      return 0;
    }
  }

  /**
   * Sums `signaturesIssued` across all eligible voters for a poll, giving the
   * total number of blind signatures handed out.
   *
   * @param pollId - ID of the poll to count issued signatures for.
   * @returns Total issued signatures, or 0 if none exist or an error occurs.
   */
  public async countIssuedSignatures(pollId: number): Promise<number> {
    try {
      const result = await this.prisma.pollEligibleVoter.aggregate({
        where: { pollId },
        _sum: { signaturesIssued: true },
      });
      return result._sum.signaturesIssued ?? 0;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error counting issued signatures for pollId ${pollId}: ${errMsg}`;
      return 0;
    }
  }
  /**
   * Counts all persisted votes for a poll, combining finalized votes in `vote`
   * and not-yet-finalized votes in `pendingVote`.
   *
   * @param pollId - ID of the poll to count persisted votes for.
   * @returns Total persisted votes (final + pending), or 0 if none exist or an
  error occurs.
   */
  public async countPersistedVotes(pollId: number): Promise<number> {
    try {
      const [finalVotes, pendingVotes] = await Promise.all([
        this.prisma.vote.count({ where: { pollId } }),
        this.prisma.pendingVote.count({ where: { pollId } }),
      ]);
      return finalVotes + pendingVotes;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error counting persisted votes for pollId ${pollId}: ${errMsg}`;
      return 0;
    }
  }
  /**
   * Marks a poll as invalidated (e.g. due to vote loss or integrity failure)
  and
   * writes a `POLL_INVALIDATED_VOTE_LOSS` entry to the audit log.
   *
   * @param pollId - ID of the poll to invalidate.
   * @param reason - Human-readable reason recorded in the audit log.
   * @returns Success flag, optional error message, and HTTP status code.
   */
  public async markPollInvalidated(
    pollId: number,
    reason: string,
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      await this.prisma.poll.update({
        where: { id: pollId },
        data: {
          voteStatus: "invalidated",
        },
      });

      await this.insertAuditLog(
        "POLL_INVALIDATED_VOTE_LOSS",
        `pollId:${pollId}, reason:${reason}`,
      );

      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error invalidating poll ${pollId}: ${errMsg}`;
      return {
        success: false,
        errorMsg: "Error invalidating poll",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Calculate the vote progress based on entries in eligble voters.
   *
   * @param pollId - The id of the poll to get progress report on.
   */
  public async getVoteProgress(pollId: number): Promise<string> {
    const eligibleVotes = await this.prisma.pollEligibleVoter.aggregate({
      where: { pollId },
      _sum: { votesAllowed: true },
    });
    const totalEligibleVotes = eligibleVotes._sum.votesAllowed ?? 0;
    const ballotsCast = await this.prisma.vote.count({
      where: { pollId },
    });
    const ballotsPending = await this.prisma.pendingVote.count({
      where: { pollId },
    });

    return `${ballotsCast + ballotsPending}/${totalEligibleVotes}`;
  }
  /**
   * Fetches all polls visible to the user and enriches each with view-model
  fields
   * for the overview page: eligibility, a `hasVoted` proxy based on issued
   * signatures vs. votes allowed, the owner's username, and a vote-progress
  string.
   *
   * Visibility rules: drafts are only included for their creator; private polls
   * are only shown to the creator, eligible voters, and admins.
   *
   * Note: since VoteToken was removed, `Vote` rows can no longer be linked back
   to
   * a `userId`. `hasVoted` is therefore approximated by checking whether the
  user
   * has used their full signature issuance quota.
   *
   * @param userId - ID of the logged-in user (used for eligibility and
  visibility checks).
   * @param isAdmin - If true, bypasses visibility filtering and returns all
  non-draft polls plus the user's own drafts.
   * @returns Array of `FrontEndPoll` view models, or an empty array on error.
   */
  public async getFrontEndPollObj(
    userId: number,
    isAdmin: boolean,
  ): Promise<FrontEndPoll[]> {
    try {
      // Private polls are only visible to the creator, eligible voters,
      // and admin. Admin sees everything.
      const visibilityFilter = isAdmin ? {} : {
        OR: [
          { pollVisibility: "public" },
          { createdBy: userId },
          { eligibleVoters: { some: { userId } } },
        ],
      };

      // Fetch all polls for a user, but only votes they are allowed to see!
      const polls = await this.prisma.poll.findMany({
        where: {
          AND: [
            {
              OR: [
                { voteStatus: { not: "draft" } }, //include all poll where status is not draft
                { createdBy: userId }, // but include the drafted polls which is createdBy the user.
              ],
            },
            visibilityFilter,
          ],
        },
        include: {
          creator: { select: { username: true } },
          eligibleVoters: {
            where: { userId },
            select: {
              userId: true,
              votesAllowed: true,
              signaturesIssued: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return await Promise.all(polls.map(async (poll) => {
        const myEligibility = poll.eligibleVoters[0];
        const hasVoted = !myEligibility
          ? false
          : poll.ballotPrivacy === "open"
          ? await this.countCastVotesByUser(poll.id, userId) >=
            myEligibility.votesAllowed
          : myEligibility.signaturesIssued >= myEligibility.votesAllowed;

        const result: FrontEndPoll = {
          poll: {
            id: poll.id,
            title: poll.title,
            description: poll.description,
            status: poll.voteStatus as pollStatus,
            createdBy: poll.createdBy,
            createdAt: poll.createdAt.toString(),
            startsAt: poll.startsAt
              ? formatLocalDatetime(poll.startsAt)
              : undefined,
            endsAt: poll.endsAt ? formatLocalDatetime(poll.endsAt) : undefined,
            pollVisibility: poll.pollVisibility as pollVisibility | null,
            ballotPrivacy: poll.ballotPrivacy as ballotPrivacy | null,
            showTopN: poll.showTopN,
            ballotLimit: poll.ballotLimit,
            useBuffer: poll.useBuffer,
          },
          isUserEligibleVoter: myEligibility !== undefined,
          hasVoted,
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
  public async getUsersByUsernames(usernames: string[]): Promise<{
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
            blindRsaPublicKey: input.blindRsaPublicKey,
            blindRsaPrivateKey: input.blindRsaPrivateKey,
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
      await this.prisma.poll.delete({
        where: { id: pollId },
      });

      return { httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "unknown error";
      logger.error`Error while deleting poll. Error: ${errMsg}`;
      return { errorMsg: "Error while deleting poll", httpStatusCode: 500 };
    }
  }

  /**
   * Atomically issues a blind signature for a user on a poll.
   *
   * Wraps quota check, counter increment, and the crypto signing in a
   * single Prisma transaction so that none of them can be observed
   * partially: if any step throws, the `signaturesIssued` increment is
   * rolled back and the user keeps their quota.
   *
   * The crypto step is passed in as a callback because the database layer
   * does not own `blindRsa.ts`. The callback receives the poll's private
   * key (PEM) and returns the base64 blind signature.
   *
   * @param pollId the poll to issue under.
   * @param userId the eligible voter making the request.
   * @param sign   callback that performs the actual blind signing.
   * @returns `{ blindSignatureB64, httpStatusCode: 200 }` on success;
   *   `{ errorMsg, httpStatusCode }` on failure — `403` if the user is
   *   not eligible / quota exhausted / poll not open, `404` if the poll
   *   does not exist, `500` if the poll has no signing key or the DB
   *   layer errors out.
   */
  public async issueBlindSignature(
    pollId: number,
    userId: number,
    sign: (privateKeyPem: string) => Promise<string>,
  ): Promise<{
    blindSignatureB64?: string;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      const blindSignatureB64 = await this.prisma.$transaction(async (tx) => {
        const eligible = await tx.pollEligibleVoter.findUnique({
          where: { pollId_userId: { pollId, userId } },
          select: { votesAllowed: true, signaturesIssued: true },
        });
        if (!eligible) throw new Error("NOT_ELIGIBLE");
        if (eligible.signaturesIssued >= eligible.votesAllowed) {
          throw new Error("QUOTA_EXHAUSTED");
        }

        const poll = await tx.poll.findUnique({
          where: { id: pollId },
          select: { voteStatus: true, blindRsaPrivateKey: true },
        });
        if (!poll) throw new Error("POLL_NOT_FOUND");
        if (poll.voteStatus !== "started") throw new Error("POLL_NOT_OPEN");
        if (!poll.blindRsaPrivateKey) throw new Error("NO_SIGNING_KEY");

        await tx.pollEligibleVoter.update({
          where: { pollId_userId: { pollId, userId } },
          data: { signaturesIssued: { increment: 1 } },
        });

        return await sign(poll.blindRsaPrivateKey);
      });

      return { blindSignatureB64, httpStatusCode: 200 };
    } catch (err) {
      const code = err instanceof Error ? err.message : "UNKNOWN";
      switch (code) {
        case "NOT_ELIGIBLE":
          return {
            errorMsg: "User not eligible for this poll",
            httpStatusCode: 403,
          };
        case "QUOTA_EXHAUSTED":
          return { errorMsg: "Signature quota exhausted", httpStatusCode: 403 };
        case "POLL_NOT_FOUND":
          return { errorMsg: "Poll not found", httpStatusCode: 404 };
        case "POLL_NOT_OPEN":
          return {
            errorMsg: "Poll is not open for voting",
            httpStatusCode: 403,
          };
        case "NO_SIGNING_KEY":
          return { errorMsg: "Poll has no signing key", httpStatusCode: 500 };
        default:
          logger
            .error`Error issuing blind signature for poll ID: ${pollId}, user ID: ${userId}. Error: ${code}`;
          return {
            errorMsg: "Error issuing blind signature",
            httpStatusCode: 500,
          };
      }
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
   * Moves polls in 'not started' whose 'startsAt' is now in the past to
   * 'started'. Finishing polls is handled by PollManager so buffered and
   * pending votes can be drained before `voteStatus` becomes "finished".
   *
   * Errors are caught and logged: the method never throws: on failure
   * the returned counts are started: 0 finished: 0, which is indistringuishable
   * from a tick which just havent done anything - so it is required to check the logs
   * to tell them apart.
   *
   * @returns number of rows changed (for logging/debuggin):
   */
  public async tickPollStatuses(): Promise<{
    started: number;
    finished: number;
  }> {
    const now = new Date();
    try {
      const started = await this.prisma.poll.updateMany({
        where: {
          voteStatus: "not started",
          startsAt: { lte: now },
        },
        data: { voteStatus: "started" },
      });
      return { started: started.count, finished: 0 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error`tickPollStatuses failed: ${errMsg}`;
      return { started: 0, finished: 0 };
    }
  }
  /**
   * Returns the IDs of all polls that have passed `endsAt` and are still in a
   * closeable lifecycle state.
   *
   * Includes both `started` polls that need their first close attempt and
   * `closing` polls where a previous close attempt failed and should be
   * retried.
   *
   * @returns Array of poll IDs ready to finish, or an empty array on error.
   */

  public async getPollIdsReadyToFinish(): Promise<number[]> {
    try {
      const rows = await this.prisma.poll.findMany({
        where: {
          voteStatus: { in: ["started", "closing"] },
          endsAt: { lte: new Date() },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error`getPollIdsReadyToFinish failed: ${errMsg}`;
      return [];
    }
  }
  /**
   * Returns the IDs of all polls currently in the `started` state, regardless
  of
   * their `endsAt`.
   *
   * @returns Array of started poll IDs, or an empty array on error.
   */
  public async listStartedPollIds(): Promise<number[]> {
    try {
      const polls = await this.prisma.poll.findMany({
        where: { voteStatus: "started" },
        select: { id: true },
      });
      return polls.map((poll) => poll.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error listing started polls: ${errMsg}`;
      return [];
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
        orderBy: {
          id: "asc",
        },
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

  /**
   * Fetches the list of eligible voters for a given poll, returning their userIds.
   *
   * @param pollId - the ID of the poll to fetch eligible voters for.
   * @returns An object containing an array of voter userIds, an HTTP status code, and an optional error message if the operation failed. Returns 200 on success (with an empty array if no eligible voters exist) and 500 if an error occurs during fetching, in which case `voters` is an empty array.
   */
  public async getAllEligibleVotersForPoll(pollId: number): Promise<{
    voters: { userId: number }[];
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const voters = await this.prisma.pollEligibleVoter.findMany({
        where: { pollId },
        select: { userId: true },
      });
      return { voters, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error fetching eligible voters for poll ID: ${pollId}. Error: ${errMsg}`;
      return {
        voters: [],
        errorMsg: "Error fetching eligible voters",
        httpStatusCode: 500,
      };
    }
  }

  /**
   * Returns every eligible voter for a poll with their `signaturesIssued`
   * count. Used by the results page to derive non-voters: for secret polls
   * (anonymous) the only available signal is `signaturesIssued === 0`; for
   * open polls the caller compares `userId` against the `Vote` table.
   */
  public async getEligibleVoterStatuses(
    pollId: number,
  ): Promise<{ userId: number; signaturesIssued: number }[]> {
    try {
      return await this.prisma.pollEligibleVoter.findMany({
        where: { pollId },
        select: { userId: true, signaturesIssued: true },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error fetching eligible voter statuses for pollId ${pollId}: ${errMsg}`;
      return [];
    }
  }
  /**
   * Atomically transitions a poll from `started` to `closing`, guarding against
   * concurrent finishers. Writes a `POLL_STATUS_CLOSING` audit log entry on
   * success.
   *
   * @param pollId - ID of the poll to mark as closing.
   * @returns HTTP 200 on a successful transition; 403 if the poll did not exist
   *          or was not in `started` (e.g. already closing/finished); 500 on
   *          unexpected errors.
   */
  public async markPollClosing(pollId: number): Promise<{
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  }> {
    try {
      const result = await this.prisma.poll.updateMany({
        where: {
          id: pollId,
          voteStatus: "started",
        },
        data: {
          voteStatus: "closing",
        },
      });

      if (result.count === 1) {
        await this.insertAuditLog(
          "POLL_STATUS_CLOSING",
          `pollId:${pollId} has changed status to closing`,
        );

        return { httpStatusCode: 200 };
      } else {
        return {
          httpStatusCode: 403,
          errorMsg:
            "Poll might not have been started, did not exists or something has already finished it",
        };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error closing poll ${pollId}: ${errMsg}`;
      return {
        httpStatusCode: 500,
        errorMsg: "Error invalidating poll",
      };
    }
  }

  // ----------------------------------------------
  // OPEN POLL METHODS
  // ----------------------------------------------

  /**
   * Lists all votes for a given poll, ordered by public hash-chain position, without the status is finished (critical difference!).
   * The ascending order makes it possible to verify the hash chain from start to finish: each vote's `previousHash` must match the `currentHash` of the preceding vote.
   * Votes are only returned if the poll's `voteStatus` is `"finished"`; otherwise the votes are considered private until voting closes.
   *
   * @param pollId the ID of the poll for which the votes should be listed.
   * @returns An object containing an array of Vote objects, an HTTP status code, and an optional error message if the operation failed. Returns 200 on success, 404 if the poll does not exist, 403 if the poll is not finished yet, and 500 if an error occurs during fetching. In all non-success cases `votes` is an empty array.
   */
  public async listVotesForCommitment(pollId: number): Promise<{
    votes: VoteInsert[];
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

      const sqlResults = await this.prisma.vote.findMany({
        where: { pollId },
        select: {
          id: true,
          pollId: true,
          pollOptionId: true,
          userId: true,
          timestamp: true,
          chainPosition: true,
          previousHash: true,
          currentHash: true,
          signature: true,
        },
        orderBy: { chainPosition: "asc" },
      });

      const votes: VoteInsert[] = sqlResults.map((row) => ({
        optionId: row.pollOptionId,
        uuid: row.id,
        userId: row.userId,
        signature: row.signature,
        chainPosition: row.chainPosition,
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

  // tjek om vi får brug for denne!!!!!!
  /**
   * Returns the number of votes a given user has already cast in a given poll, by counting the user's entries in the `voteToken` table.
   * Used together with `getVotesAllowed` to determine how many votes the user has remaining before reaching their quota.
   *
   * @param pollId the ID of the poll to count cast votes for.
   * @param userId the ID of the user whose cast votes are being counted.
   * @returns Promise<number> a promise that resolves to the number of votes the user has already cast for the poll. Returns 0 if an error occurs during fetching.
   */
  public async countCastVotesByUser(
    pollId: number,
    userId: number,
  ): Promise<number> {
    try {
      const count = await this.prisma.vote.count({
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

  // tjek om vi får brug for denne!!!!!!
  /**
   * Returns the number of votes a given user has already cast in a given poll, by counting the user's entries in the `voteToken` table.
   * Used together with `getVotesAllowed` to determine how many votes the user has remaining before reaching their quota.
   *
   * @param pollId the ID of the poll to count cast votes for.
   * @param userId the ID of the user whose cast votes are being counted.
   * @returns Promise<number> a promise that resolves to the number of votes the user has already cast for the poll. Returns 0 if an error occurs during fetching.
   */
  public async countCastVotesTotal(pollId: number): Promise<number> {
    try {
      const count = await this.prisma.vote.count({
        where: { pollId },
      });
      return count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error getting number of votes casted for poll ID: ${pollId}. Error: ${errMsg}`;
      return 0;
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
    votes: OpenVoteInsert[],
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
        const alreadyCast = await tx.vote.count({
          where: { pollId, userId },
        });

        if (votesAllowed <= 0) {
          throw new Error("NO_VOTING_POWER");
        }

        // Does not have partial acceptance. If user tries to cast more votes than allowed, the entire batch is rejected?
        if (votes.length + alreadyCast > votesAllowed) {
          throw new Error("QUOTA_EXCEEDED");
        }

        await tx.vote.createMany({
          data: votes.map((v) => ({
            id: v.uuid,
            pollId,
            pollOptionId: v.optionId,
            userId,
            signature: null,
            chainPosition: v.chainPosition,
            previousHash: v.previousHash,
            currentHash: v.currentHash,
          })),
        });
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

  public async setCloseArtifacts(
    pollId: number,
    closeCommitment: string,
    closeTimestampQuery: Uint8Array<ArrayBufferLike>,
    closeTimeStampToken: Uint8Array<ArrayBufferLike>,
    closedAt: Date,
  ): Promise<{
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  }> {
    try {
      await this.prisma.poll.update({
        where: { id: pollId },
        data: {
          voteStatus: "finished",
          closeCommitment,
          closeTimestampQuery: new Uint8Array(closeTimestampQuery),
          closeTimestampToken: new Uint8Array(closeTimeStampToken),
          closedAt,
        },
      });
      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger
        .error`finalizePollClose failed for pollId ${pollId}. Error: ${msg}`;
      return {
        success: false,
        errorMsg: "Error while finalizing poll close",
        httpStatusCode: 500,
      };
    }
  }

  public async getUsernamesByIds(ids: number[]): Promise<Map<number, string>> {
    const row = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true },
    });
    return new Map(row.map((r) => [r.id, r.username] as const));
  }

  public async getPollStatus(pollId: number): Promise<string | null> {
    try {
      const result = await this.prisma.poll.findUnique({
        where: { id: pollId },
        select: { ballotPrivacy: true },
      });
      return result?.ballotPrivacy ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error`Error fetching public key for pollId ${pollId}: ${msg}`;
      return null;
    }
  }
}
