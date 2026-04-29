import { assert, assertEquals } from "jsr:@std/assert";
import { env } from "../server_src/secret_handling.ts";
import { logger } from "../server_src/main_lib.ts";
import { startServer } from "../server_src/server.ts";
import { WebappDatabase } from "../server_src/database.ts";

/*
    "Testing is the future, and the future starts with you!"
    Arrange, Act, Assert!
*/

const CLIENT_VERSION = "0.0.0";

async function fetchUserCredentials(
  username: string,
  password: string,
): Promise<string> {
  const loginRes = await fetch("http://localhost:8000/login", {
    method: "POST",
    body: JSON.stringify({
      username: username,
      password: password,
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

  if (cookies !== null) {
    return cookies;
  } else {
    logger.error`Cookie string is null after fetching user credentials..`;
    return "";
  }
}

/*
Deno.test({
  name: "test template",
  async fn() {
    // Arrange
    const databasePath: string = "./database/test.db";
    const file = await Deno.create(databasePath); // Create the file, if exists truncate it.
    file.close(); // Creating a file apperently opens it.
    const DB: WebappDatabase = await WebappDatabase.initDatabase(
      databasePath,
    );

    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
    } finally {
      ac.abort();
      await server;
      DB.closeDB();
    }
  },
});
*/

Deno.test({
  name: "test route: /api/admin/add-user",
  async fn() {
    const databasePath: string = "./database/test.db";
    const file = await Deno.create(databasePath); // Create the file, if exists truncate it.
    file.close(); // Creating a file apperently opens it.
    const DB: WebappDatabase = await WebappDatabase.initDatabase(
      databasePath,
    );

    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

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
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      logger.trace`${await addUserRes.text()}`; // Response have to be consumed for test to pass.
      assert(addUserRes.status === 201, "succefully added user to db.");
    } finally {
      ac.abort();
      await server;
      DB.closeDB();
    }
  },
});

// To-do:
Deno.test({
  name: "test route: /api/poll/:pollId/open",
  async fn() {
    // Arrange
    const databasePath: string = "./database/test.db";
    const file = await Deno.create(databasePath); // Create the file, if exists truncate it.
    file.close(); // Creating a file apperently opens it.
    const DB: WebappDatabase = await WebappDatabase.initDatabase(
      databasePath,
    );

    const ac = new AbortController();
    const server = startServer(DB, ac);

    DB.runCustomSQL(`
        INSERT INTO polls (id, title, description, voteStatus, createdBy, pollVisibility)
        VALUES (3, 'Test afstemning', 'En testpoll for at teste /open og /vote', 'started', 1, 'public');
        INSERT INTO pollOptions (pollId, optionText, displayOrder) VALUES (3, 'Ja', 1);
        INSERT INTO pollOptions (pollId, optionText, displayOrder) VALUES (3, 'Nej', 2);
        INSERT INTO pollOptions (pollId, optionText, displayOrder) VALUES (3, 'Blank', 3);
        INSERT INTO pollEligibleVoters (pollId, userId) VALUES (3, 1);
      `);
    const pollId: number = 3; // Poll id which the test will interact with.

    // Act

    try {
      const username = "admin";
      const password = env.ADMIN_USER_PASSWORD;
      const cookies = await fetchUserCredentials(
        username,
        password,
      );
      const UUID = crypto.randomUUID();

      const result = await fetch(
        `http://localhost:8000/api/poll/${pollId}/open`,
        {
          method: "POST",
          body: JSON.stringify({
            UUID: UUID,
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies !== null ? cookies : " ",
            "version": CLIENT_VERSION,
          },
        },
      );

      if (result.status !== 200) {
        logger
          .fatal`${result.status} ${result.statusText}, Error msg: ${await result
          .text()}`;
      }
      assertEquals(result.status, 200);
    } finally {
      ac.abort();
      await server;
      DB.closeDB();
    }
  },
});

Deno.test({
  name: "test route: /api/poll/:pollId/vote",
  async fn() {
    const databasePath: string = "./database/test.db";
    const file = await Deno.create(databasePath); // Create the file, if exists truncate it.
    file.close(); // Creating a file apperently opens it.
    const DB: WebappDatabase = await WebappDatabase.initDatabase(
      databasePath,
    );

    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
    } finally {
      ac.abort();
      await server;
      DB.closeDB();
    }
  },
});
