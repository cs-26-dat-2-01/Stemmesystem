import { Context } from "@hono/hono";
import { BlankEnv, BlankInput } from "@hono/hono/types";
import { ContentfulStatusCode } from "@hono/hono/utils/http-status";
import { logger, SERVER_VERSION } from "./main_lib.ts";
// The API uses https://semver.org/

/**
 * Compatibility levels for the API based on [Semantic Versioning](https://semver.org/).
 *
 * @full Server can provide full support for the client.
 * @backwards Server can provide backwards compatibility for the client.
 * @none Server cannot provide any guarentees for compatibility.
 */
const enum compatibility {
  full = "full",
  backwards = "backwards",
  none = "none",
}

interface clientInfo {
  compatibility: compatibility;
  version: string;
}

/**
 * Check the client version against API and return compatibility level.
 *
 * @param version - object containg the client version.
 */
export function checkClientVersion(
  c: Context<BlankEnv, string, BlankInput>,
  v: { x: number; y: number; z: number },
): clientInfo {
  const response = {
    compatibility: compatibility.none,
    version: `${v.x}.${v.y}.${v.z}`,
  };
  logger.trace`Client version: ${v}, Server version: ${SERVER_VERSION}.`;

  // Check if client fully match API version.
  if (
    v.x === SERVER_VERSION.x &&
    v.y === SERVER_VERSION.y &&
    v.z === SERVER_VERSION.z
  ) {
    logger.debug`Client version: ${v} fully compatible.`;
    response.compatibility = compatibility.full;
    return response;
  }

  // Check if client match API major version. If so API can be backwards compatible.
  if (v.x === SERVER_VERSION.x) {
    logger
      .debug`"Client version: ${v} only matched major version.`;
    response.compatibility = compatibility.backwards;
    return response;
  }

  // Client was not compatible.
  logger.debug`Client version: ${v} is not compatible with API.`;
  response.compatibility = compatibility.none;
  return response;
}

/**
 * Validates client version against API to ensure compatibility.
 *
 * @param c - The context given by Hono for the request.
 * @param v - object containg the client version.
 * @returns A JSON response contaning the version of the client and compatibility level.
 */
export function validateClientVersion(
  c: Context<BlankEnv, string, BlankInput>,
  v: { x: number; y: number; z: number },
): { res: clientInfo; status: ContentfulStatusCode } {
  const response = checkClientVersion(c, v);

  switch (response.compatibility) {
    case compatibility.full:
      return { res: response, status: 200 };
    case compatibility.backwards:
      return { res: response, status: 200 };
    case compatibility.none:
      return { res: response, status: 400 };
  }
}

/**
 * Gets the client version from the HTTP header.
 *
 * @param c - The context given by Hono for the request.
 * @returns A object containing the client version.
 */
export function getClientVersion(
  c: Context<BlankEnv, string, BlankInput>,
): Error | { x: number; y: number; z: number } {
  const versionStr = c.req.header("version");

  if (versionStr !== undefined) {
    const [x, y, z] = versionStr.split(".").map(Number);
    return { x: x, y: y, z: z };
  }

  return new Error("client version is undefined", { cause: undefined });
}
