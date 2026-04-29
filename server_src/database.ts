// https://docs.deno.com/examples/sqlite/
// https://nodejs.org/api/sqlite.html#sqlite
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#password-hashing-algorithms
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
import * as argon2 from "npm:argon2@0.44.0"; // used for hashing
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
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
  private DB!: DatabaseSync;

  /**
   * Disabled public use of constructor due to async limitation.
   *
   * @param adminPassword
   * @param filePath
   */
  private constructor(adminPassword: string, filePath: string) {
    this.DB = new DatabaseSync(filePath);

    // Create database file. -------------------------------
    // To-do: remove AUTOINCREMENT as it does not fit
    // the use case. (See https://sqlite.org/autoinc.html)
    // -----------------------------------------------------

    //SQLite does not support foreign keys by default, so we need to enable it
    // I think we need foreign keys since for example poll_option a vote without a valid poll_option should not be possible.
    this.DB.exec("PRAGMA foreign_keys = ON;");

    // jeg er tvivl om vi skal tage stilling til ON DELETE ved createdBy, synes ikke der er nogen optioner der giver mening f.eks.
    // cascade er uønsket, set null så skal vi ihvertfald tillade den at være null og det tænker jeg ikke giver mening,
    // restrict vil gøre at vi ikke kan slette brugere der har oprettet polls, og det synes jeg heller ikke er ønskeligt. Så måske skal vi bare lade være med at
    // specificere det og så er det default som er no action? evt få en 'superadministrator' rolle, som den CreatedBy assignes til hvis brugeren slettes.

    // Unique is voteTokens sørgerer for at bruger kan få to aktive tokens til samme afstemning.
    this.DB.exec(
      `
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          passwordHash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS polls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          voteStatus TEXT NOT NULL DEFAULT 'draft', 
          createdBy INTEGER NOT NULL REFERENCES users(id),
          createdAt TEXT NOT NULL DEFAULT (datetime('now')), 
          startsAt TEXT, 
          endsAt TEXT,
          pollVisibility TEXT NOT NULL DEFAULT 'private',
          ballotPrivacy TEXT NOT NULL DEFAULT 'secret',
          showTopN INTEGER NOT NULL DEFAULT 0,
          ballotLimit INTEGER NOT NULL DEFAULT 1,
          useBuffer INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pollEligibleVoters(
          pollId INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	  votesAllowed INTEGER NOT NULL, 
          PRIMARY KEY(pollId, userId)
          );
        CREATE TABLE IF NOT EXISTS pollOptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pollId INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          optionText TEXT NOT NULL,
          displayOrder INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS voteTokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pollId INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          UUID TEXT NOT NULL UNIQUE,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          used INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS votes (
          id TEXT PRIMARY KEY REFERENCES voteTokens(UUID),
          pollId INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          pollOptionId INTEGER NOT NULL REFERENCES pollOptions(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          previousHash TEXT NOT NULL,
          currentHash TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS auditLog(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        details TEXT 
        );
     `,
    );

    // Create admin user.
    try {
      // https://github.com/ranisalt/node-argon2

      this.DB.prepare(
        `
          INSERT INTO users (username, passwordHash)
          VALUES (?, ?)
          ON CONFLICT(username) DO NOTHING
        `,
      ).run("admin", adminPassword);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger.fatal`Error while creating admin user in database: ${errMsg}`;
      throw new Error("Error while creating admin user in database.");
    }

    // Print all user entries.
    const rows = this.DB.prepare(
      "SELECT id, username, passwordHash FROM users",
    ).all();
    logger.trace("DB | Users: {rows}", { rows });

    // Print all user entries.
    const polls = this.DB.prepare("SELECT * FROM polls").all();
    logger.trace`"DB | Polls: ${polls}"`;
  }

  /**
   * Initialize the SQLite database for the web application.
   *
   * @param filePath the path to the database file. If not found a new file will be created.
   */
  public static async initDatabase(filePath: string): Promise<WebappDatabase> {
    const adminPassword = await argon2.hash(env.ADMIN_USER_PASSWORD);
    const dbInstance = new WebappDatabase(adminPassword, filePath);

    // Get admin from database
    const { user, httpStatusCode, errorMsg } = dbInstance.getUserFromDB(
      "admin",
    );

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
  public getUserFromDB(username: string): getUserFromDBResult {
    const sqlResult = this.DB.prepare(
      "SELECT id, username, passwordHash FROM users WHERE username = (?)",
    ).get(username);

    if (typeof sqlResult === "undefined") {
      logger.info`User with username: ${username} not found in database.`;
      return { errorMsg: "User not found in database", httpStatusCode: 400 };
    }

    const { id, username: fetchedUsername, passwordHash } = sqlResult;

    const hasValidShape = typeof id === "number" &&
      typeof fetchedUsername === "string" &&
      typeof passwordHash === "string";

    if (!hasValidShape) {
      logger
        .error`500 Internal Server Error: User object cannot get created correctly, user does not exist in database.`;
      return { errorMsg: "500 Internal Server Error", httpStatusCode: 500 };
    }

    const user: User = {
      id,
      name: fetchedUsername,
      passwordHash,
    };

    return { user, httpStatusCode: 200 };
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
      // https://github.com/ranisalt/node-argon2
      this.DB.prepare(
        `
        INSERT INTO users (username, passwordHash)
        VALUES (?, ?)
        ON CONFLICT(username) DO NOTHING
        `,
      ).run(username, await argon2.hash(password));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while adding user to database with username: ${username}. Error: ${errMsg}`;
      return 500;
    }
    logger.info`Added user to database with username: ${username}`;
    return 201;
  }

  /**
   * Deletes a user entry from the database.
   *
   * @param username of the user going to be deleted from the database
   */
  public deleteUserFromDB(username: string) {
    const _sqlResult = this.DB.prepare(
      "DELETE FROM users WHERE username = (?)",
    ).run(username);

    logger.info(`Deleted user from database with username: {{${username}}}`);
  }

  /**
   * Closes the internal application database.
   *
   * @todo tie this in with a proper destructor.
   */
  public closeDB() {
    this.DB.close();
  }

  public getPollFromDB(pollId: number): getPollFromDBResult {
    const sqlResult = this.DB.prepare(
      "SELECT id, title, description, voteStatus, createdBy, createdAt, startsAt, endsAt, pollVisibility, ballotPrivacy, showTopN, ballotLimit, useBuffer FROM polls WHERE id = (?)",
    ).get(pollId);

    if (typeof sqlResult === "undefined") {
      logger.info`Poll with ID: ${pollId} not found in database.`;
      return { errorMsg: "Poll not found in database", httpStatusCode: 400 };
    }

    const {
      id,
      title,
      description,
      voteStatus,
      createdBy,
      createdAt,
      startsAt,
      endsAt,
      pollVisibility,
      ballotPrivacy,
      showTopN,
      ballotLimit,
      useBuffer,
    } = sqlResult;

    const validStatuses = [
      "draft",
      "saved",
      "not started",
      "started",
      "finished",
    ];
    const validVisibilities = ["public", "private"];
    const validPrivacies = ["secret", "open"];

    const hasValidShape = typeof id === "number" &&
      typeof title === "string" &&
      typeof description === "string" &&
      typeof voteStatus === "string" && validStatuses.includes(voteStatus) &&
      typeof createdBy === "number" &&
      typeof createdAt === "string" &&
      (typeof startsAt === "string" || startsAt === null) &&
      (typeof endsAt === "string" || endsAt === null) &&
      typeof pollVisibility === "string" &&
      validVisibilities.includes(pollVisibility) &&
      typeof ballotPrivacy === "string" &&
      validPrivacies.includes(ballotPrivacy) &&
      typeof showTopN === "number" &&
      typeof ballotLimit === "number" &&
      typeof useBuffer === "number";

    if (!hasValidShape) {
      logger
        .error`500 Internal Server Error: Poll object cannot get created correctly, poll does not exist in database.`;
      return { errorMsg: "500 Internal Server Error", httpStatusCode: 500 };
    }

    const poll: Poll = {
      id,
      title,
      description,
      voteStatus: voteStatus as pollStatus,
      createdBy,
      createdAt,
      startsAt: startsAt ?? undefined,
      endsAt: endsAt ?? undefined,
      pollVisibility: pollVisibility as pollVisibility,
      ballotPrivacy: ballotPrivacy as ballotPrivacy,
      showTopN,
      ballotLimit,
      useBuffer,
    };

    return { poll, httpStatusCode: 200 };
  }

  public getPollOptionsFromDB(pollId: number): PollOption[] {
    const sqlResults = this.DB.prepare(
      "SELECT id, pollId, optionText, displayOrder FROM pollOptions WHERE pollId = (?) ORDER BY displayOrder ASC",
    ).all(pollId);

    if (typeof sqlResults === "undefined") {
      logger.info`Poll with ID: ${pollId} not found in database.`;
      // return { errorMsg: "Poll not found in database", httpStatusCode: 400 };
    }

    const pollOptions: PollOption[] = [];
    for (const row of sqlResults) {
      const { id, pollId, optionText, displayOrder } = row;

      const hasValidShape = typeof id === "number" &&
        typeof pollId === "number" &&
        typeof optionText === "string" &&
        typeof displayOrder === "number";

      if (!hasValidShape) {
        logger
          .error`500 Internal Server Error: PollOption object cannot get created correctly, poll option does not exist in database.`;
        continue;
      }
      pollOptions.push({
        id,
        pollId,
        optionText,
        displayOrder,
      });
    }

    return pollOptions;
  }

  public insertVoteBatch(
    pollId: number,
    userId: number,
    votes: VoteInsert[],
  ): {
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  } {
    try {
      //Will use IMMEDIATE mode in SQLite here so serialization of write-transaktion is perserved
      this.DB.exec("BEGIN IMMEDIATE");
      const votesAllowed = this.getVotesAllowed(pollId, userId);
      const alreadyCast = this.countCastVotes(pollId, userId);

      if (votesAllowed <= 0) {
        this.DB.exec("ROLLBACK");
        return {
          success: false,
          errorMsg: "User has no voting power for this poll.",
          httpStatusCode: 403,
        };
      }

      if (votes.length + alreadyCast > votesAllowed) {
        this.DB.exec("ROLLBACK"); // closes the transaction nicely
        return {
          success: false,
          errorMsg: "Quota exceeded.",
          httpStatusCode: 400,
        };
      }

      const insertTokenStmt: StatementSync = this.DB.prepare(`
		INSERT INTO voteTokens (pollId, userId, UUID)
		VALUES (?,?,?)
		`);
      const insertVoteStmt: StatementSync = this.DB.prepare(`
		INSERT INTO votes (pollId, pollOptionId, id, previousHash, currentHash)
		VALUES (?, ?, ?, ?, ?) 
		`);

      for (const v of votes) {
        insertTokenStmt.run(pollId, userId, v.UUID);
        insertVoteStmt.run(
          pollId,
          v.optionId,
          v.UUID,
          v.previousHash,
          v.currentHash,
        );
      }

      this.DB.exec("COMMIT");
      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      try {
        this.DB.exec("ROLLBACK");
      } catch (_) { // Ignore if we get an error here
      }
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`InsertVoteBatch failed for pollId ${pollId}. Error: ${errMsg}`;
      return {
        success: false,
        errorMsg: "Error while inserting vote",
        httpStatusCode: 500,
      };
    }
  }

  public getLatestHash(
    pollId: number,
  ): {
    hash: string | null;
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  } {
    try {
      const sqlResult = this.DB.prepare(`
        SELECT currentHash FROM votes
        WHERE pollId = ?
        ORDER BY rowid DESC
        LIMIT 1
      `).get(pollId);

      if (typeof sqlResult === "undefined") {
        // Ingen stemmer endnu → "genesis" — første stemme i kæden
        return { hash: null, httpStatusCode: 200 };
      }

      if (typeof sqlResult.currentHash !== "string") {
        return {
          hash: null,
          errorMsg: "Invalid hash shape",
          httpStatusCode: 500,
        };
      }

      return { hash: sqlResult.currentHash, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error fetching latest hash for poll ID: ${pollId}. Error: ${errMsg}`;
      return {
        hash: null,
        errorMsg: "Error fetching latest hash",
        httpStatusCode: 500,
      };
    }
  }

  public insertAuditLog(
    action: string,
    details: string | null,
  ): {
    success: boolean;
    errorMsg?: string;
    httpStatusCode: ContentfulStatusCode;
  } {
    try {
      this.DB.prepare(`
        INSERT INTO auditLog (action, details)
        VALUES (?, ?)
        `).run(action, details);

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

  public getAuditLog(): {
    logs: AuditLogEntry[];
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  } {
    try {
      const sqlResults = this.DB.prepare(`
        SELECT id, action, timestamp, details FROM auditLog
        ORDER BY timestamp DESC, id DESC
      `).all();

      const logs: AuditLogEntry[] = [];

      for (const row of sqlResults) {
        const { id, action, timestamp, details } = row;

        const hasValidShape = typeof id === "number" &&
          typeof action === "string" &&
          typeof timestamp === "string" &&
          (typeof details === "string" || details === null);

        if (!hasValidShape) {
          logger.error`500 Internal Server Error: AuditLogEntry has invalid
  shape.`;
          continue;
        }

        logs.push({ id, action, timestamp, details });
      }

      return { logs, httpStatusCode: 200 };
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
  public listVotesForPoll(pollId: number): {
    votes: Vote[];
    httpStatusCode: ContentfulStatusCode;
    errorMsg?: string;
  } {
    try {
      // tjek først om afstemningn er 'finished'
      const pollStatus = this.DB.prepare(
        `SELECT voteStatus FROM polls WHERE id = ?`,
      ).get(pollId);

      if (typeof pollStatus === "undefined") {
        return { votes: [], errorMsg: "Poll not found", httpStatusCode: 404 };
      }

      //Skal return forbidden hvis ikke voteStatus er finished.
      if (pollStatus.voteStatus !== "finished") {
        return {
          votes: [],
          errorMsg:
            "Polls is not finished - votes are not public until voting closes",
          httpStatusCode: 403,
        };
      }
      // voteStatus er nu "finished" og vi skal return votes.
      const sqlResults = this.DB.prepare(`
        SELECT id, pollId, pollOptionId, timestamp, previousHash, currentHash 
        FROM votes
        WHERE pollId = ?
        ORDER BY timestamp ASC, rowid ASC
      `).all(pollId);

      const votes: Vote[] = [];

      for (const row of sqlResults) {
        const {
          id,
          pollId,
          pollOptionId,
          timestamp,
          previousHash,
          currentHash,
        } = row;

        const hasValidShape = typeof id === "string" &&
          typeof pollId === "number" &&
          typeof pollOptionId === "number" &&
          typeof timestamp === "string" &&
          typeof previousHash === "string" &&
          typeof currentHash === "string";

        if (!hasValidShape) {
          logger.error`500 Internal Server Error: Vote row has invalid shape.`;
          continue;
        }

        votes.push({
          id,
          pollId,
          pollOptionId,
          timestamp,
          previousHash,
          currentHash,
        });
      }
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

  public isUserEligible(pollId: number, userId: number): boolean {
    try {
      const sqlResult = this.DB.prepare(`
        SELECT 1 FROM pollEligibleVoters
        WHERE pollId = ? AND userId = ? `).get(pollId, userId);

      return typeof sqlResult !== "undefined";
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Uknown error";
      logger
        .error`Error checking eligibility for poll ID: ${pollId}, user ID: ${userId}. Error: ${errMsg}`;
      return false; // Fail-safe: ved fejl nægter vi adgang
    }
  }

  public getVotesAllowed(pollId: number, userId: number): number {
    try {
      const sqlResult = this.DB.prepare(`
		SELECT votesAllowed FROM pollEligibleVoters
		WHERE pollId = ? AND userId = ? `).get(pollId, userId);
      if (
        typeof sqlResult === "undefined" ||
        typeof sqlResult.votesAllowed !== "number"
      ) {
        return 0;
      }
      return sqlResult.votesAllowed;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Uknown error";
      logger
        .error`Error getting number of votes allowed for poll ID: ${pollId}, user ID: ${userId}. Error: ${errMsg}`;
      return 0;
    }
  }
  // returns the number of votes a current User already has "cast"
  public countCastVotes(pollId: number, userId: number): number {
    try {
      const sqlResult = this.DB.prepare(`
		SELECT COUNT(*) AS count FROM voteTokens WHERE pollId = ? AND userId = ?`)
        .get(
          pollId,
          userId,
        );
      if (
        typeof sqlResult === "undefined" || typeof sqlResult.count !== "number"
      ) {
        return 0;
      }
      return sqlResult.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Uknown error";
      logger
        .error`Error getting number of votes casted for poll ID: ${pollId}, user ID: ${userId}. Error: ${errMsg}`;
      return 0;
    }
  }
}
