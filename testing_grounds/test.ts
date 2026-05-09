import { assert, assertEquals } from "jsr:@std/assert";
import { env } from "../server_src/secret_handling.ts";
import { logger } from "../server_src/main_lib.ts";
import { startServer } from "../server_src/server.ts";
import { WebappDatabase } from "../server_src/database.ts";
import { PollManager } from "../server_src/pollManager.ts";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import * as argon2 from "npm:argon2@0.44.0";
import { createHash } from "node:crypto";
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
  await loginRes.text();

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
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) {
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
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
  ballotPrivacy?: "secret" | "open";
  showTopN?: number;
}) {
  return await prisma.poll.create({
    data: {
      title: "Test afstemning",
      description: "En testpoll",
      voteStatus: input.voteStatus ?? "started",
      createdBy: input.createdBy,
      pollVisibility: "public",
      ballotPrivacy: input.ballotPrivacy ?? "secret",
      showTopN: input.showTopN ?? 0,
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

async function seedVote(prisma: PrismaClient, input: {
  pollId: number;
  userId: number;
  optionId: number;
  uuid?: string;
  timestamp?: Date;
  previousHash?: string;
  currentHash?: string;
}) {
  const uuid = input.uuid ?? crypto.randomUUID();
  await prisma.voteToken.create({
    data: {
      pollId: input.pollId,
      userId: input.userId,
      uuid,
      used: 1,
    },
  });
  return await prisma.vote.create({
    data: {
      id: uuid,
      pollId: input.pollId,
      pollOptionId: input.optionId,
      timestamp: input.timestamp,
      previousHash: input.previousHash ?? "0",
      currentHash: input.currentHash ?? crypto.randomUUID(),
    },
  });
}

async function finishPoll(prisma: PrismaClient, pollId: number) {
  await prisma.poll.update({
    where: { id: pollId },
    data: { voteStatus: "finished" },
  });
}

// test helper
function expectedVoteHash(
  previousHash: string,
  uuid: string,
  optionId: number,
  pollId: number,
): string {
  const hashMsg =
    `PreviousHash:${previousHash}|UUID:${uuid}|pollOptionId:${optionId}|pollId:${pollId}`;

  return createHash("sha256").update(hashMsg, "utf8").digest("hex");
}

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

      const text = await res.text();

      // Assert
      assertEquals(
        res.status,
        200,
        `Exptected open poll to succeed, got ${res.status}: ${text}`,
      );
      const body = JSON.parse(text);
      assertEquals(body.poll.id, poll.id);
      assertEquals(body.poll.status, "started");
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

Deno.test({
  name: "eligible user can cast one vote",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [
          { userId: admin.id, votesAllowed: 1 },
        ],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const voteUuid = crypto.randomUUID();

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [
              {
                optionId: poll.options[0].id,
                UUID: voteUuid,
              },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected vote to succeed, got ${res.status}: ${text}`,
      );

      const voteCount = await prisma.vote.count({
        where: { pollId: poll.id },
      });

      const tokenCount = await prisma.voteToken.count({
        where: { pollId: poll.id, userId: admin.id },
      });

      assertEquals(voteCount, 1);
      assertEquals(tokenCount, 1);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "eligible user can cast multiple votes up to votesAllowed",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [
          { userId: admin.id, votesAllowed: 3 },
        ],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [
              { optionId: poll.options[0].id, UUID: crypto.randomUUID() },
              { optionId: poll.options[1].id, UUID: crypto.randomUUID() },
              { optionId: poll.options[2].id, UUID: crypto.randomUUID() },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected vote batch to succeed, got ${res.status}: ${text}`,
      );

      assertEquals(
        await prisma.vote.count({ where: { pollId: poll.id } }),
        3,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "votesRemaining decreases after votes are cast",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

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

      const voteRes = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [
              { optionId: poll.options[0].id, UUID: crypto.randomUUID() },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      assertEquals(voteRes.status, 200, await voteRes.text());

      const openRes = await fetch(
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

      const body = await openRes.json();

      assertEquals(openRes.status, 200);
      assertEquals(body.votesAllowed, 2);
      assertEquals(body.votesRemaining, 1);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "unauthenticated user cannot open poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [
          { userId: admin.id, votesAllowed: 2 },
        ],
      });

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/open`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();

      assertEquals(
        res.status,
        401,
        `Expected unauthenticated open poll to fail, got ${res.status}: ${text}`,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Ineligible user cannot open poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const user = await seedUser(prisma, "not-eligible", "password123");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials("not-eligible", "password123");

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

      const text = await res.text();

      assertEquals(
        res.status,
        403,
        `Expected ineligible open to fail, got
  ${res.status}: ${text}`,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Ineliglbe user cannot vote",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const user = await seedUser(prisma, "not-eligible-voter", "password123");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "not-eligible-voter",
        "password123",
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{
              optionId: poll.options[0].id,
              UUID: crypto.randomUUID(),
            }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected ineligible vote to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
      assertEquals(
        await prisma.voteToken.count({
          where: { pollId: poll.id, userId: user.id },
        }),
        0,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "User cannot vote as another user by sending userId in body",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const attacker = await seedUser(prisma, "attacker", "password123");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials("attacker", "password123");

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: admin.id,
            votes: [{
              optionId: poll.options[0].id,
              UUID: crypto.randomUUID(),
            }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected spoofed userId vote to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
      assertEquals(
        await prisma.voteToken.count({ where: { pollId: poll.id } }),
        0,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Not-started poll does not leak details",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

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

      const text = await res.text();

      assertEquals(
        res.status,
        403,
        `Expected closed poll open to fail, got
  ${res.status}: ${text}`,
      );
      assert(!poll.title || !text.includes(poll.title));
      assert(!text.includes("Ja"));
      assert(!text.includes("Nej"));
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "JWT identity is source of truth, not body userId",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const otherUser = await seedUser(prisma, "other-user", "password123");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: otherUser.id,
            votes: [{
              optionId: poll.options[0].id,
              UUID: crypto.randomUUID(),
            }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected JWT-authenticated vote to succeed, got
  ${res.status}: ${text}`,
      );

      assertEquals(
        await prisma.voteToken.count({
          where: { pollId: poll.id, userId: admin.id },
        }),
        1,
      );

      assertEquals(
        await prisma.voteToken.count({
          where: { pollId: poll.id, userId: otherUser.id },
        }),
        0,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Empty vote array is rejected",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({ votes: [] }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected empty vote array to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Cannot vote on poll that is not started",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{
              optionId: poll.options[0].id,
              UUID: crypto.randomUUID(),
            }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected vote on non-started poll to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Cannot vote option outside poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const otherPoll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{
              optionId: otherPoll.options[0].id,
              UUID: crypto.randomUUID(),
            }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected foreign option vote to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Cannot exceed votesAllowed",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [
              { optionId: poll.options[0].id, UUID: crypto.randomUUID() },
              { optionId: poll.options[1].id, UUID: crypto.randomUUID() },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected over-quota vote to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Batch is atomic when one vote is invalid",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const otherPoll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [
              { optionId: poll.options[0].id, UUID: crypto.randomUUID() },
              { optionId: otherPoll.options[0].id, UUID: crypto.randomUUID() },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected partially invalid batch to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
      assertEquals(
        await prisma.voteToken.count({
          where: { pollId: poll.id, userId: admin.id },
        }),
        0,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Duplicate UUID in same batch is rejected",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );
      const duplicateUuid = crypto.randomUUID();

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [
              { optionId: poll.options[0].id, UUID: duplicateUuid },
              { optionId: poll.options[1].id, UUID: duplicateUuid },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected duplicate UUID batch to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "reusing UUID from previous request is rejected",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );
      const reusedUuid = crypto.randomUUID();

      const firstRes = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{ optionId: poll.options[0].id, UUID: reusedUuid }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      assertEquals(firstRes.status, 200, await firstRes.text());

      const secondRes = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{ optionId: poll.options[1].id, UUID: reusedUuid }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await secondRes.text();

      assertEquals(
        secondRes.status,
        400,
        `Expected reused UUID to fail, got
  ${secondRes.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 1);
      assertEquals(
        await prisma.voteToken.count({
          where: { pollId: poll.id, userId: admin.id },
        }),
        1,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "Audit log on successful voting excludes optionId and UUID",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );
      const uuid = crypto.randomUUID();
      const optionId = poll.options[0].id;

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{ optionId, UUID: uuid }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected vote to succeed, got ${res.status}:
  ${text}`,
      );

      const auditLog = await prisma.auditLog.findFirst({
        where: { action: "VOTES_CAST" },
        orderBy: { id: "desc" },
      });
      assert(auditLog !== null);
      assert(auditLog.details !== null);

      assert(auditLog.details.includes(`pollId:${poll.id}`));
      assert(auditLog.details.includes(`userId:${admin.id}`));
      assert(auditLog.details.includes("voteCount:1"));

      assert(!auditLog.details.includes(uuid));
      assert(!auditLog.details.includes("UUID"));
      assert(!auditLog.details.includes("optionId"));
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});
Deno.test({
  name: "HASH-test_First vote starts hash chain from genesis hash (0)",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const uuid = crypto.randomUUID();
      const optionId = poll.options[0].id;

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{ optionId, UUID: uuid }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected vote to succeed, got ${res.status}: ${text}`,
      );

      const vote = await prisma.vote.findUniqueOrThrow({
        where: { id: uuid },
      });

      const expectedHash = expectedVoteHash("0", uuid, optionId, poll.id);

      assertEquals(vote.previousHash, "0");
      assertEquals(vote.currentHash, expectedHash);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "HASH-test_Votes in same batch form a hash chain",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();
      const optionId1 = poll.options[0].id;
      const optionId2 = poll.options[1].id;

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [
              { optionId: optionId1, UUID: uuid1 },
              { optionId: optionId2, UUID: uuid2 },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected vote batch to succeed, got ${res.status}: ${text}`,
      );

      const vote1 = await prisma.vote.findUniqueOrThrow({
        where: { id: uuid1 },
      });
      const vote2 = await prisma.vote.findUniqueOrThrow({
        where: { id: uuid2 },
      });

      const expectedHash1 = expectedVoteHash("0", uuid1, optionId1, poll.id);
      const expectedHash2 = expectedVoteHash(
        expectedHash1,
        uuid2,
        optionId2,
        poll.id,
      );

      assertEquals(vote1.previousHash, "0");
      assertEquals(vote1.currentHash, expectedHash1);
      assertEquals(vote2.previousHash, expectedHash1);
      assertEquals(vote2.currentHash, expectedHash2);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name:
    "HASH-test_New vote batch continues hash chain from latest existing vote",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const firstUuid = crypto.randomUUID();
      const firstOptionId = poll.options[0].id;

      const firstRes = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{ optionId: firstOptionId, UUID: firstUuid }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const firstText = await firstRes.text();

      assertEquals(
        firstRes.status,
        200,
        `Expected first vote to succeed, got ${firstRes.status}: ${firstText}`,
      );

      const firstVote = await prisma.vote.findUniqueOrThrow({
        where: { id: firstUuid },
      });

      const secondUuid = crypto.randomUUID();
      const secondOptionId = poll.options[1].id;

      const secondRes = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{ optionId: secondOptionId, UUID: secondUuid }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      const secondText = await secondRes.text();

      assertEquals(
        secondRes.status,
        200,
        `Expected second vote to succeed, got ${secondRes.status}: ${secondText}`,
      );

      const secondVote = await prisma.vote.findUniqueOrThrow({
        where: { id: secondUuid },
      });

      const expectedFirstHash = expectedVoteHash(
        "0",
        firstUuid,
        firstOptionId,
        poll.id,
      );

      const expectedSecondHash = expectedVoteHash(
        expectedFirstHash,
        secondUuid,
        secondOptionId,
        poll.id,
      );

      assertEquals(firstVote.previousHash, "0");
      assertEquals(firstVote.currentHash, expectedFirstHash);

      assertEquals(secondVote.previousHash, firstVote.currentHash);
      assertEquals(secondVote.previousHash, expectedFirstHash);
      assertEquals(secondVote.currentHash, expectedSecondHash);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

/* -----------
 * Auditlog testing (database.ts)
 */

Deno.test({
  name: "DB.getAuditLog returns empty array when no entries exist",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const result = await DB.getAuditLog();

      assertEquals(result.httpStatusCode, 200);
      assertEquals(result.logs, []);
      assertEquals(result.errorMsg, undefined);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "DB.getAuditLog returns inserted entries with expected shape",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      await DB.insertAuditLog("POLL_OPENED", "pollId:1, userId:1");

      const result = await DB.getAuditLog();

      assertEquals(result.httpStatusCode, 200);
      assertEquals(result.logs.length, 1);

      const entry = result.logs[0];
      assertEquals(entry.action, "POLL_OPENED");
      assertEquals(entry.details, "pollId:1, userId:1");
      assert(typeof entry.id === "number");
      assert(typeof entry.timestamp === "string");
      assert(entry.timestamp.length > 0);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "DB.getAuditLog preserves null details",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      await DB.insertAuditLog("ACTION_WITHOUT_DETAILS", null);

      const result = await DB.getAuditLog();

      assertEquals(result.httpStatusCode, 200);
      assertEquals(result.logs.length, 1);
      assertEquals(result.logs[0].action, "ACTION_WITHOUT_DETAILS");
      assertEquals(result.logs[0].details, null);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "DB.getAuditLog orders entries newest first (DESC)",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      await DB.insertAuditLog("FIRST", "first entry");
      await DB.insertAuditLog("SECOND", "second entry");
      await DB.insertAuditLog("THIRD", "third entry");

      const result = await DB.getAuditLog();

      assertEquals(result.httpStatusCode, 200);
      assertEquals(result.logs.length, 3);
      // Newest first — last inserted should be first in the array.
      assertEquals(result.logs[0].action, "THIRD");
      assertEquals(result.logs[1].action, "SECOND");
      assertEquals(result.logs[2].action, "FIRST");
      // Ids should be strictly decreasing as a tiebreaker for equal timestamps.
      assert(result.logs[0].id > result.logs[1].id);
      assert(result.logs[1].id > result.logs[2].id);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

/* ------------
 * GET /api/auditlog (server.ts)
 */

Deno.test({
  name: "GET /api/auditlog returns 200 with empty logs initially",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const res = await fetch("http://localhost:8000/api/auditlog", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected /api/auditlog to succeed, got ${res.status}: ${text}`,
      );

      const body = JSON.parse(text);
      assertEquals(body.httpStatusCode, 200);
      assertEquals(Array.isArray(body.logs), true);
      assertEquals(body.logs.length, 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "GET /api/auditlog returns logs after vote cast and poll open",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      // Trigger POLL_OPENED audit entry.
      const openRes = await fetch(
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
      assertEquals(openRes.status, 200, await openRes.text());

      // Trigger VOTES_CAST audit entry.
      const voteRes = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/vote`,
        {
          method: "POST",
          body: JSON.stringify({
            votes: [{
              optionId: poll.options[0].id,
              UUID: crypto.randomUUID(),
            }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      assertEquals(voteRes.status, 200, await voteRes.text());

      // Wait briefly for the fire-and-forget insertAuditLog in pollManager
      // to flush before we read the log back.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res = await fetch("http://localhost:8000/api/auditlog", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected /api/auditlog to succeed, got ${res.status}: ${text}`,
      );

      const body = JSON.parse(text);
      assertEquals(body.httpStatusCode, 200);
      assert(Array.isArray(body.logs));

      const actions = body.logs.map((l: { action: string }) => l.action);
      assert(
        actions.includes("POLL_OPENED"),
        `Expected POLL_OPENED in audit log, got ${JSON.stringify(actions)}`,
      );
      assert(
        actions.includes("VOTES_CAST"),
        `Expected VOTES_CAST in audit log, got ${JSON.stringify(actions)}`,
      );

      // Each entry has the documented shape.
      for (const entry of body.logs) {
        assert(typeof entry.id === "number");
        assert(typeof entry.action === "string");
        assert(typeof entry.timestamp === "string");
        assert(entry.details === null || typeof entry.details === "string");
      }
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "GET /api/auditlog requires no auth (publicly readable)",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      await DB.insertAuditLog("PUBLIC_TEST", "publicly visible entry");

      const res = await fetch("http://localhost:8000/api/auditlog", {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });

      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected unauthenticated /api/auditlog to succeed, got ${res.status}: ${text}`,
      );

      const body = JSON.parse(text);
      assertEquals(body.logs.length, 1);
      assertEquals(body.logs[0].action, "PUBLIC_TEST");
      assertEquals(body.logs[0].details, "publicly visible entry");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

// ---------------------------------------------------------------------------
// listVotesForPoll (database.ts)
// ---------------------------------------------------------------------------

Deno.test({
  name: "listVotesForPoll returns 404 when poll does not exist",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const result = await DB.listVotesForPoll(99999);

      assertEquals(result.httpStatusCode, 404);
      assertEquals(result.votes, []);
      assert(result.errorMsg);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "listVotesForPoll returns 403 when poll is not finished",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const result = await DB.listVotesForPoll(poll.id);

      assertEquals(result.httpStatusCode, 403);
      assertEquals(result.votes, []);
      assert(result.errorMsg);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "listVotesForPoll returns empty array for finished poll with no votes",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "finished",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const result = await DB.listVotesForPoll(poll.id);

      assertEquals(result.httpStatusCode, 200);
      assertEquals(result.votes, []);
      assertEquals(result.errorMsg, undefined);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "listVotesForPoll returns votes in chronological order",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 3 }],
      });

      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();
      const uuid3 = crypto.randomUUID();

      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
        uuid: uuid1,
        timestamp: new Date("2026-01-01T10:00:00Z"),
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[1].id,
        uuid: uuid2,
        timestamp: new Date("2026-01-01T11:00:00Z"),
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[2].id,
        uuid: uuid3,
        timestamp: new Date("2026-01-01T12:00:00Z"),
      });

      await finishPoll(prisma, poll.id);

      const result = await DB.listVotesForPoll(poll.id);

      assertEquals(result.httpStatusCode, 200);
      assertEquals(result.votes.length, 3);
      assertEquals(result.votes[0].id, uuid1);
      assertEquals(result.votes[1].id, uuid2);
      assertEquals(result.votes[2].id, uuid3);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

// ---------------------------------------------------------------------------
// getPollResultCounts (database.ts)
// ---------------------------------------------------------------------------

Deno.test({
  name: "getPollResultCounts returns empty array when no votes exist",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const counts = await DB.getPollResultCounts(poll.id);

      assertEquals(counts, []);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "getPollResultCounts aggregates votes per option",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 5 }],
      });

      // Ja: 3 votes, Nej: 1 vote, Blank: 0 votes
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[1].id,
      });

      const counts = await DB.getPollResultCounts(poll.id);

      const byOptionId = new Map(counts.map((c) => [c.optionId, c.count]));
      assertEquals(byOptionId.get(poll.options[0].id), 3);
      assertEquals(byOptionId.get(poll.options[1].id), 1);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "getPollResultCounts excludes options with zero votes",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
      });

      const counts = await DB.getPollResultCounts(poll.id);

      assertEquals(counts.length, 1);
      assertEquals(counts[0].optionId, poll.options[0].id);
      assertEquals(counts[0].count, 1);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

// ---------------------------------------------------------------------------
// PollManager.getResults (pollManager.ts)
// ---------------------------------------------------------------------------

Deno.test({
  name: "getResults returns 400 when poll does not exist",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const result = await pollManager.getResults(99999);

      assertEquals(result.httpStatusCode, 400);
      assertEquals(result.result, undefined);
      assert(result.errorMsg);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "getResults returns 403 when poll is not finished",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const result = await pollManager.getResults(poll.id);

      assertEquals(result.httpStatusCode, 403);
      assertEquals(result.result, undefined);
      assert(result.errorMsg);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "getResults for secret poll returns only UUIDs (no optionId)",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        ballotPrivacy: "secret",
        showTopN: 2,
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[1].id,
      });
      await finishPoll(prisma, poll.id);

      const result = await pollManager.getResults(poll.id);

      assertEquals(result.httpStatusCode, 200);
      assert(result.result);
      assertEquals(result.result.ballotPrivacy, "secret");
      assertEquals(result.result.showTopN, 2);
      assertEquals(result.result.votes.length, 2);
      // Each vote in a secret poll must only have a uuid field — no optionId leakage.
      for (const vote of result.result.votes) {
        assert(typeof vote.uuid === "string");
        assert(!("optionId" in vote));
        assert(!("optionText" in vote));
      }
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "getResults for open poll returns UUID with optionId and optionText",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        ballotPrivacy: "open",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const uuid = crypto.randomUUID();
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
        uuid,
      });
      await finishPoll(prisma, poll.id);

      const result = await pollManager.getResults(poll.id);

      assertEquals(result.httpStatusCode, 200);
      assert(result.result);
      assertEquals(result.result.ballotPrivacy, "open");
      assertEquals(result.result.votes.length, 1);
      if (result.result.ballotPrivacy === "open") {
        assertEquals(result.result.votes[0].uuid, uuid);
        assertEquals(result.result.votes[0].optionId, poll.options[0].id);
        assertEquals(
          result.result.votes[0].optionText,
          poll.options[0].optionText,
        );
      }
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "getResults includes options with zero votes in counts",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        ballotPrivacy: "secret",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      // Only vote for "Ja" — "Nej" and "Blank" should appear with count 0.
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
      });
      await finishPoll(prisma, poll.id);

      const result = await pollManager.getResults(poll.id);

      assertEquals(result.httpStatusCode, 200);
      assert(result.result);
      assertEquals(result.result.counts.length, 3);

      const countByOption = new Map(
        result.result.counts.map((c) => [c.optionId, c.count]),
      );
      assertEquals(countByOption.get(poll.options[0].id), 1);
      assertEquals(countByOption.get(poll.options[1].id), 0);
      assertEquals(countByOption.get(poll.options[2].id), 0);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

// ---------------------------------------------------------------------------
// GET /api/poll/:pollId/results (server.ts)
// ---------------------------------------------------------------------------

Deno.test({
  name: "GET /api/poll/:pollId/results returns 401 for unauthenticated user",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });
      await finishPoll(prisma, poll.id);

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/results`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();

      assertEquals(
        res.status,
        401,
        `Expected unauthenticated results to fail, got ${res.status}: ${text}`,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "GET /api/poll/:pollId/results returns 400 for non-integer pollId",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/not-a-number/results`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected invalid pollId to fail, got ${res.status}: ${text}`,
      );
      assertEquals(text, "Invalid pollId");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "GET /api/poll/:pollId/results returns 400 when poll does not exist",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/99999/results`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();

      assertEquals(
        res.status,
        400,
        `Expected missing poll to fail, got ${res.status}: ${text}`,
      );
      assert(text.length > 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "GET /api/poll/:pollId/results returns 403 when poll is not finished",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/results`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();

      assertEquals(
        res.status,
        403,
        `Expected unfinished poll to fail, got ${res.status}: ${text}`,
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name:
    "GET /api/poll/:pollId/results returns 200 with secret payload for finished secret poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        ballotPrivacy: "secret",
        showTopN: 2,
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const uuid1 = crypto.randomUUID();
      const uuid2 = crypto.randomUUID();
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
        uuid: uuid1,
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[1].id,
        uuid: uuid2,
      });
      await finishPoll(prisma, poll.id);

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/results`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected results to succeed, got ${res.status}: ${text}`,
      );
      const body = JSON.parse(text);
      assertEquals(body.ballotPrivacy, "secret");
      assertEquals(body.showTopN, 2);
      assertEquals(body.counts.length, 3);
      assertEquals(body.votes.length, 2);
      // Secret payload must not leak the option each UUID was cast for.
      for (const vote of body.votes) {
        assert(typeof vote.uuid === "string");
        assert(!("optionId" in vote));
        assert(!("optionText" in vote));
      }
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name:
    "GET /api/poll/:pollId/results returns 200 with open payload including optionId/optionText",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        ballotPrivacy: "open",
        eligibleVoters: [{ userId: admin.id, votesAllowed: 1 }],
      });

      const uuid = crypto.randomUUID();
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[0].id,
        uuid,
      });
      await finishPoll(prisma, poll.id);

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/results`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();

      assertEquals(
        res.status,
        200,
        `Expected results to succeed, got ${res.status}: ${text}`,
      );
      const body = JSON.parse(text);
      assertEquals(body.ballotPrivacy, "open");
      assertEquals(body.votes.length, 1);
      assertEquals(body.votes[0].uuid, uuid);
      assertEquals(body.votes[0].optionId, poll.options[0].id);
      assertEquals(body.votes[0].optionText, poll.options[0].optionText);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "creator can create a draft poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch("http://localhost:8000/api/polls", {
        method: "POST",
        body: JSON.stringify({
          poll: {
            title: "Min kladde",
            description: "Beskrivelse",
          },
        }),
        headers: {
          "Content-Type": "application/json",
          "Cookie": cookies,
          "version": CLIENT_VERSION,
        },
      });

      const text = await res.text();
      assertEquals(
        res.status,
        200,
        `Expected createPoll to succeed, got ${res.status}: ${text}`,
      );
      const body = JSON.parse(text);
      assert(typeof body.pollId === "number");

      const stored = await prisma.poll.findUniqueOrThrow({
        where: { id: body.pollId },
      });
      assertEquals(stored.title, "Min kladde");
      assertEquals(stored.voteStatus, "draft");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "unauthenticated user cannot create poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const res = await fetch("http://localhost:8000/api/polls", {
        method: "POST",
        body: JSON.stringify({ poll: { title: "x" } }),
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });
      const text = await res.text();
      assertEquals(
        res.status,
        401,
        `Expected unauth create to fail, got ${res.status}: ${text}`,
      );
      assertEquals(await prisma.poll.count(), 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "createPoll rejects body without poll field",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch("http://localhost:8000/api/polls", {
        method: "POST",
        body: JSON.stringify({}),
        headers: {
          "Content-Type": "application/json",
          "Cookie": cookies,
          "version": CLIENT_VERSION,
        },
      });
      assertEquals(res.status, 400, await res.text());
      assertEquals(await prisma.poll.count(), 0);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "creator can fetch own draft poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const voter = await seedUser(prisma, "voter1", "password123");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
        eligibleVoters: [{ userId: voter.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "GET",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      const text = await res.text();
      assertEquals(res.status, 200, text);

      const body = JSON.parse(text);
      assertEquals(body.poll.id, poll.id);
      assertEquals(body.poll.status, "draft");
      assertEquals(body.options.length, 3);
      assertEquals(body.voters, [{ username: "voter1", votesAllowed: 1 }]);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "non-creator cannot fetch draft poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "stranger", "password123");
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials("stranger", "password123");

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "GET",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      assertEquals(res.status, 403, await res.text());
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "started poll is not editable via getDraft",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "GET",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      assertEquals(res.status, 409, await res.text());
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "creator can update draft poll fields, options, and voters",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "alice", "pw");
      await seedUser(prisma, "bob", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            poll: {
              title: "Opdateret titel",
              description: "Ny beskrivelse",
              ballotLimit: 2,
            },
            choices: ["Rød", "Grøn", "Blå"],
            voters: [
              { username: "alice", votesAllowed: 1 },
              { username: "bob", votesAllowed: 2 },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      assertEquals(res.status, 200, await res.text());

      const updated = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
        include: { options: true, eligibleVoters: { include: { user: true } } },
      });
      assertEquals(updated.title, "Opdateret titel");
      assertEquals(updated.description, "Ny beskrivelse");
      assertEquals(updated.ballotLimit, 2);
      assertEquals(updated.options.map((o) => o.optionText).sort(), [
        "Blå",
        "Grøn",
        "Rød",
      ]);
      assertEquals(
        updated.eligibleVoters.map((v) => v.user.username).sort(),
        ["alice", "bob"],
      );
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "updatePoll rejects unknown voter usernames",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            poll: { title: "X" },
            voters: [{ username: "does-not-exist", votesAllowed: 1 }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();
      assertEquals(res.status, 400, text);
      assert(text.includes("does-not-exist"));
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "updatePoll rejects non-draft poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ poll: { title: "X" } }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      assertEquals(res.status, 409, await res.text());
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "creator can publish a complete draft poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "alice", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            poll: {
              title: "Klar til afstemning",
              pollVisibility: "public",
              ballotPrivacy: "secret",
              ballotLimit: 1,
              startsAt,
              endsAt,
            },
            choices: ["Ja", "Nej"],
            voters: [{ username: "alice", votesAllowed: 1 }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      assertEquals(res.status, 200, await res.text());

      const updated = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(updated.voteStatus, "not started");
      assertEquals(updated.title, "Klar til afstemning");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "publishPoll rejects when ballotLimit is missing",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            poll: {
              title: "Mangler ballotLimit",
              pollVisibility: "public",
              ballotPrivacy: "secret",
              startsAt,
              endsAt,
            },
            choices: ["Ja"],
            voters: [],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();
      assertEquals(res.status, 400, text);
      assert(text.toLowerCase().includes("ballotlimit"));

      const stillDraft = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(stillDraft.voteStatus, "draft");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "publishPoll rejects voters with votesAllowed exceeding ballotLimit",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "alice", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            poll: {
              title: "Stemmeoverskridelse",
              pollVisibility: "public",
              ballotPrivacy: "secret",
              ballotLimit: 2,
              startsAt,
              endsAt,
            },
            choices: ["Ja", "Nej"],
            voters: [{ username: "alice", votesAllowed: 5 }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();
      assertEquals(res.status, 400, text);
      assert(text.includes("alice"));

      const stillDraft = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(stillDraft.voteStatus, "draft");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "non-creator cannot publish poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "stranger", "pw");
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials("stranger", "pw");

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            poll: {
              title: "Stjålet",
              pollVisibility: "public",
              ballotPrivacy: "secret",
              ballotLimit: 1,
            },
            choices: ["Ja"],
            voters: [],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      assertEquals(res.status, 403, await res.text());
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "creator can delete draft poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "DELETE",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      assertEquals(res.status, 200, await res.text());

      const exists = await prisma.poll.findUnique({ where: { id: poll.id } });
      assertEquals(exists, null);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "deletePoll rejects started poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "DELETE",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      assertEquals(res.status, 403, await res.text());

      const stillExists = await prisma.poll.findUnique({
        where: { id: poll.id },
      });
      assert(stillExists !== null);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "non-creator cannot delete poll",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "stranger", "pw");
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials("stranger", "pw");

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}`,
        {
          method: "DELETE",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      assertEquals(res.status, 403, await res.text());

      const stillExists = await prisma.poll.findUnique({
        where: { id: poll.id },
      });
      assert(stillExists !== null);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "creator can fetch poll overview",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const voter = await seedUser(prisma, "voter1", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "not started",
        eligibleVoters: [{ userId: voter.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/overview`,
        {
          method: "GET",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      const text = await res.text();
      assertEquals(res.status, 200, text);

      const body = JSON.parse(text);
      assertEquals(body.poll.id, poll.id);
      assertEquals(body.options.length, 3);
      assertEquals(body.voters, [{ username: "voter1", votesAllowed: 1 }]);
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "eligible voter can fetch poll overview",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const voter = await seedUser(prisma, "voter1", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: voter.id, votesAllowed: 1 }],
      });

      const cookies = await fetchUserCredentials("voter1", "pw");

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/overview`,
        {
          method: "GET",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      assertEquals(res.status, 200, await res.text());
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "ineligible non-creator cannot fetch poll overview",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "outsider", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
      });

      const cookies = await fetchUserCredentials("outsider", "pw");

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/overview`,
        {
          method: "GET",
          headers: { "Cookie": cookies, "version": CLIENT_VERSION },
        },
      );
      assertEquals(res.status, 403, await res.text());
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name:
    "tickPollStatuses moves not-started polls to started when startsAt has passed",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 60 * 60_000);

      const poll = await prisma.poll.create({
        data: {
          title: "Auto start",
          voteStatus: "not started",
          createdBy: admin.id,
          pollVisibility: "public",
          ballotPrivacy: "secret",
          startsAt: past,
          endsAt: future,
        },
      });

      await pollManager.tickPollStatuses();

      const after = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(after.voteStatus, "started");
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name:
    "tickPollStatuses moves started polls to finished when endsAt has passed",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const past = new Date(Date.now() - 60_000);
      const earlier = new Date(Date.now() - 120_000);

      const poll = await prisma.poll.create({
        data: {
          title: "Auto finish",
          voteStatus: "started",
          createdBy: admin.id,
          pollVisibility: "public",
          ballotPrivacy: "secret",
          startsAt: earlier,
          endsAt: past,
        },
      });

      await pollManager.tickPollStatuses();

      const after = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(after.voteStatus, "finished");
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "tickPollStatuses leaves polls untouched when times not reached",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const pollManager = new PollManager(DB);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });

      const future = new Date(Date.now() + 60 * 60_000);
      const farFuture = new Date(Date.now() + 120 * 60_000);

      const poll = await prisma.poll.create({
        data: {
          title: "Future poll",
          voteStatus: "not started",
          createdBy: admin.id,
          pollVisibility: "public",
          ballotPrivacy: "secret",
          startsAt: future,
          endsAt: farFuture,
        },
      });

      await pollManager.tickPollStatuses();

      const after = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(after.voteStatus, "not started");
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name:
    "DB.getUsersByUsernames returns users for known names and notFound for unknown",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const alice = await seedUser(prisma, "alice", "pw");
      const bob = await seedUser(prisma, "bob", "pw");

      const empty = await DB.getUsersByUsernames([]);
      assertEquals(empty, { users: [], notFound: [] });

      const result = await DB.getUsersByUsernames(["alice", "bob", "ghost"]);
      assertEquals(
        result.users.sort((a, b) => a.id - b.id),
        [
          { id: alice.id, username: "alice" },
          { id: bob.id, username: "bob" },
        ].sort((a, b) => a.id - b.id),
      );
      assertEquals(result.notFound, ["ghost"]);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "DB.createPoll persists options and eligible voters in one transaction",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const alice = await seedUser(prisma, "alice", "pw");

      const result = await DB.createPoll({
        title: "Mit valg",
        description: "desc",
        voteStatus: "draft",
        createdBy: admin.id,
        pollVisibility: "public",
        ballotPrivacy: "secret",
        ballotLimit: 2,
        optionTexts: ["A", "B", "C"],
        voterUserIds: [alice.id],
      });

      assertEquals(result.httpStatusCode, 201);
      assert(typeof result.pollId === "number");

      const poll = await prisma.poll.findUniqueOrThrow({
        where: { id: result.pollId! },
        include: { options: true, eligibleVoters: true },
      });
      assertEquals(poll.options.length, 3);
      assertEquals(
        poll.options.map((o) => o.optionText).sort(),
        ["A", "B", "C"],
      );
      assertEquals(poll.eligibleVoters.length, 1);
      assertEquals(poll.eligibleVoters[0].userId, alice.id);
      assertEquals(poll.eligibleVoters[0].votesAllowed, 2);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "DB.deletePoll cascades to options and eligible voters",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const voter = await seedUser(prisma, "voter1", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
        eligibleVoters: [{ userId: voter.id, votesAllowed: 1 }],
      });

      const result = await DB.deletePoll(poll.id);
      assertEquals(result.httpStatusCode, 200);

      assertEquals(
        await prisma.poll.findUnique({ where: { id: poll.id } }),
        null,
      );
      assertEquals(
        await prisma.pollOption.count({ where: { pollId: poll.id } }),
        0,
      );
      assertEquals(
        await prisma.pollEligibleVoter.count({ where: { pollId: poll.id } }),
        0,
      );
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "DB.getEligibleVoters returns empty array when poll has no voters",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const voters = await DB.getEligibleVoters(poll.id);
      assertEquals(voters, []);
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "publishPoll rejects when endsAt is before startsAt",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "alice", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const endsAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            poll: {
              title: "Slut foer start",
              pollVisibility: "public",
              ballotPrivacy: "secret",
              ballotLimit: 1,
              startsAt,
              endsAt,
            },
            choices: ["Ja"],
            voters: [{ username: "alice", votesAllowed: 1 }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();
      assertEquals(res.status, 400, text);
      assert(text.toLowerCase().includes("endsat"));

      const stillDraft = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(stillDraft.voteStatus, "draft");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "publishPoll rejects when startsAt is in the past",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "alice", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const startsAt = new Date("2020-01-01T00:00:00Z").toISOString();
      const endsAt = new Date("2020-01-02T00:00:00Z").toISOString();

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            poll: {
              title: "Start i fortiden",
              pollVisibility: "public",
              ballotPrivacy: "secret",
              ballotLimit: 1,
              startsAt,
              endsAt,
            },
            choices: ["Ja"],
            voters: [{ username: "alice", votesAllowed: 1 }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      const text = await res.text();
      assertEquals(res.status, 400, text);
      assert(text.toLowerCase().includes("startsat"));

      const stillDraft = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(stillDraft.voteStatus, "draft");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name: "publishPoll accepts startsAt close to now (within tolerance)",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: "admin" },
      });
      await seedUser(prisma, "alice", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "draft",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const startsAt = new Date().toISOString();
      const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const res = await fetch(
        `http://localhost:8000/api/polls/${poll.id}/publish`,
        {
          method: "POST",
          body: JSON.stringify({
            poll: {
              title: "Start nu",
              pollVisibility: "public",
              ballotPrivacy: "secret",
              ballotLimit: 1,
              startsAt,
              endsAt,
            },
            choices: ["Ja"],
            voters: [{ username: "alice", votesAllowed: 1 }],
          }),
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );
      assertEquals(res.status, 200, await res.text());

      const updated = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(updated.voteStatus, "not started");
    } finally {
      ac.abort();
      await server;
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

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
/*
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
