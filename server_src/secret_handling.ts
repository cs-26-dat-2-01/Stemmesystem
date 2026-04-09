// Note that this package is experimental!
// https://docs.deno.com/runtime/reference/env_variables/
import { load } from "jsr:@std/dotenv@0.225.6";

export const env = await load({
  // Optional: choose a specific path (defaults to ".env")
  envPath: ".env",
  // Optional: also export to the process environment (so Deno.env can read it)
  // export: true,
});
