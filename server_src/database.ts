// https://docs.deno.com/examples/sqlite/
// https://nodejs.org/api/sqlite.html#sqlite
import { DatabaseSync } from "node:sqlite";

// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#password-hashing-algorithms
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
import * as argon2 from "npm:argon2@0.44.0";
import { env } from "./secret_handling.ts";

// --- Import the LogTape config --------------------
import "./logtape_config.ts";
import { getLogger } from "@logtape/logtape";
const logger = getLogger(["server-backend"]);
// --------------------------------------------------

interface User {
  id: number;
  username: string;
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
  `,
);

// Create admin user.
// To-do: Let this be controlled by a config somewhere else or environment variable.
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
  //...
}
// --- End of db init ---

const rows = DB.prepare("SELECT id, username, passwordHash FROM users")
  .all();
logger.debug("Users: {rows}", { rows }); // Print all user entries.

/**
 * Fetches a user from the db based on a username, if that user exists.
 *
 * @param username used that will be looked up and fetched from the db.
 */
export function getUserFromDB(username: string) {
  const sqlResult = DB.prepare(
    "SELECT id, username, passwordHash FROM users WHERE username = (?)",
  ).get(username);

  let couldUserBePopulated: boolean = true;

  // To-do: this either needs a rewrite for better error handling on wrong type and or it needs extensive testing.
  // Convert the SQL row to an object in TypeScript.
  if (typeof sqlResult != "undefined") {
    const user: User = {
      id: typeof sqlResult.id !== "number"
        ? (couldUserBePopulated = false, 0)
        : sqlResult.id,
      username: typeof sqlResult.username !== "string"
        ? (couldUserBePopulated = false, "")
        : sqlResult.username,
      passwordHash: typeof sqlResult.passwordHash !== "string"
        ? (couldUserBePopulated = false, "")
        : sqlResult.passwordHash,
    };

    if (!couldUserBePopulated) {
      const logMsg =
        "400 Bad Request: User object cannot get created correctly, user does not exist in database.";
      logger.debug(logMsg);
      return { errorMsg: logMsg, httpStatusCode: 400 };
    }

    return { user, httpStatusCode: 200 };
  }
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
    //...
  }
  logger.info(`Added user to database with username: {{${username}}}`);
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
