import { WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { startServer } from "./server.ts";

logger.info`Starting server! 🚀`;

await Deno.mkdir("./database", { recursive: true }); // recursvive true so if the folder exists it wont fail.
const DB: WebappDatabase = await WebappDatabase.initDatabase();

const ac = new AbortController();

startServer(DB, ac);
