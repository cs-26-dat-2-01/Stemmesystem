import { Context, Hono } from "@hono/hono";
import { JWTPayload, jwtVerify, SignJWT } from "@panva/jose";
import { BlankEnv, BlankInput } from "@hono/hono/types";
import { setCookie } from "@hono/hono/cookie";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

const TOKEN_EXPIRE_TIME = 43200; // Defined in seconds.

// https://docs.deno.com/examples/creating_and_verifying_jwt/
const secret = new TextEncoder().encode("secret-that-no-one-knows");

async function createJWT(payload: JWTPayload): Promise<string> {
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRE_TIME + "sec")
    .sign(secret);

  return jwt;
}

async function verifyJWT(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    console.log("JWT is valid:", payload);
    return payload;
  } catch (error) {
    console.error("Invalid JWT:", error);
    return null;
  }
}

const token = await createJWT({ userId: 123, username: "john" });
console.log("Created JWT:", token);

const verifiedPayload = await verifyJWT(token);
console.log("Verified Payload:", verifiedPayload);

/**
 * Checks if a incomming request has a vaild JWT in its "Authorization" header.
 * If no vaild JWT is found it redirects to login page.
 *
 * @param c   - The context given by Hono for the request
 * @param fn  - The logic encasulated in a function run on vaild JWT.
 */
async function hasVaildJWT(
  c: Context<BlankEnv, "/", BlankInput>,
  fn: () => void,
) {
  // Retrive the JWT token.
  let auth_token = c.req.header("Cookie"); // Note: We dont need to directly check if the cookie is vaild as the JWT it self contains expiry info.

  if (typeof auth_token === "string") {
    auth_token = auth_token.slice(auth_token.indexOf("=") + 1); // Remove name part of cookie.

    const verifiedPayload = await verifyJWT(auth_token);
    console.log("Verified Payload:", verifiedPayload);
    if (verifiedPayload) {
      fn();
    }
  } else {
    console.log("No auth token found");
  }

  return c.body("Lack of vaild authentication credentials.", {
    status: 401,
  });
}

const router = new Hono();

router.get("/login", async (c) => {
  const data = JSON.parse(
    await Deno.readTextFile("./server_src/users_db.json"),
  );
  const username = c.req.header("Username");
  const password = c.req.header("Password");

  for (let i = 0;; i++) {
    const user = data.users[i];

    if (user === undefined) {
      break; // If user is undefined we reached the end of users db
    } else {
      if (password == user.password && username == user.username) {
        const token = await createJWT({
          userId: user.id,
          username: user.username,
        });
        console.log("Created JWT:", token);

        const verifiedPayload = await verifyJWT(token);
        console.log("Verified Payload:", verifiedPayload);

        // https://workos.com/blog/secure-jwt-storage
        setCookie(c, "JWT", token, {
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
          maxAge: TOKEN_EXPIRE_TIME,
        });

        return c.body("login successful", 200);
      }
    }
  }

  return c.body("Login incorrect", 400);
});

router.get("/api/:a", (c) => {
  return hasVaildJWT(c, () => {
    const a = c.req.param("a");
    console.log("Hit: " + a);

    return new Response("Parameters: " + a);
  });
});

router.get("/", async (c) => {
  const file = await Deno.readFile("./dist/index.html");
  return c.body(file);
});

router.get("/assets/*", async (c) => {
  const path = new URL(c.req.url).pathname;

  // Sanitize URL path as only the directory "dist" is the only directory to be publicly served.
  // Deno premisions should also catch any attempts to reach any top level directory outside of "dist"
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
