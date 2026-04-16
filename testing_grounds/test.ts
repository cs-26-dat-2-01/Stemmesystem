/* "Testing is the future, and the future starts with you." */
/* Arrange, Act, Assert! */

import { DatabaseSync } from "node:sqlite";
import {
  Poll,
  PollConfig,
  User,
  userId,
  WebappDatabase,
} from "../server_src/database.ts";
import { logger } from "../server_src/main_lib.ts";

Deno.test({
  name: "Test reactivity of Poll object",
  fn() {
    const user = 1;
    const pollConfig: PollConfig = {
      title: "test",
      description: "testing test",
      voteOwner: 1,
      pollVisibility: "private",
      pollPrivacy: "secret",
      showTopN: 0,
      ballotLimit: 1,
      eligibleVoters: {
        [user]: 1,
        2: 2,
      },
      ballotOptions: {
        1: { id: 1, name: "test1", votesRecived: 1 },
        2: { id: 2, name: "test2", votesRecived: 2 },
      },
    };

    const testStr = JSON.stringify(pollConfig.eligibleVoters);
    console.log(testStr);

    const voters = JSON.parse(testStr) as Record<userId, number>;
    console.log(Object.keys(voters).includes("1"));

    const poll = new Poll(pollConfig);

    // poll.title = "new title for test";
  },
});

Deno.test({
  name: "Test database table generation",
  async fn() {
    const filePath: string = "./testing_grounds/test.db";
    const DB: WebappDatabase = await WebappDatabase.initDatabase(
      filePath,
    );
  },
});
