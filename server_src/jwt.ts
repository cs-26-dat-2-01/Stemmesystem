import { JWTPayload, jwtVerify, SignJWT } from "@panva/jose";
import { Context } from "@hono/hono";
import { BlankEnv, BlankInput } from "@hono/hono/types";
import { getCookie } from "../client_src/WebLib.ts";
import { env } from "./secret_handling.ts";
import { logger } from "./main_lib.ts";
import { WebappDatabase } from "./database.ts";

// https://docs.deno.com/examples/creating_and_verifying_jwt/
const serverSecret = new TextEncoder().encode(env.JWT_SERVER_SECRET);
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
    .setExpirationTime(TOKEN_EXPIRE_TIME + "s")
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
 * Checks if an incoming request contains a correct JWT stored in an HTTP-Cookie.
 * If a valid authentication credentials are provided the function runs `fn`.
 * If given invalid authentication credentials the function returns a 401 response.
 *
 * @param db  - The application database handle, used to look up the requesting user.
 * @param c   - The context given by Hono for the request.
 * @param fn  - The logic encasulated in a function that run on a valid JWT. Must return a hono context.
 */
export async function hasValidJWT(
  db: WebappDatabase,
  c: Context<BlankEnv, string, BlankInput>,
  fn: (payload: JWTPayload) => Response | Promise<Response>,
) {
  const cookies = c.req.header("Cookie");
  const jwt = getCookie("JWT", cookies != undefined ? cookies : ""); // Retrieve the JWT token.

  // Note: We don't need to directly check if the cookie is valid as the JWT itself contains expiry info.
  if (typeof jwt === "string") {
    const verifiedPayload = await verifyJWT(jwt);

    if (verifiedPayload) {
      if (
        // Check if user exists in DB, otherwise JWT is not valid.
        (await db.getUserFromDB(verifiedPayload.username as string))
          .httpStatusCode === 200
      ) {
        return fn(verifiedPayload);
      }
    }
  } else {
    logger.debug("No auth token found");
  }

  return c.body("Lack of valid authentication credentials.", {
    status: 401,
  });
}
