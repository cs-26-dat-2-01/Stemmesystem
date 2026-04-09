import { JWTPayload, jwtVerify, SignJWT } from "@panva/jose";
import { Context } from "@hono/hono";
import { BlankEnv, BlankInput } from "@hono/hono/types";

// --- Import the LogTape config --------------------
import "./logtape_config.ts";
import { getLogger } from "@logtape/logtape";
const logger = getLogger(["server-backend"]);
// --------------------------------------------------

const getCookie = (name: string, cookies: string): string | undefined => {
  const value = `; ${cookies}`;
  const parts = value.split(`; ${name}=`);

  if (parts.length === 2) {
    return parts.pop()?.split(";").shift();
  }

  return undefined;
};

// https://docs.deno.com/examples/creating_and_verifying_jwt/
const serverSecret = new TextEncoder().encode("secret-that-no-one-knows"); // To-do: Store secret better than in code here.
export const TOKEN_EXPIRE_TIME = 43200; // Defined in seconds.

/**
 * Create a JWT containing a payload. The expiration of the JWT is specified by a constant magic number.
 *
 * @param payload The claims that will be stored in the JWT.
 * @returns JWT
 */
export async function createJWT(payload: JWTPayload): Promise<string> {
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRE_TIME + "sec")
    .sign(serverSecret);

  return jwt;
}

/**
 * Verifies a given JWT based on the server secret.
 *
 * @param token A JWT
 * @returns JWT Payload on vaild token otherwise return null.
 */
export async function verifyJWT(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, serverSecret);
    logger.debug("JWT is valid: {payload}", { payload });
    return payload;
  } catch (error) {
    logger.error(`Invalid JWT: ${error}`);
    return null;
  }
}

/**
 * Checks if an incoming request has a valid JWT in its "Authorization" header.
 * If no valid JWT is found it redirects to login page.
 *
 * @param c   - The context given by Hono for the request
 * @param fn  - The logic encasulated in a function that run on a vaild JWT. Must return a hono context.
 */
export async function hasVaildJWT(
  c: Context<BlankEnv, "/", BlankInput>,
  fn: () => void,
) {
  // Retrieve the JWT token.
  const cookies = c.req.header("Cookie");
  const jwtCookie = getCookie("JWT", cookies != undefined ? cookies : ""); // Note: We don't need to directly check if the cookie is valid as the JWT itself contains expiry info.

  if (typeof jwtCookie === "string") {
    const jwt = jwtCookie.slice(jwtCookie.indexOf("=") + 1); // Remove name part of cookie.
    const verifiedPayload = await verifyJWT(jwt);
    if (verifiedPayload) {
      return fn();
    }
  } else {
    logger.debug("No auth token found");
  }

  return c.body("Lack of vaild authentication credentials.", {
    status: 401,
  });
}
