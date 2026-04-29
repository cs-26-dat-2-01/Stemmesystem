import { WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { startServer } from "./server.ts";

logger.info`Starting server! 🚀`;

const databasePath: string = "./database/users.db";
const DB: WebappDatabase = await WebappDatabase.initDatabase(
  databasePath,
);

startServer(DB);
