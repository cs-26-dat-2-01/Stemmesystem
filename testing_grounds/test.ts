import { assert, assertEquals } from "jsr:@std/assert";
import { env } from "../server_src/secret_handling.ts";
import { logger } from "../server_src/main_lib.ts";
import { startServer } from "../server_src/server.ts";
import { WebappDatabase } from "../server_src/database.ts";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import * as argon2 from "npm:argon2@0.44.0";
/*
    "Testing is the future, and the future starts with you!"
    Arrange, Act, Assert!
*/

const CLIENT_VERSION = "0.0.0";

// Auth (Returns the JWT token that we use as credentials of login
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

// Database lifecycle functions
async function createTestDatabaseUrl(): Promise<string> {
  await Deno.mkdir("./database", { recursive: true });
  const id = crypto.randomUUID();
  return `file:./database/test-${id}.db`;
}

async function pushPrismaSchema(databaseUrl: string): Promise<void> {
  const command = new Deno.Command("npx", {
    args: ["prisma", "db", "push"],
    env: {
      ...Deno.env.toObject(),
      DATABASE_URL: databaseUrl,
    },
    stdout: "inherit", //display it in terminal - this is just for developing
    stderr: "inherit",
  });
  console.log("Running prisma");
  const result = await command.output();
  if (!result.success) {
    throw new Error(`Failed to push Prisma schema to test DB`);
  }
}

async function removeSqliteFiles(databaseUrl: string): Promise<void> {
  const path = databaseUrl.replace("file:", "");

  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      await Deno.remove(`${path}${suffix}`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err;
      }
    }
  }
}

// Prisma access
function createPrismaForTest(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaLibSql({ url: databaseUrl }),
  });
}

// Seed helpers
async function seedUser(
  prisma: PrismaClient,
  username: string,
  password: string,
) {
  const passwordHash = await argon2.hash(password);

  return await prisma.user.create({
    data: {
      username,
      passwordHash,
    },
  });
}

async function seedPoll(prisma: PrismaClient, input: {
  createdBy: number;
  voteStatus?: "draft" | "saved" | "not started" | "started" | "finished";
  eligibleVoters?: { userId: number; votesAllowed: number }[];
}) {
  return await prisma.poll.create({
    data: {
      title: "Test afstemning",
      description: "En testpoll",
      voteStatus: input.voteStatus ?? "started",
      createdBy: input.createdBy,
      pollVisibility: "public",
      eligibleVoters: {
        create: input.eligibleVoters ?? [],
      },
      options: {
        create: [
          { optionText: "Ja", displayOrder: 1 },
          { optionText: "Nej", displayOrder: 2 },
          { optionText: "Blank", displayOrder: 3 },
        ],
      },
    },
    include: {
      options: true,
      eligibleVoters: true,
    },
  });
}

/* database test skeleton
Deno.test({
  name: "eligible user can open started poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      // seed data
      // login
      // open poll
      // assertions
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});
*/

Deno.test({
  name: "eligible user can open started poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      // Arrange
      const admin = await prisma.user.findUniqueOrThrow(
        { where: { username: "admin" } },
      );

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [
          { userId: admin.id, votesAllowed: 2 },
        ],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      // ACT
      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/open`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const body = await res.json();

      // Assert
      assertEquals(res.status, 200);
      assertEquals(body.poll.id, poll.id);
      assertEquals(body.poll.voteStatus, "started");
      assertEquals(body.options.length, 3);
      assertEquals(body.votesAllowed, 2);
      assertEquals(body.votesRemaining, 2);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

/* I have commented old test out since i keep getting errors from them
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

*/
