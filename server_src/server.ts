import { Hono } from "@hono/hono";
import { deleteCookie, setCookie } from "@hono/hono/cookie";
import * as argon2 from "npm:argon2@0.44.0";
import { logger, MIME_TYPES } from "./main_lib.ts";
import { WebappDatabase } from "./database.ts";
import { User } from "../client_src/WebLib.ts";
import { createJWT, hasValidJWT, TOKEN_EXPIRE_TIME } from "./jwt.ts";
import { addUser, assertClientVersion } from "./api.ts";
import { PollManager } from "./pollManager.ts";

/**
 * Start the web application.
 *
 * @param A instance of a WebappDatabase.
 */
export function startServer(DB: WebappDatabase, ac: AbortController) {
  const { signal } = ac;

  const router = new Hono();

  const pollManager = new PollManager(DB);
  // Create a JWT if a user provide a username and password which exists in the users database.
  router.post("/login", async (c) => {
    logger
      .info`Received login request. Attempting to parse JSON body for username and password.`;

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
    return await hasValidJWT(c, () => {
      const result = assertClientVersion(c);
      return c.json(result);
    });
  });

  router.get("/api/auditlog", async (c) => {
    const result = await DB.getAuditLog();
    return c.json(result, result.httpStatusCode);
  });

  // GET /api/polls — returnerer liste af alle afstemninger til oversigts-siden.
  // Kræver gyldigt JWT så vi ved hvem der spørger (bruges til hasVoted og isEligible).
  router.get("/api/polls", async (c) => {
    return await hasValidJWT(c, async (payload) => {
      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }
      const polls = await DB.getFrontEndPollObj(userResult.user.id);
      return c.json(polls, 200);
    });
  });

  // GET /admin — sender index.html så React kan håndtere admin-siden client-side
  router.get("/admin", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.post("/api/admin/add-user", async (c) => {
    return await hasValidJWT(c, async (verifiedPayload) => {
      if (verifiedPayload.username !== "admin") { // To-do: Create better authentication for this.
        logger.trace`Failed authenication atempt on admin API route.`;
        return c.body("401 Unauthorized", 401);
      }
      const req = await c.req.json();

      const result = await addUser(DB, c, req.username, req.password); // To-do: add input validation. (We are however admin here so it ain't that bad :])
      return c.body("", result);
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

  router.get("/auditlog", async (c) => {
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
    return hasValidJWT(c, async (payload) => {
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

  /*
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
    return await hasValidJWT(c, async (payload) => {
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
      if (!Array.isArray(body.votes)) {
        return c.body("Missing or invalid votes array", 400);
      }
      const hasValidVotes = body.votes.every((vote: unknown) => {
        if (typeof vote !== "object" || vote == null) return false;
        const v = vote as { optionId?: unknown; UUID?: unknown };
        return Number.isInteger(v.optionId) && typeof v.UUID === "string";
      });

      if (!hasValidVotes) {
        return c.body("Invalid vote shape", 400);
      }
      const userid = payload.userId as number;
      const castedVote = await pollManager.castVote(
        pollId,
        userid,
        body.votes,
      );
      if (castedVote.success === false) {
        return c.body(castedVote.errorMsg ?? "Vote failed", 400);
      }
      return c.body("Vote cast", 200);
    });
  });

  /*
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
    return await hasValidJWT(c, async () => {
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

  router.get("/poll/:pollId/results", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  // POST /api/polls — opret ny afstemning (KLADDE, ALTSÅ DET VIL ALTID VÆRE DRAFT) fra CreatePollPage.
  // Body: { poll: Poll, voters: string[], choices: string[] }
  // createdBy hentes fra JWT, ikke fra request body.
  router.post("/api/polls", async (c) => {
    return await hasValidJWT(c, async (payload) => {
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

  // PATCH /api/polls/:pollId til at opdaterer (autosave, klade gem og side-overgange)
  router.patch("/api/polls/:pollId", async (c) => {
    return await hasValidJWT(c, async (payload) => {
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
      if (body.voters !== undefined && !Array.isArray(body.voters)) {
        return c.body("voters must be an array", 400);
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
        voterUsernames: body.voters,
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

  // POST /api/polls/:pollid/publish til endelig udgivelse. kalder pollManager.publishPoll(...)
  router.post("/api/polls/:pollId/publish", async (c) => {
    return await hasValidJWT(c, async (payload) => {
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
      const userResult = await DB.getUserFromDB(payload.username as string);
      if (userResult.httpStatusCode !== 200 || !userResult.user) {
        return c.body("401 Unauthorized", 401);
      }

      const result = await pollManager.publishPoll(userResult.user.id, pollId, {
        poll: body.poll,
        optionTexts: body.choices,
        voterUsernames: body.voters,
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

router.delete("/api/polls/:pollId", async (c) => {
    return await hasValidJWT(c, async (payload) => {
      const pollId = Number(c.req.param("pollId"));                             
      if (!Number.isInteger(pollId)) return c.body("Invalid pollId", 400);      
                                                                                
      const userResult = await DB.getUserFromDB(payload.username as string);    
      if (userResult.httpStatusCode !== 200 || !userResult.user) {              
        return c.body("401 Unauthorized", 401);                                 
      }                                                                         
  
      const result = await pollManager.deletePoll(userResult.user.id, pollId);  
      if (result.httpStatusCode !== 200) {
        return c.body(result.errorMsg ?? "Error deleting poll",                 
  result.httpStatusCode);                                                       
      }                                                                         
      return c.body(null, 200);                                                 
    });           
  });


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
