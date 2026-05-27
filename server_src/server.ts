import { Hono } from "@hono/hono";
import { upgradeWebSocket } from "@hono/hono/deno";
import { WSContext } from "@hono/hono/ws";
import { deleteCookie, setCookie } from "@hono/hono/cookie";
import * as argon2 from "npm:argon2@0.44.0";
import { logger, MIME_TYPES } from "./main_lib.ts";
import { WebappDatabase } from "./database.ts";
import { callbackTypes, User } from "../client_src/WebLib.ts";
import { createJWT, hasValidJWT, TOKEN_EXPIRE_TIME } from "./jwt.ts";
import { addUser, assertClientVersion, deleteUser } from "./api.ts";
import { PollManager } from "./pollManager.ts";
import { JWTPayload } from "@panva/jose";

/**
 * Start the web application.
 *
 * @param A instance of a WebappDatabase.
 */
export function startServer(
  DB: WebappDatabase,
  ac: AbortController,
  pollManager = new PollManager(DB),
) {
  const { signal } = ac;
  const router = new Hono();

  // Create a JWT if a user provide a username and password which exists in the users database.
  router.post("/login", async (c) => {
    logger
      .trace`Received login request. Attempting to parse JSON body for username and password.`;

    // Parse user credential from request body. If parsing fails, then the user provided an invalid JSON body and a 400 response is returned.
    let userCredentials = undefined;
    try {
      userCredentials = await c.req.json();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .info`Failed to parse user provided JSON body in /login route. Error message: ${errMsg}`;
      return c.body("Invalid JSON body", 400);
    }

    // Fetch the user from the database with the provided username. If fetching fails, then a non-200 status code is returned from getUserFromDB and the login process is stopped.
    const result = await DB.getUserFromDB(userCredentials.username);
    if (result.httpStatusCode !== 200) {
      logger
        .info`Failed to retrieve user from database for username: "${userCredentials.username}". Error message: ${result.errorMsg}`;
      return c.body(``, result.httpStatusCode);
    }
    const user = result.user as User; // This is safe because if httpStatusCode is 200.

    logger.debug`User: ${user}, succesfully retrived from database.`;

    // Check that the password provided by the user match the stored password hash.
    // Also handle any unexpected errors from argon2 and return a 500 status code in that case.
    let argon2Result = undefined;
    try {
      // https://github.com/ranisalt/node-argon2
      argon2Result = await argon2.verify(
        user.passwordHash,
        userCredentials.password,
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      logger
        .error`Error while verifying password with argon2 for user: {id: ${user.id}, username: "${user.name}"}. Error message: ${errMsg}`;
      return c.body("Internal Server Error", 500);
    }

    if (argon2Result) {
      // Password matched.
      logger
        .debug`Succesfully matched user provided password with database for user: {id: ${user.id}, username: "${user.name}"}`;

      const token = await createJWT({
        userId: user.id,
        username: user.name,
      });

      // https://workos.com/blog/secure-jwt-storage
      // Store the JWT token in an HTTP-cookie which will be sent to the client.
      setCookie(c, "JWT", token, {
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
        maxAge: TOKEN_EXPIRE_TIME,
      });

      // Username cookie for display purposes
      setCookie(c, "user", user.name, {
        secure: true,
        httpOnly: false,
        sameSite: "Strict",
        maxAge: TOKEN_EXPIRE_TIME,
      });

      // This cookie is not secret and is used for browser logic only.
      setCookie(c, "isLoggedIn", "true", {
        secure: true,
        httpOnly: false, // Cookie has to be accessible by scripts.
        sameSite: "Strict",
        maxAge: TOKEN_EXPIRE_TIME,
      });
      logger
        .info`Succesfully created JWT for user: {id: ${user.id}, username: "${user.name}"}`;

      return c.body("login successful", 200);
    } else {
      // password did not match
      logger
        .info`Password did not match for user: {id: ${user.id}, username: "${user.name}"}`;
      return c.body("Login incorrect", 401);
    }

    // deno-lint-ignore no-unreachable
    logger
      .error`Unexpected error during login for user: {id: ${user.id}, username: "${user.name}"}. This should not happen.`;
  });

  /*
  Route: /api/version
  Description:
    Lets the server parse the version of the client and judge if the client has
    the correct version for communicating correctly with the API.
  */
  router.get("/api/version", async (c) => {
    return await hasValidJWT(DB, c, () => {
      const result = assertClientVersion(c);
      return c.json(result);
    });
  });

  router.get("/api/auditlog", async (c) => {
    return await hasValidJWT(DB, c, async () => {
      const result = await DB.getAuditLog();
      return c.json(result, result.httpStatusCode);
    });
  });

  // GET /api/polls — returns a list of all polls for the overview page.
  // Requires a valid JWT so we know who is asking (used for hasVoted and isEligible).
  router.get("/api/polls", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      await pollManager.tickPollStatuses();
      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }
      const isAdmin = payload.username === "admin";
      const polls = await DB.getFrontEndPollObj(userResult.user.id, isAdmin);
      return c.json(polls, 200);
    });
  });

  // GET /admin — serves index.html so React can handle the admin page client-side
  router.get("/admin", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.post("/api/admin/add-user", async (c) => {
    return await hasValidJWT(DB, c, async (verifiedPayload: JWTPayload) => {
      if (verifiedPayload.username !== "admin") {
        // To-do: Create better authentication for this.
        logger.trace`Failed authenication atempt on admin API route.`;
        return c.body("403 Unauthorized", 403);
      }
      const req = await c.req.json();

      const result = await addUser(DB, req.username, req.password); // To-do: add input validation. (We are however admin here so it ain't that bad :])
      return c.body("", result);
    });
  });

  router.delete("/api/admin/delete-user", async (c) => {
    return await hasValidJWT(DB, c, async (verifiedPayload: JWTPayload) => {
      if (verifiedPayload.username !== "admin") {
        // To-do: Create better authentication for this.
        logger.trace`Failed authenication atempt on admin API route.`;
        return c.body("403 Unauthorized", 403);
      }
      const req = await c.req.json();

      const result = await deleteUser(DB, req.username);
      return c.body(result.msg, result.statusCode);
    });
  });

  /*
  Route: /api/me
  Description:
   Validates the JWT and returns the current user's username and admin status.
 */
  router.get("/api/me", async (c) => {
    return await hasValidJWT(DB, c, (payload: JWTPayload) => {
      return c.json({
        username: payload.username,
        isAdmin: payload.username === "admin",
      });
    });
  });

  /**
   * Serves the SPA shell (`dist/index.html`) for the root URL.
   *
   * @remarks
   * This server hosts a Single Page Application (SPA). All HTML routes
   * (this one, `/poll/:pollId`, etc.) return the *same* `dist/index.html`
   * the server never renders different HTML per route.
   *
   * The end-to-end flow:
   *  1. Browser requests an HTML route → server returns `dist/index.html`.
   *  2. The HTML contains a `<script>` tag pointing at the bundled JS,
   *     which Vite builds from `client_src/main.tsx` (and everything it
   *     imports transitively, including `App.tsx`).
   *  3. Browser fetches and executes the bundle. React mounts `<App />`
   *     into `<div id="root">` via `createRoot(...).render(...)`.
   *  4. `App.tsx` reads `window.location.pathname` and chooses which
   *     page-component to render (LoginPage, OverviewPage, BallotPage…).
   *  5. The rendered component fetches its data via seperate
   *  	  data-routes (by convention prefixed `/api/...` , though some like /login are note).
   *  	  Those routes run real server logic and return JSON or status code - unlike the
   *  	  HTML routes, which only serve the SPA shell.
   *
   * Consequence: user-visible URL routing lives entirely in
   * `client_src/App.tsx`. The server only needs to (a) serve the SPA
   * shell for any URL the SPA owns, and (b) serve `/api/...` data.
   */
  router.get("/", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.get("/assets/*", async (c) => {
    const path = new URL(c.req.url).pathname;

    // Sanitize URL path as only the directory "dist" is the only directory to be publicly served.
    // Deno permissions should also catch any attempts to reach any top level directory outside of "dist"
    const filePath = `./dist/${path}`;
    // logger.trace(`router.get("/assets/*", ...) resovled to path: ${filePath}`);

    try {
      const file = await Deno.readFile(filePath);
      const extension = filePath.substring(filePath.lastIndexOf("."));
      const contentType = MIME_TYPES[extension] || "text/plain";

      return c.body(file, {
        headers: {
          "content-type": contentType,
          // "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  /*
  Route: /logout
  Description:
    Clears the cookies on the server, which is needed for httpOnly cookies
  */
  router.post("/logout", (c) => {
    deleteCookie(c, "JWT", {
      secure: true,
      sameSite: "Strict",
    });
    deleteCookie(c, "user", {
      secure: true,
      sameSite: "Strict",
    });
    deleteCookie(c, "isLoggedIn", {
      secure: true,
      sameSite: "Strict",
    });

    return c.body("Logged out", 200);
  });

  /**
   * Serves the SPA shell for a specific poll's ballot page .
   *
   * @remarks
   * The `:pollId` parameter is intentionally unused here -> see the SPA description
   * on {@link `router.get("/")`}. The pollId is
   * parsed from `window.location.pathname` in `App.tsx` and passed to
   * `BallotPage pollId={...} which then calls `POST /api/poll/:pollId/open`to
   * fetch the actual poll data.
   */
  router.get("/poll/:pollId", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.get("/createpoll", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.get("/createpoll/:pollId", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.get("/auditlog", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.get("/poll/:pollId/overview", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  /**
   * Opens a poll for a specific user, returning the data the client needs to render the ballot (options, votes remaining, etc.).
   *
   * @remarks
   * Called by the SPA after `App.tsx` has rendered `<BallotPage pollId={...} />`
   * (See {@link router.get | `router.get("/poll/:pollId")`} for the routing flow).
   *
   * Authentication: requres a valid JWT cookie. The `userId` is read from the
   * JWT payload - never from the request body - so a client cannot open a poll
   * on someone else's behalf.
   *
   * Eligibility, poll-state, and vote-count checks are delegated to
   * {@link PollManager.openPoll}; this handler only deals with HTTP-level
   * parsing and status-code mapping.
   *
   * @returns
   * - `200` + JSON `OpenpollResult - poll opened successfully
   *   `400` "Invalid pollId" - `:pollId`URL segment is not a number.
   *   `401` - missing or invalid JWT (handled by `hasValidJWT`).
   *   `403` + error message - user is not eligible, poll closed, no options,
   *   no votes remaining, etc. (the message comes from `pollManager.openPoll`).
   *
   * @param c - Hono request context. Expects `:pollId`as a URL parameter and a valid `JWT`cookie
   */
  router.post("/api/poll/:pollId/open", (c) => {
    return hasValidJWT(DB, c, async (payload) => {
      const parsePollIdFromURL = c.req.param("pollId");
      const pollId = Number(parsePollIdFromURL);
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      const userId = payload.userId as number;
      const pollData = await pollManager.openPoll(pollId, userId);
      if (pollData.errorMsg) {
        return c.body(pollData.errorMsg, 403);
      }
      return c.json(pollData.result);
    });
  });

  /**
   * Cast a vote for a specific user, and a specific poll.
   *
   * @remarks
   * The server tries to validate the given data to see if fits the requirements before
   * the actual inserting of the vote is handed of to {@link PollManager.castVote}.
   * First we parse the pollId from the URL and validate if its an actual pollId.
   * Then we parse the body to see if its an actual array of votes. Each vote is an
   * object which includes optionId and a UUID. so each vote should be an object.
   * However null is only returned as an object and therefore we must ensure that the votes is not null,
   * if it is we need to reject the vote.
   * Next up we validate the contents of each vote is the correct type (pollOptionId should be an integer
   * and UUID is a string.
   *
   * @param c - Hono context. Expects:
   * - URL parameter `:pollId`(integer)
   * - Cookie `JWT` (signed token whose payload supplies `userId`).
   * - JSON body of shape `{votes: Array<{optionId: number, UUID: string}>}`
   *
   * @returns
   * Returns a hono context object with a body of a string and a status code.
   * `200` means it was succesfull, `400` there was an error, and the string is an error message.
   */
  router.post("/api/poll/:pollId/vote", async (c) => {
    // INTENTIONAL: no `hasValidJWT` wrapper. The cast endpoint is anonymous
    // by design — authorization comes from the blind signature, not the
    // session. If you ever feel tempted to add auth here, see the threat
    // model in the implementation plan: it collapses the entire privacy
    // guarantee.
    const pollIdFromURL = c.req.param("pollId");
    const pollId = Number(pollIdFromURL);
    if (!Number.isInteger(pollId)) {
      return c.body("Invalid pollId", 400);
    }
    const pollStatus = await DB.getPollPrivacyLabel(pollId);
    if (pollStatus === null) {
      return c.body("BallotPrivacy returned null", 400);
    }
    if (pollStatus === "secret") {
      let body: { uuid?: unknown; signature?: unknown; optionId?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid JSON body", 400);
      }
      if (
        typeof body.uuid !== "string" ||
        typeof body.signature !== "string" ||
        !Number.isInteger(body.optionId)
      ) {
        return c.body("Invalid vote body", 400);
      }
      const castedVote = await pollManager.castVote(
        pollId,
        {
          ballotPrivacy: pollStatus,
          uuid: body.uuid,
          signature: body.signature,
          optionId: body.optionId as number,
        },
      );
      if (castedVote.success === false) {
        return c.body(
          castedVote.errorMsg ?? "Vote failed",
          castedVote.httpStatusCode,
        );
      }

      // Notify connected clients to refetch tallies. The lookup uses
      // eligibleVoters, not anything about the caster, so it does not leak
      // who cast the vote.
      const eligibleVotersResult = await DB.getAllEligibleVotersForPoll(pollId);
      if (
        eligibleVotersResult.httpStatusCode !== 200 ||
        !eligibleVotersResult.voters
      ) {
        logger
          .error`Failed to retrieve eligible voters for pollId: ${pollId} after casting vote. Error message: ${eligibleVotersResult.errorMsg}`;
      }
      for (const voter of eligibleVotersResult.voters ?? []) {
        const ws = clientWebsockets.get(voter.userId);
        if (ws) {
          ws.send(JSON.stringify({
            type: callbackTypes.refetchVoteCount,
            pollId,
          }));
        }
      }

      return c.body("Vote cast", 200);
    }
    return await hasValidJWT(DB, c, async (payload) => {
      let body = undefined;
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid JSON body", 400);
      }
      if (!Array.isArray(body.votes)) {
        return c.body("Missing or invalid votes array", 400);
      }
      const hasValidVotes = body.votes.every((vote: unknown) => {
        if (typeof vote !== "object" || vote == null) return false;
        const v = vote as { optionId?: unknown; uuid?: unknown };
        return Number.isInteger(v.optionId) && typeof v.uuid === "string";
      });

      if (!hasValidVotes) {
        return c.body("Invalid vote shape", 400);
      }
      const userid = payload.userId as number;
      const castedVote = await pollManager.castVote(pollId, {
        ballotPrivacy: "open",
        userId: userid,
        votes: body.votes.map((v: { uuid: string; optionId: number }) => ({
          uuid: v.uuid,
          optionId: v.optionId,
        })),
      });
      if (castedVote.success === false) {
        return c.body(castedVote.errorMsg ?? "Vote failed", 400);
      }

      // Calulate the effect of casting the vote for front end clients and send update signal via websockets for effected clients.
      const eligibleVotersResult = await DB.getAllEligibleVotersForPoll(pollId);
      if (
        eligibleVotersResult.httpStatusCode !== 200 ||
        !eligibleVotersResult.voters
      ) {
        logger
          .error`Failed to retrieve eligible voters for pollId: ${pollId} after casting vote. Error message: ${eligibleVotersResult.errorMsg}`;
      }
      logger.trace`eligibleVotersResult.voters: ${eligibleVotersResult.voters}`;
      for (const voter of eligibleVotersResult.voters ?? []) {
        const ws = clientWebsockets.get(voter.userId);
        logger.trace`ws: ${ws}`;
        if (ws) {
          logger
            .trace`Sending websocket message to userId: ${voter.userId} about new vote cast for pollId: ${pollId}`;
          ws.send(JSON.stringify({
            type: callbackTypes.refetchVoteCount,
            pollId,
          }));
        }
      }

      return c.body("Vote cast", 200);
    });
  });

  /**
   * Issue a blind signature on a client-supplied blinded message
   * (RFC 9474 §4.3). This is the issuance half of the secret-vote
   * protocol — the server checks the user's quota under JWT auth, signs
   * the blinded bytes, increments the per-(poll,user) counter, and
   * returns the blind signature. The server never sees the unblinded
   * UUID.
   *
   * @param c - Hono context. Expects:
   * - URL parameter `:pollId` (integer)
   * - Cookie `JWT` (signed token whose payload supplies `userId`).
   * - JSON body `{ blinded: string }` — base64 of the blinded message.
   *
   * @returns
   * `200` with JSON `{ blindSig: string }` on success.
   * `400` if `:pollId` or body is malformed.
   * `403` if the user is not eligible, the poll is not open, or the
   * signature quota is exhausted.
   * `404` if the poll does not exist.
   * `500` on DB / signing error.
   */
  router.post("/api/poll/:pollId/blindsign", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      const pollIdFromURL = c.req.param("pollId");
      const pollId = Number(pollIdFromURL);
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      let body = undefined;
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid JSON body", 400);
      }
      if (typeof body.blinded !== "string" || body.blinded.length === 0) {
        return c.body("Missing or invalid 'blinded' field", 400);
      }
      const userId = payload.userId as number;
      const result = await pollManager.issueBlindSignature(
        pollId,
        userId,
        body.blinded,
      );
      if (result.errorMsg || !result.blindSignatureB64) {
        return c.body(
          result.errorMsg ?? "Blind signature failed",
          result.httpStatusCode,
        );
      }
      return c.json({ blindSig: result.blindSignatureB64 });
    });
  });

  /**
   * Fetch the results of a finished poll.
   *
   * @remarks
   * Validation and access control is delegated to {@link PollManager.getResults}: the route
   * handler only parses `:pollId` from the URL and forwards the result. The shape of the
   * returned JSON depends on the poll's `ballotPrivacy` (see `ResultsPayload` in `WebLib.ts`):
   * for `"secret"` polls only UUIDs are returned, for `"open"` polls each UUID is paired
   * with the option it was cast for.
   *
   * @param c - Hono context. Expects:
   * - URL parameter `:pollId` (integer)
   * - Cookie `JWT` (signed token).
   *
   * @returns
   * `200` with a `ResultsPayload` JSON body on success.
   * `400` if `:pollId` is not a valid integer or the poll does not exist.
   * `403` if the poll is not finished.
   * `500` on DB error. The body is the error message in all non-200 cases.
   */
  router.get("/api/poll/:pollId/results", async (c) => {
    return await hasValidJWT(DB, c, async () => {
      const pollIdFromURL = c.req.param("pollId");
      const pollId = Number(pollIdFromURL);
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      const results = await pollManager.getResults(pollId);
      if (!results.result) {
        return c.body(
          results.errorMsg ?? "Failed to fetch results",
          results.httpStatusCode,
        );
      }
      return c.json(results.result, results.httpStatusCode);
    });
  });

  router.post("/api/poll/:pollId/verify-timestamp", async (c) => {
    return await hasValidJWT(DB, c, async () => {
      const pollIdFromURL = c.req.param("pollId");
      const pollId = Number(pollIdFromURL);
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      const result = await pollManager.verifyResultsTimestamp(pollId);
      if (result.verified === undefined) {
        return c.body(
          result.errorMsg ?? "Failed to verify timestamp",
          result.httpStatusCode,
        );
      }
      return c.json({ verified: result.verified }, 200);
    });
  });

  router.get("/api/poll/:pollId/timestamp-token", async (c) => {
    return await hasValidJWT(DB, c, async () => {
      const pollId = Number(c.req.param("pollId"));
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }

      const result = await DB.getPollTimestampToken(pollId);
      if (!result.timestampToken) {
        return c.body(
          result.errorMsg ?? "Timestamp token not found",
          result.httpStatusCode,
        );
      }

      return c.body(result.timestampToken, {
        headers: {
          "Content-Type": "application/timestamp-reply",
          "Content-Disposition": `attachment; filename="poll-${pollId}.tsr"`,
        },
      });
    });
  });

  router.get("/api/poll/:pollId/timestamp-query", async (c) => {
    return await hasValidJWT(DB, c, async () => {
      const pollId = Number(c.req.param("pollId"));
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }

      const result = await DB.getPollTimestampQuery(pollId);
      if (!result.timestampQuery) {
        return c.body(
          result.errorMsg ?? "Timestamp query not found",
          result.httpStatusCode,
        );
      }

      return c.body(result.timestampQuery, {
        headers: {
          "Content-Type": "application/timestamp-query",
          "Content-Disposition": `attachment; filename="poll-${pollId}.tsq"`,
        },
      });
    });
  });

  router.get("/poll/:pollId/results", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  // POST /api/polls — create a new poll (a DRAFT — it is ALWAYS a draft) from CreatePollPage.
  // Body: { poll: Poll, voters: Array<{username, votesAllowed}>, choices: string[] }
  // createdBy is taken from the JWT, not from the request body.
  router.post("/api/polls", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      let body = undefined;
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid JSON body", 400);
      }
      if (!body || typeof body !== "object") {
        return c.body("Invalid body", 400);
      }
      if (!body.poll || typeof body.poll !== "object") {
        return c.body("Missing poll", 400);
      }

      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }

      const result = await pollManager.createPoll(userResult.user.id, {
        poll: body.poll,
      });

      if (result.pollId === undefined) {
        return c.body(
          result.errorMsg ?? "Error creating poll",
          result.httpStatusCode,
        );
      }
      return c.json({ pollId: result.pollId }, result.httpStatusCode);
    });
  });

  /**
   * PATCH `/api/polls/:pollId` — updates an existing poll, optionally
   * replacing its options and/or eligible voters. Requires a valid JWT;
   * authorization (whether the caller is allowed to edit this specific
   * poll) is delegated to `pollManager.updatePoll`.
   *
   * Path params:
   * - `pollId` — must parse as an integer, else `400 Invalid pollId`.
   *
   * Request body (`application/json`):
   * - `poll` *(required)* — partial poll fields to update. Only fields
   *   present here are written; missing fields are left untouched.
   * - `choices` *(optional)* — array of option texts. If provided, fully
   *   replaces the poll's existing options.
   * - `voters` *(optional)* — array of `{ username: string;
   *   votesAllowed: integer }`. If provided, fully replaces the poll's
   *   existing eligible voters. `username` is resolved to a user id
   *   downstream.
   *
   * Responses:
   * - `200` — update applied.
   * - `400` — malformed JSON, missing `poll`, or `voters` / `choices`
   *   failing shape validation.
   * - `401` — JWT invalid or the authenticated user no longer exists.
   * - other — propagated from `pollManager.updatePoll` (e.g. `500` on
   *   transaction failure), with the manager's `errorMsg` as the body.
   */

  router.patch("/api/polls/:pollId", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      const pollIdFromURL = c.req.param("pollId");
      const pollId = Number(pollIdFromURL);
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      let body = undefined;
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid body", 400);
      }
      if (!body || typeof body !== "object") {
        return c.body("Invalid body", 400);
      }
      if (!body.poll || typeof body.poll !== "object") {
        return c.body("Missing poll", 400);
      }
      if (body.voters !== undefined) {
        if (!Array.isArray(body.voters)) {
          return c.body("voters must be an array", 400);
        }
        for (const v of body.voters) {
          if (
            !v || typeof v !== "object" ||
            typeof v.username !== "string" ||
            !Number.isInteger(v.votesAllowed)
          ) {
            return c.body(
              "voters must be objects with username (string) and votesAllowed (integer)",
              400,
            );
          }
        }
      }
      if (body.choices !== undefined && !Array.isArray(body.choices)) {
        return c.body("choices must be an array", 400);
      }
      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }

      const result = await pollManager.updatePoll(userResult.user.id, pollId, {
        poll: body.poll,
        optionTexts: body.choices,
        voters: body.voters,
      });

      if (result.httpStatusCode !== 200) {
        return c.body(
          result.errorMsg ?? "Error updating poll",
          result.httpStatusCode,
        );
      }

      return c.body(null, 200);
    });
  });

  /**
   * POST `/api/polls/:pollId/publish` — promotes a draft poll to a
   * published state, atomically setting its final options and eligible
   * voters in the same call. Requires a valid JWT; authorization
   * (whether the caller is allowed to publish this poll, and whether
   * the poll is in a publishable state) is delegated to
   * `pollManager.publishPoll`.
   *
   * Unlike PATCH, both `voters` and `choices` are required here: a poll
   * cannot transition out of draft without a complete option set and
   * voter roll.
   *
   * Path params:
   * - `pollId` — must parse as an integer, else `400 Invalid pollId`.
   *
   * Request body (`application/json`):
   * - `poll` *(required)* — poll fields to apply at publish time
   *   (e.g. title, description, startsAt/endsAt, ballotPrivacy).
   * - `choices` *(required)* — array of option texts. Fully replaces
   *   any existing options on the poll.
   * - `voters` *(required)* — array of `{ username: string;
   *   votesAllowed: integer }`. Fully replaces the poll's eligible
   *   voter roll. `username` is resolved to a user id downstream.
   *
   * Responses:
   * - `200` — poll published.
   * - `400` — malformed JSON, missing `poll`, or `voters` / `choices`
   *   missing or failing shape validation.
   * - `401` — JWT invalid or the authenticated user no longer exists.
   * - other — propagated from `pollManager.publishPoll` (e.g. `403` if
   *   the caller may not publish, `500` on transaction failure), with
   *   the manager's `errorMsg` as the body.
   */
  router.post("/api/polls/:pollId/publish", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      const pollIdFromURL = c.req.param("pollId");
      const pollId = Number(pollIdFromURL);
      if (!Number.isInteger(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      let body = undefined;
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid body", 400);
      }
      if (!body || typeof body !== "object") {
        return c.body("Invalid body", 400);
      }
      if (!body.poll || typeof body.poll !== "object") {
        return c.body("Missing poll", 400);
      }

      if (!Array.isArray(body.voters) || !Array.isArray(body.choices)) {
        return c.body("voters and choices must be arrays", 400);
      }
      for (const v of body.voters) {
        if (
          !v || typeof v !== "object" ||
          typeof v.username !== "string" ||
          !Number.isInteger(v.votesAllowed)
        ) {
          return c.body(
            "voters must be objects with username (string) and votesAllowed (integer)",
            400,
          );
        }
      }
      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }

      const result = await pollManager.publishPoll(userResult.user.id, pollId, {
        poll: body.poll,
        optionTexts: body.choices,
        voters: body.voters,
      });
      if (result.httpStatusCode !== 200) {
        return c.body(
          result.errorMsg ?? "Error publishing poll",
          result.httpStatusCode,
        );
      }

      return c.body(null, 200);
    });
  });

  /**
   * DELETE `/api/polls/:pollId` — deletes a poll. Requires a valid JWT;
   * authorization (whether the caller is allowed to delete this poll)
   * is delegated to `pollManager.deletePoll`. Cascading of related
   * rows (options, eligible voters, votes) is governed by the schema's
   * foreign-key rules, not by this handler.
   *
   * Path params:
   * - `pollId` — must parse as an integer, else `400 Invalid pollId`.
   *
   * Responses:
   * - `200` — poll deleted.
   * - `400` — `pollId` is not a valid integer.
   * - `401` — JWT invalid or the authenticated user no longer exists.
   * - other — propagated from `pollManager.deletePoll` (e.g. `403` if
   *   the caller may not delete, `404` if the poll does not exist,
   *   `500` on database failure), with the manager's `errorMsg` as the
   *   body.
   */
  router.delete("/api/polls/:pollId", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      const pollId = Number(c.req.param("pollId"));
      if (!Number.isInteger(pollId)) return c.body("Invalid pollId", 400);

      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }

      const result = await pollManager.deletePoll(userResult.user.id, pollId);
      if (result.httpStatusCode !== 200) {
        return c.body(
          result.errorMsg ?? "Error deleting poll",
          result.httpStatusCode,
        );
      }
      return c.body(null, 200);
    });
  });

  /**
   * GET `/api/polls/:pollId` — fetches a poll's current editable state
   * (poll fields, options, and eligible voters) for the edit/publish UI.
   * Despite the generic path, this delegates to `pollManager.getDraft`,
   * which applies the same authorization checks as the edit endpoints —
   * this is not a public read endpoint for finished polls.
   *
   * Path params:
   * - `pollId` — must parse as an integer, else `400 Invalid pollId`.
   *
   * Responses:
   * - `200` — JSON body with the poll's editable state, as returned by
   *   `pollManager.getDraft`.
   * - `400` — `pollId` is not a valid integer.
   * - `401` — JWT invalid or the authenticated user no longer exists.
   * - other — propagated from `pollManager.getDraft` (e.g. `403` if the
   *   caller may not view this poll, `404` if it does not exist), with
   *   the manager's `errorMsg` as the body. Note that a missing
   *   `result.result` is treated as a non-success even if the manager
   *   returned `200`.
   */
  router.get("/api/polls/:pollId", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      const pollId = Number(c.req.param("pollId"));
      if (!Number.isInteger(pollId)) return c.body("Invalid pollId", 400);

      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }

      const result = await pollManager.getDraft(userResult.user.id, pollId);
      if (result.httpStatusCode !== 200 || !result.result) {
        return c.body(result.errorMsg ?? "Error", result.httpStatusCode);
      }
      return c.json(result.result);
    });
  });

  /**
   * GET `/api/polls/:pollId/overview` — returns a summary view of a
   * poll suitable for an overview / status page (e.g. current
   * status, vote totals or progress) as opposed to the full editable
   * state served by `GET /api/polls/:pollId`. Requires a valid JWT;
   * visibility rules (who is allowed to see the overview for this poll)
   * are delegated to `pollManager.getPollOverview`.
   *
   * Path params:
   * - `pollId` — must parse as an integer, else `400 Invalid pollId`.
   *
   * Responses:
   * - `200` — JSON body with the overview payload returned by
   *   `pollManager.getPollOverview`.
   * - `400` — `pollId` is not a valid integer.
   * - `401` — JWT invalid or the authenticated user no longer exists.
   * - other — propagated from `pollManager.getPollOverview` (e.g. `403`
   *   if the caller may not view this poll, `404` if it does not
   *   exist), with the manager's `errorMsg` as the body. A missing
   *   `result.result` is treated as a non-success even if the manager
   *   returned `200`.
   */
  router.get("/api/polls/:pollId/overview", async (c) => {
    return await hasValidJWT(DB, c, async (payload) => {
      const pollId = Number(c.req.param("pollId"));
      if (!Number.isInteger(pollId)) return c.body("Invalid pollId", 400);

      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }

      const result = await pollManager.getPollOverview(
        userResult.user.id,
        pollId,
      );
      if (result.httpStatusCode !== 200 || !result.result) {
        return c.body(result.errorMsg ?? "Error", result.httpStatusCode);
      }
      return c.json(result.result);
    });
  });

  /**
   * GET `/api/users` — returns the id and username of every user in the
   * database. Used to populate user pickers (e.g. when assigning
   * eligible voters to a poll). Requires a valid JWT, but is otherwise
   * unscoped — any authenticated user can list all users.
   *
   * Responses:
   * - `200` — JSON body `{ users, httpStatusCode, errorMsg? }` from
   *   `DB.getAllUsersFromDB`. `users` may be empty (with `errorMsg`
   *   set) if the table contains no users; this is still a `200`.
   * - `401` — JWT invalid.
   * - `500` — database query failed; `users` is `[]` and `errorMsg` is
   *   set.
   *
   * @remarks
   * The full result object — including `httpStatusCode` and any
   * `errorMsg` — is serialized into the response body, not just the
   * `users` array. Clients should read `body.users` rather than
   * assuming the body is a bare array.
   */
  router.get("/api/users", async (c) => {
    return await hasValidJWT(DB, c, async () => {
      const results = await DB.getAllUsersFromDB();
      return c.json(results, results.httpStatusCode);
    });
  });
  /* Map containting active websockets tied to the user id of the connected client.
   */
  const clientWebsockets = new Map<number, WSContext>();

  /**
   * Websocket route for sending real-time updates to clients. The websocket connection is kept alive in the `clientWebsockets` map, where the key is the userId of the client and the value is the WSContext object which can be used to send messages to the client. The WSContext is created when a client connects to this route and is removed from the map when the connection is closed. Currently this websocket is used to send updates to clients when a vote is cast, so clients can update their UI without needing to poll for changes.
   * Authentication is done via the `hasValidJWT` function, so only clients with a valid JWT cookie can establish a websocket connection.
   */
  router.get(
    "/api/websocket",
    async (c) => {
      return await hasValidJWT(DB, c, async (payload) => {
        const response = await upgradeWebSocket(() => {
          return {
            onOpen(_event, ws) {
              logger.trace`WebSocket connection opened for ${payload.username}`;
              clientWebsockets.set(payload.userId as number, ws);
            },
            onMessage(event, _ws) {
              logger.trace`Received WebSocket message: ${event.data}`;
            },
            onClose: () => {
              logger.trace`Connection closed for ${payload.username}`;
              clientWebsockets.delete(payload.userId as number); // To-do: Create better clean up of closed connections.
            },
          };
        })(c, () => Promise.resolve());

        return response ?? c.body("Failed to upgrade WebSocket", 400);
      });
    },
  );

  // Deno.addSignalListener("SIGINT", () => {
  //   logger.info`Caught SIGINT, shutting down...`;
  //   ac.abort(); // Gracefully shut down server
  //   DB.closeDB;
  //   Deno.exit(0); // Ensure zero exit code
  // });

  const server = Deno.serve({ signal }, router.fetch);

  return server.finished;

  // closeDB(); // Figure out where to actually close this.
}
