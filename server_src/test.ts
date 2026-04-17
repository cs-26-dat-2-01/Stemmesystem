/* "Testing is the future, and the future starts with you." */
/* Arrange, Act, Assert! */

import { Poll } from "./database.ts";

Deno.test({
  name: "Test reactivity of Poll object",
  fn() {
    const poll = new Poll({
      title: "test",
      description: "testing test",
      voteOwner: 1,
      pollVisibility: "private",
      pollPrivacy: "secret",
      showTopN: 0,
      ballotLimit: 1,
      eligibleVoters: {},
      ballotOptions: {},
    });

    poll.title = "new title for test";
  },
});
