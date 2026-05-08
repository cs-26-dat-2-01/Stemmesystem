// --- Import the LogTape config --------------------
import "./logtape_config.ts";
import { getLogger } from "@logtape/logtape";
export const logger = getLogger(["server-backend"]);
// --------------------------------------------------

export const SERVER_VERSION = { x: 0, y: 0, z: 0 };
export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};
