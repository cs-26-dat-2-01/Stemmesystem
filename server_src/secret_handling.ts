// Note that this package is experimental!
// https://docs.deno.com/runtime/reference/env_variables/
import { load } from "@std/dotenv";
import { logger } from "./main_lib.ts";

/**
 * @returns Validated record of enviorment variables.
 */
export async function initializeEnvVars() {
  const rawEnv = await load({
    // Optional: choose a specific path (defaults to ".env")
    envPath: ".env",
    // Optional: also export to the process environment (so Deno.env can read it)
    // export: true,
  });

  // Check that the required environment variable exist in imported environment variables.
  const requiredEnvVars: string[] = [
    "JWT_SERVER_SECRET",
    "ADMIN_USER_PASSWORD",
    "DATABASE_URL",
  ];
  requiredEnvVars.forEach((env) => {
    if (!(env in rawEnv)) {
      const logMsg = `Envirorment variable: ${env} not found.`;
      logger.fatal(logMsg);
      throw new Error(logMsg);
    }

    if (!rawEnv[env]) {
      const logMsg = `Envirorment variable: ${env} not populated.`;
      logger.fatal(logMsg);
      throw new Error(logMsg);
    }
  });

  return rawEnv;
}

export const env = await initializeEnvVars();
