import { assert } from "jsr:@std/assert";
import { env } from "../server_src/secret_handling.ts";
import { logger } from "../server_src/main_lib.ts";
import { DatabaseSync } from "node:sqlite";
import { startServer } from "../server_src/server.ts";
import { WebappDatabase } from "../server_src/database.ts";

/*
    "Testing is the future, and the future starts with you!"
    Arrange, Act, Assert!
*/

const CLIENT_VERSION = "0.0.0";

async function initTestServer(fn: () => void) {
  const databasePath: string = "./database/test.db";
  const file = await Deno.create(databasePath); // Create the file, if exists truncate it.
  file.close(); // Creating a file apperently opens it.
  const DB: WebappDatabase = await WebappDatabase.initDatabase(
    databasePath,
  );
  const ac = new AbortController();
  const server = startServer(DB, ac);

  try {
    fn();
  } finally {
    ac.abort();
    await server;
    DB.closeDB();
  }
}

Deno.test({
  name: "test route: /api/admin/add-user",
  fn() {
    initTestServer(async () => {
      const loginRes = await fetch("http://localhost:8000/login", {
        method: "POST",
        body: JSON.stringify({
          username: "admin",
          password: env.ADMIN_USER_PASSWORD,
        }),
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });

      if (loginRes.status === 200) {
        logger.trace`Recived login with status code: ${loginRes.status}`;
      } else {
        logger.error`"Login failed with status code: ${loginRes.status}`;
      }
      console.log(await loginRes.text());

      // Save the cookie string containing the JWT token
      const cookies = loginRes.headers.get("set-cookie");
      logger.trace`cookies: ${cookies}`;

      const addUserRes = await fetch(
        "http://localhost:8000/api/admin/add-user",
        {
          method: "POST",
          body: JSON.stringify({
            username: "test",
            password: "1234",
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies !== null ? cookies : " ",
            "version": CLIENT_VERSION,
          },
        },
      );
      logger.trace`${await addUserRes.text()}`; // Response have to be consumed for test to pass.
      assert(addUserRes.status === 201, "succefully added user to db.");
    });
  },
});

// To-do:
Deno.test({
  name: "test route: /api/poll/:pollId/open",
  async fn() {
    await initTestServer(() => {
      logger.fatal`not implemented`;
      throw assert(false);
    });
  },
});
