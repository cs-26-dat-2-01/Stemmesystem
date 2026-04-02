import { Context, Hono } from "@hono/hono";
import { JWTPayload, jwtVerify, SignJWT } from "@panva/jose";
import { BlankEnv, BlankInput } from "@hono/hono/types";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};

const secret = new TextEncoder().encode("secret-that-no-one-knows");

async function createJWT(payload: JWTPayload): Promise<string> {
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
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
  const auth_token = c.req.header("Authorization");

  if (typeof auth_token === "string") {
    if (await verifyJWT(auth_token)) {
      fn();
    }
  } else {
    console.log("No auth token found");
  }

  // If no JWT token was found or that the JWT is invaild redirect to login
  // so that the user may retrive a new JWT token.
  return c.redirect("/login", 303);
}

const router = new Hono();

router.get("/login", (c) => {
  return new Response("Login page");
});

router.get("/", (c) => {
  return hasVaildJWT(c, async () => {
    const file = await Deno.readFile("./dist/index.html");
    return c.body(file);
  });
});

router.get("/assets/*", (c) => {
  return hasVaildJWT(c, async () => {
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
});

router.get("/api/:a", (c) => {
  const a = c.req.param("a");
  console.log("Hit: " + a);

  console.log("Authorization: " + c.req.header("Authorization"));
  return new Response("Parameters: " + a);
});

Deno.serve(router.fetch);
