// --- Import the LogTape config --------------------
import "./logtape_config.ts";
import { getLogger } from "@logtape/logtape";
const logger = getLogger(["server-backend"]);
// --------------------------------------------------

// https://docs.deno.com/examples/sqlite/
// https://nodejs.org/api/sqlite.html#sqlite
import { DatabaseSync } from "node:sqlite";

// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#password-hashing-algorithms
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
import * as argon2 from "npm:argon2@0.44.0";
import { env } from "./secret_handling.ts";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";

export interface User {
  id: number;
  name: string;
  passwordHash: string;
}

// Initialize the SQLite database for the web application.
// --- Init db start ---
const DB = new DatabaseSync("./server_src/users.db");

// Create database file.
DB.exec(
  `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL
    );
  `,
);

// Create admin user.
try {
  // https://github.com/ranisalt/node-argon2
  const adminPassword = await argon2.hash(env.ADMIN_USER_PASSWORD);
  DB.prepare(
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
const rows = DB.prepare("SELECT id, username, passwordHash FROM users")
  .all();
logger.debug("Users: {rows}", { rows });
// --- End of db init ---

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
 * Fetches a user from the db based on a username, if that user exists.
 *
 * @param username used that will be looked up and fetched from the db.
 */
export function getUserFromDB(username: string): getUserFromDBResult {
  const sqlResult = DB.prepare(
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
export async function addUserToDB(username: string, password: string) {
  try {
    // https://github.com/ranisalt/node-argon2
    DB.prepare(
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
export function deleteUserFromDB(username: string) {
  const _sqlResult = DB.prepare(
    "DELETE FROM users WHERE username = (?)",
  ).run(username);

  logger.info(`Deleted user from database with username: {{${username}}}`);
}

/**
 * Closes the internal application database.
 */
export function closeDB() {
  DB.close();
}
