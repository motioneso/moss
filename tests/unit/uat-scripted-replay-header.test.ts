import { describe, expect, it } from "vitest";

import { renderReplayBlock } from "../../packages/chat/src/live/chat-context-blocks.js";
import { REPLAY_BLOCK_HEADER } from "../uat/fixtures/scripted-provider/claude-main.js";

// #3335: the scripted Claude stand-in recognises a launch replay by its header. If the header
// drifts, the stand-in plays the replayed turn's tool calls, which the gateway refuses.
describe("scripted Claude replay detection", () => {
  it("matches the header the chat launch writes", () => {
    const replay = renderReplayBlock([{ role: "user", content: "uatfix what is on my calendar?" }]);
    expect(replay).toContain(REPLAY_BLOCK_HEADER);
  });
});
