import { assert, assertEquals } from "jsr:@std/assert";
import { env } from "../server_src/secret_handling.ts";
import { logger } from "../server_src/main_lib.ts";
import { startServer } from "../server_src/server.ts";
import { WebappDatabase } from "../server_src/database.ts";
import { PollManager } from "../server_src/pollManager.ts";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../generated/prisma/client.ts";
import * as argon2 from "npm:argon2@0.44.0";
import { createHash } from "node:crypto";
import { keygen } from "../server_src/blindRsa.ts";
import {
  blind,
  finalize,
  generateUuid,
  prepare,
} from "../client_src/blindRsa.ts";
import { voteHashMessage } from "../client_src/WebLib.ts";
/*
    "Testing is the future, and the future starts with you!"
    Arrange, Act, Assert!
*/

const CLIENT_VERSION = "0.0.0";
env.VOTE_BUFFER_BATCH_SIZE = "1";
env.VOTE_BUFFER_FLUSH_MS = "10";

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
  const { publicKeyPem, privateKeyPem } = await keygen();
  return await prisma.poll.create({
    data: {
      title: "Test afstemning",
      description: "En testpoll",
      voteStatus: input.voteStatus ?? "started",
      createdBy: input.createdBy,
      pollVisibility: "public",
      ballotPrivacy: input.ballotPrivacy ?? "secret",
      showTopN: input.showTopN ?? 0,
      blindRsaPublicKey: publicKeyPem,
      blindRsaPrivateKey: privateKeyPem,
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
  userId?: number;
  optionId: number;
  uuid?: string;
  timestamp?: Date;
  chainPosition?: number;
  previousHash?: string;
  currentHash?: string;
  signature?: string;
}) {
  const uuid = input.uuid ?? crypto.randomUUID();
  const poll = await prisma.poll.findUniqueOrThrow({
    where: { id: input.pollId },
    select: {
      ballotPrivacy: true,
      showTopN: true,
    },
  });
  const latestVote = input.chainPosition === undefined
    ? await prisma.vote.findFirst({
      where: { pollId: input.pollId },
      select: { chainPosition: true },
      orderBy: { chainPosition: "desc" },
    })
    : null;
  const previousHash = input.previousHash ?? "0";
  const currentHash = input.currentHash ?? createHash("sha256").update(
    voteHashMessage({
      previousHash,
      uuid,
      optionId: input.optionId,
      pollId: input.pollId,
      ballotPrivacy: poll.ballotPrivacy as "secret" | "open" | null,
      showTopN: poll.showTopN,
    }),
    "utf8",
  ).digest("hex");
  return await prisma.vote.create({
    data: {
      id: uuid,
      pollId: input.pollId,
      pollOptionId: input.optionId,
      timestamp: input.timestamp,
      chainPosition: input.chainPosition ?? ((latestVote?.chainPosition ?? 0) + 1),
      previousHash,
      currentHash,
      signature: input.signature ?? crypto.randomUUID(),
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
  ballotPrivacy: "secret" | "open" = "secret",
  showTopN = 0,
): string {
  return createHash("sha256").update(
    voteHashMessage({
      previousHash,
      uuid,
      optionId,
      pollId,
      ballotPrivacy,
      showTopN,
    }),
    "utf8",
  ).digest("hex");
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function openPollForUser(pollId: number, cookies: string) {
  const res = await fetch(`http://localhost:8000/api/poll/${pollId}/open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookies,
      "version": CLIENT_VERSION,
    },
  });
  return res;
}

async function requestBlindSignature(
  pollId: number,
  cookies: string,
  publicKeyPem: string,
) {
  const preparedMessage = prepare(generateUuid());
  const { blindedMessageB64, invB64 } = await blind(publicKeyPem, preparedMessage);
  const signRes = await fetch(
    `http://localhost:8000/api/poll/${pollId}/blindsign`,
    {
      method: "POST",
      body: JSON.stringify({ blinded: blindedMessageB64 }),
      headers: {
        "Content-Type": "application/json",
        "Cookie": cookies,
        "version": CLIENT_VERSION,
      },
    },
  );

  return {
    signRes,
    preparedMessage,
    uuidB64: base64Encode(preparedMessage),
    invB64,
  };
}

async function issueAndCastVote(
  pollId: number,
  optionId: number,
  cookies: string,
  publicKeyPem: string,
) {
  const blindRequest = await requestBlindSignature(pollId, cookies, publicKeyPem);
  const signText = await blindRequest.signRes.text();
  if (blindRequest.signRes.status !== 200) {
    return {
      signStatus: blindRequest.signRes.status,
      signText,
      voteStatus: undefined,
      voteText: undefined,
      uuidB64: blindRequest.uuidB64,
      signatureB64: undefined,
    };
  }

  const blindSig = JSON.parse(signText).blindSig as string;
  const signatureB64 = await finalize(
    publicKeyPem,
    blindRequest.preparedMessage,
    blindSig,
    blindRequest.invB64,
  );

  const voteRes = await fetch(`http://localhost:8000/api/poll/${pollId}/vote`, {
    method: "POST",
    body: JSON.stringify({
      uuid: blindRequest.uuidB64,
      signature: signatureB64,
      optionId,
    }),
    headers: {
      "Content-Type": "application/json",
      "version": CLIENT_VERSION,
    },
  });

  return {
    signStatus: 200,
    signText,
    voteStatus: voteRes.status,
    voteText: await voteRes.text(),
    uuidB64: blindRequest.uuidB64,
    signatureB64,
  };
}

async function waitForPollToFinish(
  prisma: PrismaClient,
  pollId: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      select: { voteStatus: true },
    });
    if (poll?.voteStatus === "finished") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Poll ${pollId} did not reach finished state within ${timeoutMs}ms`);
}

async function getSignaturesIssued(
  prisma: PrismaClient,
  pollId: number,
  userId: number,
): Promise<number> {
  const eligible = await prisma.pollEligibleVoter.findUnique({
    where: { pollId_userId: { pollId, userId } },
    select: { signaturesIssued: true },
  });
  return eligible?.signaturesIssued ?? 0;
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

      const result = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        cookies,
        poll.blindRsaPublicKey!,
      );

      assertEquals(result.signStatus, 200, result.signText);
      assertEquals(
        result.voteStatus,
        200,
        `Expected vote to succeed, got ${result.voteStatus}: ${result.voteText}`,
      );
      await waitForPollToFinish(prisma, poll.id);

      const voteCount = await prisma.vote.count({
        where: { pollId: poll.id },
      });

      assertEquals(voteCount, 1);
      assertEquals(await getSignaturesIssued(prisma, poll.id, admin.id), 1);
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

      for (const option of poll.options) {
        const result = await issueAndCastVote(
          poll.id,
          option.id,
          cookies,
          poll.blindRsaPublicKey!,
        );
        assertEquals(result.signStatus, 200, result.signText);
        assertEquals(result.voteStatus, 200, result.voteText);
      }
      await waitForPollToFinish(prisma, poll.id);

      assertEquals(
        await prisma.vote.count({ where: { pollId: poll.id } }),
        3,
      );
      assertEquals(await getSignaturesIssued(prisma, poll.id, admin.id), 3);
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

      const voteResult = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      assertEquals(voteResult.signStatus, 200, voteResult.signText);
      assertEquals(voteResult.voteStatus, 200, voteResult.voteText);

      const openRes = await openPollForUser(poll.id, cookies);

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
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
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
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const cookies = await fetchUserCredentials(
        "not-eligible-voter",
        "password123",
      );

      const blindRequest = await requestBlindSignature(
        poll.id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      const text = await blindRequest.signRes.text();

      assertEquals(
        blindRequest.signRes.status,
        403,
        `Expected ineligible vote to fail, got
  ${blindRequest.signRes.status}: ${text}`,
      );
      assertEquals(await prisma.vote.count({ where: { pollId: poll.id } }), 0);
      assertEquals(await getSignaturesIssued(prisma, poll.id, user.id), 0);
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
        eligibleVoters: [{ userId: admin.id, votesAllowed: 2 }],
      });

      const cookies = await fetchUserCredentials("attacker", "password123");

      const preparedMessage = prepare(generateUuid());
      const blinded = await blind(poll.blindRsaPublicKey!, preparedMessage);
      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/blindsign`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: admin.id,
            blinded: blinded.blindedMessageB64,
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
        403,
        `Expected spoofed userId signature request to fail, got
  ${res.status}: ${text}`,
      );
      assertEquals(await getSignaturesIssued(prisma, poll.id, admin.id), 0);
      assertEquals(await getSignaturesIssued(prisma, poll.id, attacker.id), 0);
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
        eligibleVoters: [
          { userId: admin.id, votesAllowed: 1 },
          { userId: otherUser.id, votesAllowed: 1 },
        ],
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const preparedMessage = prepare(generateUuid());
      const blinded = await blind(poll.blindRsaPublicKey!, preparedMessage);
      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/blindsign`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: otherUser.id,
            blinded: blinded.blindedMessageB64,
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
        `Expected JWT-authenticated signature issuance to succeed, got
  ${res.status}: ${text}`,
      );

      assertEquals(
        await getSignaturesIssued(prisma, poll.id, admin.id),
        1,
      );

      assertEquals(
        await getSignaturesIssued(prisma, poll.id, otherUser.id),
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
        await getSignaturesIssued(prisma, poll.id, admin.id),
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
      const blindRequest = await requestBlindSignature(
        poll.id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      const signText = await blindRequest.signRes.text();
      assertEquals(blindRequest.signRes.status, 200, signText);
      const blindSig = JSON.parse(signText).blindSig as string;
      const signatureB64 = await finalize(
        poll.blindRsaPublicKey!,
        blindRequest.preparedMessage,
        blindSig,
        blindRequest.invB64,
      );

      const firstRes = await fetch(`http://localhost:8000/api/poll/${poll.id}/vote`, {
        method: "POST",
        body: JSON.stringify({
          uuid: blindRequest.uuidB64,
          signature: signatureB64,
          optionId: poll.options[0].id,
        }),
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });

      assertEquals(firstRes.status, 200, await firstRes.text());

      const secondRes = await fetch(`http://localhost:8000/api/poll/${poll.id}/vote`, {
        method: "POST",
        body: JSON.stringify({
          uuid: blindRequest.uuidB64,
          signature: signatureB64,
          optionId: poll.options[1].id,
        }),
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });

      const text = await secondRes.text();

      assertEquals(
        secondRes.status,
        409,
        `Expected reused UUID to fail, got
  ${secondRes.status}: ${text}`,
      );
      assertEquals(await prisma.pendingVote.count({ where: { pollId: poll.id } }), 1);
      assertEquals(
        await getSignaturesIssued(prisma, poll.id, admin.id),
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
      const result = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      assertEquals(result.signStatus, 200, result.signText);
      assertEquals(result.voteStatus, 200, result.voteText);
      await waitForPollToFinish(prisma, poll.id);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          action: {
            in: [
              "BLIND_SIG_ISSUED",
              "PENDING_VOTES_BUFFERED",
              "POLL_CLOSED_AND_TIMESTAMPED",
            ],
          },
        },
        orderBy: { id: "asc" },
      });
      assert(auditLogs.length >= 2);

      for (const auditLog of auditLogs) {
        assert(auditLog.details !== null);
        assert(auditLog.details.includes(`pollId:${poll.id}`));
        assert(!auditLog.details.includes("userId"));
        assert(!auditLog.details.includes("UUID"));
        assert(!auditLog.details.includes("optionId"));
        if (result.uuidB64) {
          assert(!auditLog.details.includes(result.uuidB64));
        }
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

      const result = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      assertEquals(result.signStatus, 200, result.signText);
      assertEquals(result.voteStatus, 200, result.voteText);
      await waitForPollToFinish(prisma, poll.id);

      const vote = await prisma.vote.findFirstOrThrow({
        where: { pollId: poll.id },
        orderBy: { chainPosition: "asc" },
      });

      const expectedHash = expectedVoteHash(
        "0",
        vote.id,
        vote.pollOptionId,
        poll.id,
      );

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

      const first = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      const second = await issueAndCastVote(
        poll.id,
        poll.options[1].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      assertEquals(first.voteStatus, 200, first.voteText);
      assertEquals(second.voteStatus, 200, second.voteText);
      await waitForPollToFinish(prisma, poll.id);

      const votes = await prisma.vote.findMany({
        where: { pollId: poll.id },
        orderBy: { chainPosition: "asc" },
      });

      assertEquals(votes.length, 2);
      assertEquals(votes[0].previousHash, "0");
      assertEquals(
        votes[0].currentHash,
        expectedVoteHash("0", votes[0].id, votes[0].pollOptionId, poll.id),
      );
      assertEquals(votes[1].previousHash, votes[0].currentHash);
      assertEquals(
        votes[1].currentHash,
        expectedVoteHash(
          votes[0].currentHash,
          votes[1].id,
          votes[1].pollOptionId,
          poll.id,
        ),
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

      const existingVote = await seedVote(prisma, {
        pollId: poll.id,
        optionId: poll.options[0].id,
        uuid: "seed-existing-vote",
        chainPosition: 1,
        signature: "seed-signature",
      });
      await prisma.pollEligibleVoter.update({
        where: {
          pollId_userId: {
            pollId: poll.id,
            userId: admin.id,
          },
        },
        data: {
          signaturesIssued: 1,
        },
      });

      const castResult = await issueAndCastVote(
        poll.id,
        poll.options[1].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      assertEquals(castResult.signStatus, 200, castResult.signText);
      assertEquals(castResult.voteStatus, 200, castResult.voteText);
      await prisma.poll.update({
        where: { id: poll.id },
        data: {
          endsAt: new Date(Date.now() - 1000),
        },
      });
      const pollManager = new PollManager(DB);
      await pollManager.tickPollStatuses();
      await waitForPollToFinish(prisma, poll.id);

      const secondVote = await prisma.vote.findFirstOrThrow({
        where: {
          pollId: poll.id,
          NOT: { id: existingVote.id },
        },
      });

      const expectedSecondHash = expectedVoteHash(
        existingVote.currentHash,
        secondVote.id,
        secondVote.pollOptionId,
        poll.id,
      );

      assertEquals(secondVote.previousHash, existingVote.currentHash);
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
  name: "GET /api/auditlog returns 200 with empty logs initially for authenticated caller",
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

      const res = await fetch("http://localhost:8000/api/auditlog", {
        method: "GET",
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

      const voteResult = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      assertEquals(voteResult.signStatus, 200, voteResult.signText);
      assertEquals(voteResult.voteStatus, 200, voteResult.voteText);
      await waitForPollToFinish(prisma, poll.id);

      // Wait briefly for the fire-and-forget insertAuditLog in pollManager
      // to flush before we read the log back.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res = await fetch("http://localhost:8000/api/auditlog", {
        method: "GET",
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
        actions.includes("BLIND_SIG_ISSUED"),
        `Expected BLIND_SIG_ISSUED in audit log, got ${JSON.stringify(actions)}`,
      );
      assert(
        actions.includes("POLL_CLOSED_AND_TIMESTAMPED"),
        `Expected POLL_CLOSED_AND_TIMESTAMPED in audit log, got ${JSON.stringify(actions)}`,
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
  name: "GET /api/auditlog returns 401 for unauthenticated caller",
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
        401,
        `Expected unauthenticated /api/auditlog to fail with 401, got ${res.status}: ${text}`,
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
  name: "listVotesForPoll returns votes in chain order",
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
        chainPosition: 1,
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[1].id,
        uuid: uuid2,
        timestamp: new Date("2026-01-01T11:00:00Z"),
        chainPosition: 2,
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: admin.id,
        optionId: poll.options[2].id,
        uuid: uuid3,
        timestamp: new Date("2026-01-01T12:00:00Z"),
        chainPosition: 3,
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
      assertEquals(body.counts.length, 2);
      assertEquals(body.votes.length, 2);
      for (const count of body.counts) {
        assertEquals(count.count, null);
        assert(typeof count.rank === "number");
      }
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

// ---------------------------------------------------------------------------
// POST /api/admin/add-user
// ---------------------------------------------------------------------------

Deno.test({
  name: "admin can add a new user via /api/admin/add-user",
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

      const res = await fetch("http://localhost:8000/api/admin/add-user", {
        method: "POST",
        body: JSON.stringify({
          username: "new-voter",
          password: "secret123",
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
        201,
        `Expected add-user to succeed, got ${res.status}: ${text}`,
      );

      const stored = await prisma.user.findUnique({
        where: { username: "new-voter" },
      });
      assert(stored !== null);
      // Password must be hashed, never stored in clear.
      assert(stored!.passwordHash !== "secret123");
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
  name: "/api/admin/add-user returns 409 when username already exists",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      await seedUser(prisma, "alice", "original-pw");

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch("http://localhost:8000/api/admin/add-user", {
        method: "POST",
        body: JSON.stringify({
          username: "alice",
          password: "different-pw",
        }),
        headers: {
          "Content-Type": "application/json",
          "Cookie": cookies,
          "version": CLIENT_VERSION,
        },
      });

      assertEquals(res.status, 409, await res.text());
      // Existing user must still authenticate with the original password —
      // the duplicate-add must NOT overwrite the password.
      const originalLogin = await fetchUserCredentials("alice", "original-pw");
      assert(originalLogin.length > 0);
      assertEquals(await prisma.user.count({ where: { username: "alice" } }), 1);
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
  name: "/api/admin/add-user returns 403 for non-admin caller",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      await seedUser(prisma, "regular", "pw");
      const cookies = await fetchUserCredentials("regular", "pw");

      const res = await fetch("http://localhost:8000/api/admin/add-user", {
        method: "POST",
        body: JSON.stringify({
          username: "hopeful",
          password: "pw",
        }),
        headers: {
          "Content-Type": "application/json",
          "Cookie": cookies,
          "version": CLIENT_VERSION,
        },
      });

      assertEquals(res.status, 403, await res.text());
      assertEquals(
        await prisma.user.findUnique({ where: { username: "hopeful" } }),
        null,
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
  name: "/api/admin/add-user returns 401 for unauthenticated caller",
  async fn() {
    const databaseUrl = await createTestDatabaseUrl();
    await pushPrismaSchema(databaseUrl);

    const DB = await WebappDatabase.initDatabase(databaseUrl);
    const prisma = createPrismaForTest(databaseUrl);
    const ac = new AbortController();
    const server = startServer(DB, ac);

    try {
      const res = await fetch("http://localhost:8000/api/admin/add-user", {
        method: "POST",
        body: JSON.stringify({
          username: "anon",
          password: "pw",
        }),
        headers: {
          "Content-Type": "application/json",
          "version": CLIENT_VERSION,
        },
      });

      assertEquals(res.status, 401, await res.text());
      assertEquals(
        await prisma.user.findUnique({ where: { username: "anon" } }),
        null,
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

// ---------------------------------------------------------------------------
// Multi-user voting flows
// ---------------------------------------------------------------------------

Deno.test({
  name: "two eligible users can each cast a vote on the same poll",
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
      const alice = await seedUser(prisma, "alice", "pw");
      const bob = await seedUser(prisma, "bob", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [
          { userId: alice.id, votesAllowed: 1 },
          { userId: bob.id, votesAllowed: 1 },
        ],
      });

      const aliceCookies = await fetchUserCredentials("alice", "pw");
      const bobCookies = await fetchUserCredentials("bob", "pw");

      const aliceResult = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        aliceCookies,
        poll.blindRsaPublicKey!,
      );
      const bobResult = await issueAndCastVote(
        poll.id,
        poll.options[1].id,
        bobCookies,
        poll.blindRsaPublicKey!,
      );

      assertEquals(aliceResult.voteStatus, 200, aliceResult.voteText);
      assertEquals(bobResult.voteStatus, 200, bobResult.voteText);

      // Both users used up their quota → poll auto-finishes.
      await waitForPollToFinish(prisma, poll.id);

      assertEquals(
        await prisma.vote.count({ where: { pollId: poll.id } }),
        2,
      );
      assertEquals(await getSignaturesIssued(prisma, poll.id, alice.id), 1);
      assertEquals(await getSignaturesIssued(prisma, poll.id, bob.id), 1);
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
  name: "five eligible users can each cast a vote on the same poll",
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

      const usernames = ["u1", "u2", "u3", "u4", "u5"];
      const users = [];
      for (const username of usernames) {
        users.push(await seedUser(prisma, username, "pw"));
      }

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: users.map((u) => ({
          userId: u.id,
          votesAllowed: 1,
        })),
      });

      for (let i = 0; i < usernames.length; i++) {
        const cookies = await fetchUserCredentials(usernames[i], "pw");
        const option = poll.options[i % poll.options.length];
        const result = await issueAndCastVote(
          poll.id,
          option.id,
          cookies,
          poll.blindRsaPublicKey!,
        );
        assertEquals(
          result.voteStatus,
          200,
          `User ${usernames[i]} vote failed: ${result.voteText}`,
        );
      }

      await waitForPollToFinish(prisma, poll.id);

      assertEquals(
        await prisma.vote.count({ where: { pollId: poll.id } }),
        5,
      );
      for (const user of users) {
        assertEquals(await getSignaturesIssued(prisma, poll.id, user.id), 1);
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
  name: "mixed votesAllowed: one user with 1 vote, four with varying quotas",
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

      // 1 + 2 + 3 + 4 + 5 = 15 expected votes.
      const plan = [
        { username: "single", votesAllowed: 1 },
        { username: "double", votesAllowed: 2 },
        { username: "triple", votesAllowed: 3 },
        { username: "quadruple", votesAllowed: 4 },
        { username: "quintuple", votesAllowed: 5 },
      ];
      const users = [];
      for (const p of plan) {
        users.push({
          user: await seedUser(prisma, p.username, "pw"),
          votesAllowed: p.votesAllowed,
          username: p.username,
        });
      }
      const totalExpected = plan.reduce((s, p) => s + p.votesAllowed, 0);

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: users.map((u) => ({
          userId: u.user.id,
          votesAllowed: u.votesAllowed,
        })),
      });

      for (const u of users) {
        const cookies = await fetchUserCredentials(u.username, "pw");
        for (let i = 0; i < u.votesAllowed; i++) {
          const option = poll.options[i % poll.options.length];
          const result = await issueAndCastVote(
            poll.id,
            option.id,
            cookies,
            poll.blindRsaPublicKey!,
          );
          assertEquals(
            result.voteStatus,
            200,
            `User ${u.username} vote ${i + 1} failed: ${result.voteText}`,
          );
        }
      }

      await waitForPollToFinish(prisma, poll.id);

      assertEquals(
        await prisma.vote.count({ where: { pollId: poll.id } }),
        totalExpected,
      );
      for (const u of users) {
        assertEquals(
          await getSignaturesIssued(prisma, poll.id, u.user.id),
          u.votesAllowed,
        );
      }

      // Hash chain must still be intact across all 15 votes.
      const votes = await prisma.vote.findMany({
        where: { pollId: poll.id },
        orderBy: { chainPosition: "asc" },
      });
      assertEquals(votes[0].previousHash, "0");
      for (let i = 1; i < votes.length; i++) {
        assertEquals(votes[i].previousHash, votes[i - 1].currentHash);
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

// ---------------------------------------------------------------------------
// POST /api/poll/:pollId/verify-timestamp
// ---------------------------------------------------------------------------

Deno.test({
  name: "verify-timestamp returns 401 for unauthenticated caller",
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
        voteStatus: "finished",
      });

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/verify-timestamp`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "version": CLIENT_VERSION,
          },
        },
      );

      assertEquals(res.status, 401, await res.text());
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
  name: "verify-timestamp returns 400 for non-integer pollId",
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
        "http://localhost:8000/api/poll/not-a-number/verify-timestamp",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Cookie": cookies,
            "version": CLIENT_VERSION,
          },
        },
      );

      assertEquals(res.status, 400, await res.text());
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
  name: "verify-timestamp returns 403 when poll is not finished",
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
        `http://localhost:8000/api/poll/${poll.id}/verify-timestamp`,
        {
          method: "POST",
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
  name: "verify-timestamp returns 404 when finished poll has no timestamp data",
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
      // Finished poll seeded directly — never went through finishPollWithVoteDrain,
      // so the close artifacts (closeCommitment / closeTimestampToken) are null.
      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "finished",
      });

      const cookies = await fetchUserCredentials(
        "admin",
        env.ADMIN_USER_PASSWORD,
      );

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/verify-timestamp`,
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

      assertEquals(res.status, 404, text);
      assert(text.toLowerCase().includes("timestamp"));
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
  name: "verify-timestamp returns verified:true for a TSA-closed poll",
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

      const result = await issueAndCastVote(
        poll.id,
        poll.options[0].id,
        cookies,
        poll.blindRsaPublicKey!,
      );
      assertEquals(result.voteStatus, 200, result.voteText);
      await waitForPollToFinish(prisma, poll.id);

      const res = await fetch(
        `http://localhost:8000/api/poll/${poll.id}/verify-timestamp`,
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
        200,
        `Expected verify-timestamp to succeed, got ${res.status}: ${text}`,
      );
      const body = JSON.parse(text);
      assertEquals(body.verified, true);
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
// Poll invalidation via integrity check
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "runStartupIntegrityCheck logs integrity gap when signaturesIssued exceeds persisted votes",
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
      const voter = await seedUser(prisma, "voter1", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: voter.id, votesAllowed: 2 }],
      });

      // Simulate a gap: server issued 2 signatures but the votes never
      // reached `Vote` or `PendingVote`. Startup integrity should surface
      // the mismatch for operators without auto-invalidating the poll,
      // because the server cannot distinguish crash-loss from voter
      // abandonment at startup.
      await prisma.pollEligibleVoter.update({
        where: {
          pollId_userId: { pollId: poll.id, userId: voter.id },
        },
        data: { signaturesIssued: 2 },
      });

      await pollManager.runStartupIntegrityCheck();

      const after = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(after.voteStatus, "started");

      const logs = await prisma.auditLog.findMany({
        where: { action: "POLL_INTEGRITY_GAP" },
      });
      assertEquals(logs.length, 1);
      assert(logs[0].details!.includes(`pollId:${poll.id}`));
      assert(logs[0].details!.includes("issued:2"));
      assert(logs[0].details!.includes("persisted:0"));
    } finally {
      await prisma.$disconnect();
      await DB.closeDB();
      await removeSqliteFiles(databaseUrl);
    }
  },
});

Deno.test({
  name:
    "runStartupIntegrityCheck leaves intact poll untouched (no false positive)",
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
      const voter = await seedUser(prisma, "voter1", "pw");

      const poll = await seedPoll(prisma, {
        createdBy: admin.id,
        voteStatus: "started",
        eligibleVoters: [{ userId: voter.id, votesAllowed: 2 }],
      });

      // signaturesIssued=1 matches one persisted vote — integrity holds.
      await prisma.pollEligibleVoter.update({
        where: {
          pollId_userId: { pollId: poll.id, userId: voter.id },
        },
        data: { signaturesIssued: 1 },
      });
      await seedVote(prisma, {
        pollId: poll.id,
        userId: voter.id,
        optionId: poll.options[0].id,
      });

      await pollManager.runStartupIntegrityCheck();

      const after = await prisma.poll.findUniqueOrThrow({
        where: { id: poll.id },
      });
      assertEquals(after.voteStatus, "started");
      assertEquals(
        await prisma.auditLog.count({
          where: { action: "POLL_INVALIDATED_VOTE_LOSS" },
        }),
        0,
      );
    } finally {
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
