import { describe, expect, it, vi } from "vitest";

import {
  runCliVersionCheck,
  type CliVersionCheckPorts,
  type VersionCheckState
} from "../../packages/ai/src/cli-version-check.js";

const NOW = new Date("2026-09-30T12:00:00Z");
const base: VersionCheckState = {
  candidate: [{ pkg: "@a/cli", version: "2.0.0" }],
  lastCheck: null,
  liveVersion: "1.0.0"
};

function setup(state: Partial<VersionCheckState> = {}, over: Partial<CliVersionCheckPorts> = {}) {
  const calls: string[] = [];
  const ports: CliVersionCheckPorts = {
    getState: async () => ({ ...base, ...state }),
    runLiveCheck: vi.fn(async () => {
      calls.push("check");
      return { passed: true, reason: "ok" as const };
    }),
    promote: vi.fn(async () => {
      calls.push("promote");
      return { state: "promoted" as const };
    }),
    recordCheck: vi.fn(async () => undefined),
    raiseFailure: vi.fn(async () => undefined),
    now: () => NOW,
    ...over
  };
  return { ports, calls };
}

const CODEX = "openai-compatible" as const;

describe("runCliVersionCheck (Codex: check before promote)", () => {
  it("promotes only after the live check passes, and records the pass", async () => {
    const { ports, calls } = setup();
    expect(await runCliVersionCheck(CODEX, ports)).toEqual({
      status: "promoted",
      firstInstall: false
    });
    expect(calls).toEqual(["check", "promote"]);
    expect(ports.recordCheck).toHaveBeenCalledWith(
      CODEX,
      expect.objectContaining({ result: "passed", versions: ["2.0.0"] })
    );
  });

  it("holds back a failing candidate, never promotes, and alerts once", async () => {
    const { ports } = setup(
      {},
      { runLiveCheck: async () => ({ passed: false, reason: "tool_call_missing" }) }
    );
    expect(await runCliVersionCheck(CODEX, ports)).toEqual({
      status: "held-back",
      reason: "tool_call_missing"
    });
    expect(ports.promote).not.toHaveBeenCalled();
    expect(ports.raiseFailure).toHaveBeenCalledTimes(1);
    expect(ports.recordCheck).toHaveBeenCalledWith(
      CODEX,
      expect.objectContaining({ result: "failed", reason: "tool_call_missing" })
    );
  });

  it("goes live first on a fresh install, and still alerts when the check then fails", async () => {
    const { ports, calls } = setup(
      { liveVersion: null },
      { runLiveCheck: async () => ({ passed: false, reason: "timeout" }) }
    );
    const out = await runCliVersionCheck(CODEX, ports);
    expect(calls).toEqual(["promote"]);
    expect(out).toEqual({ status: "held-back", reason: "timeout" });
    expect(ports.raiseFailure).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed candidate within a day, but does when forced", async () => {
    const lastCheck = {
      at: "2026-09-30T06:00:00Z",
      result: "failed" as const,
      reason: "timeout",
      versions: ["2.0.0"]
    };
    const a = setup({ lastCheck });
    expect(await runCliVersionCheck(CODEX, a.ports)).toEqual({
      status: "skipped-recent-failure"
    });
    expect(a.ports.runLiveCheck).not.toHaveBeenCalled();
    const b = setup({ lastCheck });
    expect((await runCliVersionCheck(CODEX, b.ports, { force: true })).status).toBe("promoted");
  });

  it("retries after a day, and retries at once for a different candidate version", async () => {
    const old = {
      at: "2026-09-29T06:00:00Z",
      result: "failed" as const,
      reason: "timeout",
      versions: ["2.0.0"]
    };
    expect((await runCliVersionCheck(CODEX, setup({ lastCheck: old }).ports)).status).toBe(
      "promoted"
    );
    const fresh = { ...old, at: "2026-09-30T11:00:00Z", versions: ["1.9.0"] };
    expect((await runCliVersionCheck(CODEX, setup({ lastCheck: fresh }).ports)).status).toBe(
      "promoted"
    );
  });

  it("holds back when the promote itself fails", async () => {
    const { ports } = setup({}, { promote: async () => ({ state: "error", message: "hash" }) });
    expect(await runCliVersionCheck(CODEX, ports)).toEqual({
      status: "held-back",
      reason: "promote_failed"
    });
  });

  it("does nothing without a candidate or without a runner", async () => {
    expect((await runCliVersionCheck(CODEX, setup({ candidate: [] }).ports)).status).toBe(
      "no-candidate"
    );
    const { ports } = setup({}, { getState: async () => null });
    expect((await runCliVersionCheck(CODEX, ports)).status).toBe("runner-unavailable");
  });
});

describe("runCliVersionCheck (Claude: always promote, check afterwards)", () => {
  const waitFor = async (out: Awaited<ReturnType<typeof runCliVersionCheck>>) => {
    if (out.status === "promoted") await out.backgroundCheck;
  };

  it("promotes before the check runs, on upgrade and on first install alike", async () => {
    for (const liveVersion of ["1.0.0", null]) {
      const { ports, calls } = setup({ liveVersion });
      const out = await runCliVersionCheck("anthropic", ports);
      expect(out.status).toBe("promoted");
      await waitFor(out);
      expect(calls).toEqual(["promote", "check"]);
    }
  });

  it("keeps the update live and only alerts when the check fails", async () => {
    const { ports } = setup(
      {},
      { runLiveCheck: async () => ({ passed: false, reason: "tool_call_missing" }) }
    );
    const raise = vi.fn(async () => undefined);
    const out = await runCliVersionCheck("anthropic", { ...ports, raisePostPromoteFailure: raise });
    expect(out.status).toBe("promoted");
    await waitFor(out);
    expect(ports.promote).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledWith("anthropic", ["2.0.0"], "tool_call_missing");
    expect(ports.raiseFailure).not.toHaveBeenCalled();
  });

  it("is not delayed or undone when the check throws", async () => {
    const { ports } = setup(
      {},
      {
        runLiveCheck: async () => {
          throw new Error("boom");
        }
      }
    );
    const raise = vi.fn(async () => undefined);
    const out = await runCliVersionCheck("anthropic", { ...ports, raisePostPromoteFailure: raise });
    expect(out.status).toBe("promoted");
    await waitFor(out);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it("returns at once when the check hangs, then alerts when the time limit passes", async () => {
    const { ports } = setup({}, { runLiveCheck: () => new Promise(() => undefined) });
    const raise = vi.fn(async () => undefined);
    const out = await runCliVersionCheck("anthropic", {
      ...ports,
      raisePostPromoteFailure: raise,
      postPromoteTimeoutMs: 20
    });
    expect(out.status).toBe("promoted");
    expect(raise).not.toHaveBeenCalled();
    await waitFor(out);
    expect(raise).toHaveBeenCalledWith("anthropic", ["2.0.0"], "timeout");
  });

  it("still holds back when the install itself fails", async () => {
    const { ports } = setup({}, { promote: async () => ({ state: "error", message: "hash" }) });
    expect(await runCliVersionCheck("anthropic", ports)).toEqual({
      status: "held-back",
      reason: "promote_failed"
    });
    expect(ports.runLiveCheck).not.toHaveBeenCalled();
  });
});
