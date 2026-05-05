// For some reason, It is not possible to use the `env` variable from `secret_handling.ts` in this file,
// so we have to load the environment variables here as well.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
