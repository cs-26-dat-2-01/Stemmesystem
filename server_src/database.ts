// https://docs.deno.com/examples/sqlite/
// https://nodejs.org/api/sqlite.html#sqlite
import { DatabaseSync } from "node:sqlite";

// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#password-hashing-algorithms
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
import * as argon2 from "npm:argon2@0.44.0"; // used for hashing
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";

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
export type pollPrivacy = "secret" | "open";
export type pollStatus =
  | "draft" // Ongoing editing by poll creator.
  | "saved" // Edits saved but poll haven't been published.
  | "not started" // Poll have been published and will start at the given start time.
  | "started" // Poll is started and eligible voters can cast their ballot.
  | "finished"; // Poll is finished and users with correct access rights can see the poll results.

export interface PollConfig {
  title: string;
  description: string;
  createdBy: userId;
  visibility: pollVisibility;
  privacy: pollPrivacy;
  showTopN: number;
  ballotLimit: number;
  useBuffer: boolean;
  startsAt?: string;  // ? betyder valgfri
  endsAt?: string;
}

export interface PollOption {
  id: pollOptionId; 
  pollId: pollId;
  optionText: string;
  displayOrder: number;
}

export interface VoteToken {
  id: number;
  pollId: pollId;
  userId: userId;
  token: string;
  createdAt: string;
  used: boolean;
}

export interface Vote {
  id: number;
  pollId: pollId;
  pollOptionId: pollOptionId;
  timestamp: string;
}

/**
 * @param showTopN - Instead of showing the distribution of votes, the top n votes will be shown.
 * E.g. if a ballot has options: x, y, and z, where x got 10 votes, y got 5 and z got 1.
 * Then instead of showing the exact vote distribution, if for example showTopN=2, then x and y will be shown as being in "top 2".
 * @param ballotLimit - The amount of ballot options a user can select per vote.
 * E.g. if ballotLimit=2 and the user can vote for ballot options: x, y, and z, the user could for an example vote for x and z.
 */

// har lavet Poll om til interface istedet for class. 
export interface Poll {
  id: pollId;
  title: string;
  description: string;
  voteStatus: pollStatus;
  createdBy: userId;
  createdAt: string;
  startsAt?: string;
  endsAt?: string;
  visibility: pollVisibility;
  privacy: pollPrivacy;
  showTopN: number;
  ballotLimit: number;
  useBuffer: number;
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

interface createVoteTokenResult {
  token?: string;
  errorMsg?: string;
  httpStatusCode: ContentfulStatusCode;
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
          visibility TEXT NOT NULL DEFAULT 'private',
          privacy TEXT NOT NULL DEFAULT 'secret',
          showTopN INTEGER NOT NULL DEFAULT 0,
          ballotLimit INTEGER NOT NULL DEFAULT 1,
          useBuffer INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS pollEligibleVoters(
          pollId INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
          token TEXT NOT NULL UNIQUE,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          used INTEGER NOT NULL DEFAULT 0,
          UNIQUE(pollId, userId) 
        );
        CREATE TABLE IF NOT EXISTS votes (
          id TEXT PRIMARY KEY,
          pollId INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
          pollOptionId INTEGER NOT NULL REFERENCES pollOptions(id) ON DELETE CASCADE,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
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
    const rows = this.DB.prepare("SELECT id, username, passwordHash FROM users")
      .all();
    logger.trace("DB | Users: {rows}", { rows });

    // Print all user entries.
    const polls = this.DB.prepare("SELECT * FROM polls")
      .all();
    logger.trace`"DB | Polls: ${polls}"`;
  }

  /**
   * Initialize the SQLite database for the web application.
   *
   * @param filePath the path to the database file. If not found a new file will be created.
   */
  public static async initDatabase(filePath: string): Promise<WebappDatabase> {
    const adminPassword = await argon2.hash(env.ADMIN_USER_PASSWORD);
    return new WebappDatabase(adminPassword, filePath);
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
  public async addUserToDB(username: string, password: string) {
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
    }
    logger.info`Added user to database with username: ${username}`;
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
      "SELECT id, title, description, voteStatus, createdBy, createdAt, startsAt, endsAt, visibility, privacy, showTopN, ballotLimit, useBuffer FROM polls WHERE id = (?)",
    ).get(pollId);

    if (typeof sqlResult === "undefined") {
      logger.info`Poll with ID: ${pollId} not found in database.`;
      return { errorMsg: "Poll not found in database", httpStatusCode: 400 };
    }

    const { id, title, description, voteStatus, createdBy, createdAt, startsAt, endsAt, visibility, privacy, showTopN, ballotLimit, useBuffer } = sqlResult;

    const hasValidShape = typeof id === "number" &&
      typeof title === "string" &&
      typeof description === "string" &&
      typeof voteStatus === "string" &&
      typeof createdBy === "number" &&
      typeof createdAt === "string" &&
      typeof (startsAt === "string" || startsAt === null) &&
      typeof (endsAt === "string" || endsAt === null) &&
      typeof visibility === "string" &&
      typeof privacy === "string" &&
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
      voteStatus,
      createdBy,
      createdAt,
      startsAt,
      endsAt,
      visibility,
      privacy,
      showTopN,
      ballotLimit,
      useBuffer
    };

    return { poll, httpStatusCode: 200 };
  }

  public getPollOptionsFromDB(pollId: number): PollOption[] {
    const sqlResults = this.DB.prepare(
      "SELECT id, pollId, optionText, displayOrder FROM pollOptions WHERE pollId = (?) ORDER BY displayOrder ASC",
    ).all(pollId);


    if (typeof sqlResult === "undefined") {
      logger.info`Poll with ID: ${pollId} not found in database.`;
      return { errorMsg: "Poll not found in database", httpStatusCode: 400 };
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
        displayOrder
      });
    }
    
    return pollOptions;
  }

  public createVoteToken(pollId: number, userId: number): createVoteTokenResult {
    try {
      const newToken = crypto.randomUUID();
      const sqlResult = this.DB.prepare(`
        INSERT INTO voteTokens (pollId, userId, token)
        VALUES (?, ?, ?)
        ON CONFLICT(pollId, userId) DO UPDATE SET token = token
        RETURNING token
        `).get(pollId, userId, newToken);

      return { token: sqlResult.token, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while creating vote token for poll with ID: ${pollId} and user with ID: ${userId}. Error: ${errMsg}`;
      return { errorMsg: "Error while creating vote token", httpStatusCode: 500 };
    }
  }

  public getVoteToken(pollId: number, userId: number): getVoteTokenResult {
    try {
      const sqlResult = this.DB.prepare(`
        SELECT token FROM voteTokens
        WHERE pollId = ? AND userId = ?
        `).get(pollId, userId);

      if (typeof sqlResult === "undefined") {
        logger.info`Vote token for poll with ID: ${pollId} and user with ID: ${userId} not found in database.`;
        return { errorMsg: "Vote token not found in database", httpStatusCode: 400 };
      }
      
      return { token: sqlResult.token, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while fetching vote token for poll with ID: ${pollId} and user with ID: ${userId}. Error: ${errMsg}`;
      return { errorMsg: "Error while fetching vote token", httpStatusCode: 500 };
    }
  }

  public markTokenUsed(pollId: number, userId: number): { success: boolean; errorMsg?: string; httpStatusCode: ContentfulStatusCode } {
    try {
      const sqlResult = this.DB.prepare(`
        UPDATE voteTokens
        SET used = 1
        WHERE pollId = ? AND userId = ?
        `).run(pollId, userId);
        
      if (sqlResult.changes === 0) {
        logger.info`Vote token for poll with ID: ${pollId} and user with ID: ${userId} not found in database, cannot mark as used.`;
        return { success: false, errorMsg: "Vote token not found in database", httpStatusCode: 400 };
      }
      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while marking vote token as used for poll with ID: ${pollId} and user with ID: ${userId}. Error: ${errMsg}`;
      return { success: false, errorMsg: "Error while marking vote token as used", httpStatusCode: 500 };
    }
  }

  public insertVote(pollId: number, pollOptionId: number, voteId: string): { success: boolean; errorMsg?: string; httpStatusCode: ContentfulStatusCode } {
    try {
      this.DB.prepare(`
        INSERT INTO votes (pollId, pollOptionId, id)
        VALUES (?, ?, ?)
        `).run(pollId, pollOptionId, voteId);
        
      return { success: true, httpStatusCode: 200 };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while inserting vote for poll with ID: ${pollId} and poll option with ID: ${pollOptionId}. Error: ${errMsg}`;
      return { success: false, errorMsg: "Error while inserting vote", httpStatusCode: 500 };
    }
  }





}
