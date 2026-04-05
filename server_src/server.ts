import { Hono } from "@hono/hono";
import { setCookie } from "@hono/hono/cookie";
import { closeDB, getUserFromDB } from "./database.ts";
import { createJWT, hasVaildJWT, TOKEN_EXPIRE_TIME } from "./jwt.ts";
import * as argon2 from "npm:argon2@0.44.0";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

const router = new Hono();

// Create a JWT if a user provide a username and password which is stored in the users database.
router.get("/login", async (c) => {
  const username: string = c.req.header("Username") ?? "";
  const password: string = c.req.header("Password") ?? "";

  const user = getUserFromDB(username);
  if (
    user?.httpStatusCode === 200 &&
    typeof user.user?.passwordHash === "string"
  ) {
    // https://github.com/ranisalt/node-argon2
    try {
      if (await argon2.verify(user.user?.passwordHash, password)) {
        // Password matched, then a JWT token is created.
        const token = await createJWT({
          userId: user.user?.id,
          username: user.user?.username,
        });
        console.log("Created JWT:", token);

        // https://workos.com/blog/secure-jwt-storage
        // Store the JWT token in an HTTP-cookie which will be sent to the client.
        setCookie(c, "JWT", token, {
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
          maxAge: TOKEN_EXPIRE_TIME,
        });

        return c.body("login successful", 200);
      } else {
        // password did not match
      }
    } catch (err) {
      // internal failure
    }
  } else if (user?.httpStatusCode === 500) {
    return c.body("Internal Server Error", user.httpStatusCode);
  }

  return c.body("Login incorrect", 400);
});

router.get("/api/:a", (c) => {
  return hasVaildJWT(c, () => {
    const a = c.req.param("a");
    console.log("Hit: " + a);

    return c.body("Parameters: " + a);
  });
});

router.get("/", async (c) => {
  const file = await Deno.readFile("./dist/index.html");
  return c.body(file);
});

router.get("/assets/*", async (c) => {
  const path = new URL(c.req.url).pathname;

  // Sanitize URL path as only the directory "dist" is the only directory to be publicly served.
  // Deno permissions should also catch any attempts to reach any top level directory outside of "dist"
  const filePath = `./dist/${path}`;

  try {
    const file = await Deno.readFile(filePath);
    const extension = filePath.substring(filePath.lastIndexOf("."));
    const contentType = MIME_TYPES[extension] || "text/plain";

    return new Response(file, {
      headers: {
        "content-type": contentType,
        // "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
});

Deno.serve(router.fetch);
// closeDB(); // Figure out where to actually close this.
