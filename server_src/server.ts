import { Hono } from "@hono/hono";
import { setCookie } from "@hono/hono/cookie";
import * as argon2 from "npm:argon2@0.44.0";
import { logger, MIME_TYPES } from "./main_lib.ts";
import { User, WebappDatabase } from "./database.ts";
import { createJWT, hasValidJWT, TOKEN_EXPIRE_TIME } from "./jwt.ts";
import { addUser, assertClientVersion } from "./api.ts";
import { PollManager } from "./pollManager.ts";

/**
 * Start the web application.
 */
export async function startServer() {
  const router = new Hono();

  const databasePath: string = "./database/users.db";
  const _file = await Deno.create(databasePath);
  const DB: WebappDatabase = await WebappDatabase.initDatabase(
    databasePath,
  );

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
    const result = DB.getUserFromDB(userCredentials.username);
    if (result.httpStatusCode !== 200) {
      logger
        .info`Failed to retrieve user from database for username: "${userCredentials.username}". Error message: ${result.errorMsg}`;
      return c.body(``, result.httpStatusCode);
    }
    const user = result.user as User; // This is safe because if httpStatusCode is 200.

    logger.debug(
      `{id: ${user.id}, username: "${user.name}"} succesfully retrived from database.`,
    );

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

    if (argon2Result) { // Password matched.
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
    } else { // password did not match
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
    logger.trace(`router.get("/assets/*", ...) resovled to path: ${filePath}`);

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

  /* User opens the poll page for a specific poll
    This will give the index.html and let bundle.js handle everything. This is because we need to do a post
    with the UUID in, and that will retrieve the actual data.
  */
  router.get("/poll/:pollId", async (c) => {
    try {
      const file = await Deno.readFile("./dist/index.html");
      return c.body(file);
    } catch {
      return c.body("Not Found", { status: 404 });
    }
  });

  router.post("/api/poll/:pollId/open", async (c) => {
    return await hasValidJWT(c, async (payload) => {
      // 1. parse pollId from URL
      const pollIdStr = c.req.param("pollId");
      const pollId = Number(pollIdStr);
      if (Number.isNaN(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      // 2. Parse body --> (UUID: "...")
      let body = undefined;
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid JSON body", 400);
      }

      if (typeof body.UUID !== "string") {
        return c.body("Missing or invalid UUID", 400);
      }
      // body.UUID er nu den klient-genererede UUID

      // 3. get userId from payload (payload.userId)
      const userid = payload.userId as number;

      // 4. Call pollManager.openPoll(pollId, useriD, UUID)
      const pollData = pollManager.openPoll(pollId, userid, body.UUID);
      // 5. if null -> 404  if obect --> c.json(result)
      if (pollData === null) {
        return c.body("Not eligible or poll unavailable", 403);
      }
      return c.json(pollData);
    });
  });

  /* User casta a vote
    1. We verify the login-JWT of the user and the vote-JWT which contains the pollId and voteToken.
    2. We extract optionId from the request body
    3- We cal pollManager.castVote(pollId, userId, optionId, voteToken) which will return true if the vote was succesfully casted and false if not.
    4. We return a response to the client so the client knows if the vote was succesfully casted or not.
  */
  router.post("/api/poll/:pollId/vote", async (c) => {
    return await hasValidJWT(c, async (payload) => {
      // 1. parse polldId from URL + validate
      const pollIdStr = c.req.param("pollId");
      const pollId = Number(pollIdStr);
      if (Number.isNaN(pollId)) {
        return c.body("Invalid pollId", 400);
      }
      // 2 parse body --> {optionId, UUID} + validate
      let body = undefined;
      try {
        body = await c.req.json();
      } catch {
        return c.body("Invalid JSON body", 400);
      }

      if (typeof body.UUID !== "string") {
        return c.body("Missing or invalid UUID", 400);
      }
      if (!Number.isInteger(body.optionId)) {
        return c.body("Missing or invalid optionid", 400);
      }
      // 3. userId from payload
      const userid = payload.userId as number;
      // 4. await pollManager
      const castedVote = await pollManager.castVote(
        pollId,
        userid,
        body.optionId,
        body.UUID,
      );

      // 5. if result.success === false --> errormsg
      if (castedVote.success === false) {
        return c.body(castedVote.errorMsg ?? "Vote failed", 400);
      }

      // if success casted!
      return c.body("Vote cast", 200);
    });
  });

  Deno.serve(router.fetch);
  // closeDB(); // Figure out where to actually close this.
}
