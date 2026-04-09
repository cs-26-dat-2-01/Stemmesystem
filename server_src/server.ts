import { Hono } from "@hono/hono";
import { setCookie } from "@hono/hono/cookie";
import { getUserFromDB } from "./database.ts";
import { createJWT, hasValidJWT, TOKEN_EXPIRE_TIME } from "./jwt.ts";
import * as argon2 from "npm:argon2@0.44.0";

// --- Import the LogTape config --------------------
import "./logtape_config.ts";
import { getLogger } from "@logtape/logtape";
const logger = getLogger(["server-backend"]);
// --------------------------------------------------

const VERSION = { x: 0, y: 0, z: 0 };

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

const router = new Hono();

// Create a JWT if a user provide a username and password which exists in the users database.
router.post("/login", async (c) => {
  const userCredentials = await c.req.json();

  const username: string = userCredentials.username;
  const password: string = userCredentials.password;

  const user = getUserFromDB(username);

  if (
    user?.httpStatusCode === 200 &&
    typeof user.user?.passwordHash === "string"
  ) {
    logger.debug(
      `{{id: ${user.user.id}, username: "${user.user.username}"}} succesfully retrived from database.`,
    );

    // Handle errors from argon2
    try { // https://github.com/ranisalt/node-argon2
      if (await argon2.verify(user.user?.passwordHash, password)) { // Password matched, then a JWT token is created.
        logger.debug(
          `Succesfully matched user provided password with database for user: {{id: ${user.user.id}, username: "${user.user.username}"}}`,
        );

        const token = await createJWT({
          userId: user.user?.id,
          username: user.user?.username,
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
          httpOnly: false, // Has to be accessible by scripts.
          sameSite: "Strict",
          maxAge: TOKEN_EXPIRE_TIME,
        });
        logger.info(
          `Succesfully created JWT for user: {{id: ${user.user.id}, username: "${user.user.username}"}}`,
        );

        return c.body("login successful", 200);
      } else { // password did not match
        logger.info(
          `Password did not match for user: {{id: ${user.user.id}, username: "${user.user.username}"}}`,
        );
      }
    } catch (err) { /* internal failure */ }
  } else if (user?.httpStatusCode === 400) {
    return c.body(`${user.errorMsg}`);
  }

  return c.body("Login incorrect", 401);
});

// https://semver.org/
router.get("/api/:version", async (c) => {
  return await hasValidJWT(c, () => {
    const versionStr = c.req.param("version");
    const [x, y, z] = versionStr.split(".");

    const response = {
      version: `${x}.${y}.${z}`,
    };

    return c.body(JSON.stringify(response), 200, {
      "Content-Type": "application/json",
    });
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

Deno.serve(router.fetch);
// closeDB(); // Figure out where to actually close this.
