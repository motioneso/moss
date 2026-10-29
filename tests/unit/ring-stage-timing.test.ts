import { describe, expect, it } from "vitest";

import {
  RingStageTimer,
  formatRingStageTiming
} from "../../packages/chat/src/live/ring-stage-timing.js";

describe("ring stage timing (#3842)", () => {
  it("records first-seen stage offsets and approval asked", () => {
    let now = 1000;
    const timer = new RingStageTimer("turn-1", () => now);
    now = 1200;
    timer.mark("session_ready");
    now = 3000;
    timer.mark("first_model_token");
    timer.noteToolChosen();
    now = 3100;
    timer.noteApprovalAsked();
    now = 4000;
    timer.noteToolFinished();
    now = 4500;
    timer.mark("reply");
    const snap = timer.snapshot();
    expect(snap.stagesMs).toEqual({
      chat_turn_admitted: 0,
      session_ready: 200,
      first_model_token: 2000,
      tool_chosen: 2000,
      approval: 2100,
      tool_finished: 3000,
      reply: 3500
    });
    expect(snap.approval).toBe("asked");
    expect(snap.toolCount).toBe(1);
    expect(snap.totalMs).toBe(3500);
  });

  it("marks approval skipped when a tool runs with no card", () => {
    let now = 0;
    const timer = new RingStageTimer("turn-2", () => now);
    now = 500;
    timer.noteToolChosen();
    now = 900;
    timer.noteToolFinished();
    const snap = timer.snapshot();
    expect(snap.approval).toBe("skipped");
    expect(snap.stagesMs.approval).toBe(500);
  });

  it("emits metadata only, with no text or tool name fields", () => {
    const timer = new RingStageTimer("turn-3", () => 0);
    timer.noteToolChosen();
    const line = formatRingStageTiming(timer.snapshot());
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["approval", "event", "source", "stagesMs", "toolCount", "totalMs", "turnId"].sort()
    );
    expect(line).not.toMatch(/transcript|message|replyText|toolName|argument/i);
  });

  it("keeps the first mark when a stage is seen twice", () => {
    let now = 0;
    const timer = new RingStageTimer("turn-4", () => now);
    now = 100;
    timer.mark("session_ready");
    now = 900;
    timer.mark("session_ready");
    expect(timer.snapshot().stagesMs.session_ready).toBe(100);
  });
});
