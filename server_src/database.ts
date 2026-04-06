// https://docs.deno.com/examples/sqlite/
// https://nodejs.org/api/sqlite.html#sqlite

import { DatabaseSync } from "node:sqlite";
import * as argon2 from "npm:argon2@0.44.0";

interface User {
  id: number | undefined;
  username: string | undefined;
  passwordHash: string | undefined;
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
  const adminPassword = await argon2.hash("1234");
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
console.log("Users:");
for (const row of rows) {
  console.log(row);
}

/**
 * Fetches a user from the db based on a username.
 *
 * @param username used that will be looked up and fetched from the db.
 */
export function getUserFromDB(username: string) {
  const sqlResult = DB.prepare(
    "SELECT id, username, passwordHash FROM users WHERE username = (?)",
  ).get(username);

  // To-do: this either needs a rewrite for better error handling on wrong type and or it needs extensive testing.
  // Convert the SQL row to an object in TypeScript.
  if (typeof sqlResult != "undefined") {
    const user: User = {
      id: typeof sqlResult.id != "number" ? undefined : sqlResult.id,
      username: typeof sqlResult.username != "string"
        ? undefined
        : sqlResult.username,
      passwordHash: typeof sqlResult.passwordHash != "string"
        ? undefined
        : sqlResult.passwordHash,
    };

    // Check that the user object got correctly created.
    if (
      user.id === undefined || user.username === undefined ||
      user.passwordHash === undefined
    ) {
      return {
        errorMsg:
          "Internal Server Error: user object did not get created correctly.",
        httpStatusCode: 500, // User should not be able to input data that cause the user object to be malformed.
      };
    }

    return {
      user,
      httpStatusCode: 200,
    };
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
  console.log("Added user:", username);
}

/**
 * Deletes a user entry from the database.
 *
 * @param username of the user going to be deleted from the database
 */
export function deleteUserFromDB(username: string) {
  const sqlResult = DB.prepare(
    "DELETE FROM users WHERE username = (?)",
  ).get(username);

  console.log("Deleted user:", sqlResult);
}

/**
 * Closes the internal application database.
 */
export function closeDB() {
  DB.close();
}
