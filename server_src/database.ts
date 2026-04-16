// https://docs.deno.com/examples/sqlite/
// https://nodejs.org/api/sqlite.html#sqlite
import { DatabaseSync } from "node:sqlite";

// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#password-hashing-algorithms
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
import * as argon2 from "npm:argon2@0.44.0";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";

/**
 * The TypeScript equivalent of the User object stored in the database.
 *
 * @param id A uniqe number representing the user.
 * @param name A uniqe name representing the user
 * @parm passwordHash The password stored as a Argon2id hash.
 */

export type userId = number;
export interface User {
  id: userId;
  name: string;
  passwordHash: string;
}

type ballotOptionId = number;
interface ballotOption {
  id: ballotOptionId;
  name: string;
  votesRecived: number;
}

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
  voteOwner: userId;
  pollVisibility: pollVisibility;
  pollPrivacy: pollPrivacy;
  showTopN: number;
  ballotLimit: number;
  eligibleVoters: Record<userId, number>;
  ballotOptions: Record<ballotOptionId, ballotOption>;
}

/**
 * @param showTopN - Instead of showing the distribution of votes, the top n votes will be shown.
 * E.g. if a ballot has options: x, y, and z, where x got 10 votes, y got 5 and z got 1.
 * Then instead of showing the exact vote distribution, if for example showTopN=2, then x and y will be shown as being in "top 2".
 * @param ballotLimit - The amount of ballot options a user can select per vote.
 * E.g. if ballotLimit=2 and the user can vote for ballot options: x, y, and z, the user could for an example vote for x and z.
 */
export class Poll {
  id!: pollId;
  public title!: string;
  public description!: string;
  public voteOwner!: userId;
  public pollVisibility!: pollVisibility;
  public pollPrivacy!: pollPrivacy;
  public showTopN!: number;
  public ballotLimit!: number;
  // startNow: boolean // Consider this not being stored in object but handled in the creation function.
  // useBuffer: boolean // Same as above.
  public eligibleVoters!: Record<userId, number>;
  public ballotOptions!: Record<ballotOptionId, ballotOption>;

  /**
   * Synchronize the object with the database, using the variables present in the object.
   * This needs to be called after a variable change in the object.
   */
  private syncDB() {
    logger.fatal`Not implemented`;
    throw new Error("Not implemented");
  }

  constructor(config: PollConfig) {
    Object.assign(this, config);

    return new Proxy(this, {
      set(target, property, value, receiver) {
        const result: boolean = Reflect.set(target, property, value, receiver);
        logger.trace`${target} ${receiver}`;

        if (result) {
          target.syncDB();
        } else {
          logger.error`Failed to set property of target: ${target}`;
        }

        return result;
      },
    });
  }
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
    // To-do: remove AUTOINCREMENT as it does not fit with
    // the use case. (See https://sqlite.org/autoinc.html)
    // -----------------------------------------------------
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
          votwOwner INTEGER NOT NULL,
          pollVisibility TEXT NOT NULL,
          pollPrivacy TEXT NOT NULL,
          showTopN INTEGER NOT NULL,
          ballotLimit INTEGER NOT NULL,
          eligibleVoters TEXT NOT NULL,
          ballotOptions TEXT NOT NULL
        );
      `,
    );
    // The records (eligibleVoters and ballotOptions) from the Poll class will be stored as a string in the database.
    // This should be fine as SQLite as a default string size of 1 billion bytes which should be enough.
    // https://sqlite.org/limits.html

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
}
