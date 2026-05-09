import { WebappDatabase } from "./database.ts";
import { logger } from "./main_lib.ts";
import { startServer } from "./server.ts";
import { PollManager } from "./pollManager.ts";

logger.info`Starting server! 🚀`;

await Deno.mkdir("./database", { recursive: true }); // recursvive true so if the folder exists it wont fail.
const DB: WebappDatabase = await WebappDatabase.initDatabase();

const ac = new AbortController();

const pollManager = new PollManager(DB);
const TICK_MS = 30_000; // 30s can be adjusted
const tickHandle = setInterval(() => {
  pollManager.tickPollStatuses().catch((err) => {
    logger.error`tickPollStatuses threw: ${err}`;
  });
}, TICK_MS);

ac.signal.addEventListener("abort", () => clearInterval(tickHandle));

startServer(DB, ac);
