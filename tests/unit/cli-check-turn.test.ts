import { describe, expect, it, vi } from "vitest";

import {
  installModelActivityRecorder,
  type ModelActivityEntry
} from "../../packages/ai/src/model-activity.js";
import { runCheckTurn } from "../../packages/chat/src/live/cli-check-turn.js";
import { CLI_VERSION_TOO_OLD_MESSAGE } from "../../packages/chat/src/live/cli-version-errors.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";

function fakeEngine(script: {
  batches?: { records: TranscriptRecord[]; complete: boolean }[];
  launchError?: Error;
}) {
  const batches = [...(script.batches ?? [])];
  const engine = {
    provider: "anthropic",
    launch: vi.fn(async () => {
      if (script.launchError) throw script.launchError;
      return { offset: 0 };
    }),
    submit: vi.fn(async () => undefined),
    readNew: vi.fn(async () => batches.shift() ?? { records: [], offset: 0, complete: false }),
    interrupt: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    isAlive: vi.fn(async () => true)
  };
  return engine as unknown as CliChatEngine & typeof engine;
}

const base = {
  launch: { neutralDir: "", personaPath: "" },
  prompt: "p",
  toolName: "app.getMapSlice",
  timeoutMs: 1000,
  sleep: async () => undefined
};

describe("runCheckTurn", () => {
  it("passes when the turn reports the required tool call", async () => {
    const engine = fakeEngine({
      batches: [
        {
          records: [{ kind: "tool", toolName: "mcp__jarvis__app_getMapSlice", text: "x" }],
          complete: false
        } as never,
        { records: [], complete: true } as never
      ]
    });
    expect(await runCheckTurn({ ...base, engine })).toMatchObject({ ok: true });
    expect(engine.kill).toHaveBeenCalledOnce();
  });

  it("fails when the turn ends without that call, even if the model answered", async () => {
    const engine = fakeEngine({
      batches: [
        { records: [{ kind: "reply", text: "done" }], complete: false } as never,
        { records: [], complete: true } as never
      ]
    });
    expect(await runCheckTurn({ ...base, engine })).toEqual({
      ok: false,
      reason: "tool_call_missing"
    });
  });

  it("returns the reply text, and needs no tool call when none is named", async () => {
    const engine = fakeEngine({
      batches: [{ records: [{ kind: "reply", text: '{"sum":4}' }], complete: true } as never]
    });
    const { toolName: _unused, ...noTool } = base;
    expect(await runCheckTurn({ ...noTool, engine })).toEqual({ ok: true, replyText: '{"sum":4}' });
  });

  it("ignores a different tool", async () => {
    const engine = fakeEngine({
      batches: [
        { records: [{ kind: "tool", toolName: "notes.list", text: "x" }], complete: true } as never
      ]
    });
    expect(await runCheckTurn({ ...base, engine })).toMatchObject({ reason: "tool_call_missing" });
  });

  it("times out and interrupts a turn that never completes", async () => {
    let t = 0;
    const engine = fakeEngine({});
    const result = await runCheckTurn({ ...base, engine, now: () => (t += 600) });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(engine.interrupt).toHaveBeenCalledOnce();
    expect(engine.kill).toHaveBeenCalledOnce();
  });

  it("calls a launch failure unavailable, and still closes the session", async () => {
    const engine = fakeEngine({ launchError: new Error("no login") });
    expect(await runCheckTurn({ ...base, engine })).toEqual({
      ok: false,
      reason: "check_unavailable"
    });
    expect(engine.kill).toHaveBeenCalledOnce();
  });

  it("counts the version-too-old refusal as a candidate failure", async () => {
    const engine = fakeEngine({
      launchError: new CliChatUnavailableError(CLI_VERSION_TOO_OLD_MESSAGE)
    });
    const result = await runCheckTurn({ ...base, engine });
    expect(result).toEqual({ ok: false, reason: "tool_call_missing" });
  });
});

describe("runCheckTurn model activity recording (plan 3.6b, #2890)", () => {
  it("records one check row per turn with the launch model, never the prompt", async () => {
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      const engine = fakeEngine({
        batches: [{ records: [{ kind: "reply", text: "ok" }], complete: true } as never]
      });
      const { toolName: _unused, ...noTool } = base;
      const SENTINEL = "SENTINEL-check-prompt-do-not-record";
      await runCheckTurn({
        ...noTool,
        prompt: SENTINEL,
        launch: { neutralDir: "", personaPath: "", model: "check-model-1" },
        engine
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: "check",
        action: "check",
        outcome: "ok",
        modelName: "check-model-1",
        result: "completed"
      });
      expect(JSON.stringify(entries)).not.toContain(SENTINEL);
    } finally {
      installModelActivityRecorder(null);
    }
  });

  it("records an error row when the check turn fails", async () => {
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      const engine = fakeEngine({ launchError: new Error("no login") });
      await runCheckTurn({ ...base, engine });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: "check", outcome: "error", result: "failed" });
    } finally {
      installModelActivityRecorder(null);
    }
  });
});
