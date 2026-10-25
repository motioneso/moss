import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as TrustModule from "../../scripts/computer-watchdog/trust.js";
import { runWatchdog, type WatchdogDeps } from "../../scripts/computer-watchdog/main.js";

const trust = vi.hoisted(() => ({
  loadPrelaunchDeployment: vi.fn(),
  loadSupervisorDeployment: vi.fn(),
  processIdentity: vi.fn()
}));
vi.mock("../../scripts/computer-watchdog/trust.js", async (original) => ({
  ...(await original<typeof TrustModule>()),
  ...trust
}));
afterEach(() => vi.clearAllMocks());

const argv = (mode: string, ...rest: string[]) => ["node", "/art.cjs", mode, "/cfg.json", ...rest];
const identity = (pid: number, processGroupId = pid) => ({ pid, processGroupId, startTicks: "9" });

function harness(overrides: Partial<WatchdogDeps> = {}) {
  let clock = 0;
  let parent = 500;
  const log: string[] = [];
  const timers: (() => void)[] = [];
  const deps: WatchdogDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    exit: (code) => void log.push(`exit:${code}`),
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => void log.push("cleared"),
    selfPid: () => 600,
    parentPid: () => parent,
    writeAck: async () => void log.push("ack"),
    ...overrides
  };
  return {
    deps,
    log,
    timers,
    advance: (ms: number) => (clock += ms),
    setParent: (pid: number) => (parent = pid)
  };
}
function holdable() {
  trust.loadPrelaunchDeployment.mockResolvedValue({});
  trust.processIdentity.mockImplementation(async (pid: number) =>
    pid === 600 ? identity(600) : identity(pid)
  );
}

describe("hold mode", () => {
  it("loads once, acknowledges with one byte, then exits 0 when the parent changes", async () => {
    holdable();
    const h = harness();
    let polls = 0;
    const deps = {
      ...h.deps,
      sleep: async (ms: number) => {
        h.advance(ms);
        if (++polls === 3) h.setParent(1);
      }
    };
    expect(await runWatchdog(argv("hold"), deps)).toBe(0);
    expect(trust.loadPrelaunchDeployment).toHaveBeenCalledTimes(1);
    expect(trust.loadPrelaunchDeployment).toHaveBeenCalledWith("/cfg.json", "/art.cjs", "hold");
    expect(trust.loadSupervisorDeployment).not.toHaveBeenCalled();
    expect(h.log.filter((entry) => entry === "ack")).toHaveLength(1);
    expect(polls).toBe(3);
  });
  it("exits 0 at 1800 seconds of age, polling once a second", async () => {
    holdable();
    const h = harness();
    const sleeps: number[] = [];
    const deps = {
      ...h.deps,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        h.advance(ms);
      }
    };
    expect(await runWatchdog(argv("hold"), deps)).toBe(0);
    expect(sleeps.every((ms) => ms === 1000)).toBe(true);
    expect(sleeps).toHaveLength(1800);
  });
  it("writes no byte and exits 2 when the load takes 5 seconds", async () => {
    holdable();
    const h = harness();
    trust.loadPrelaunchDeployment.mockImplementation(async () => {
      h.advance(5000);
      return {};
    });
    expect(await runWatchdog(argv("hold"), h.deps)).toBe(2);
    expect(h.log).not.toContain("ack");
  });
  it("accepts a load that finishes just inside the 5 second bound", async () => {
    holdable();
    const h = harness();
    trust.loadPrelaunchDeployment.mockImplementation(async () => {
      h.advance(4999);
      return {};
    });
    h.setParent(500);
    const deps = { ...h.deps, parentPid: () => (h.log.includes("ack") ? 1 : 500) };
    expect(await runWatchdog(argv("hold"), deps)).toBe(0);
    expect(h.log).toContain("ack");
  });
  it("writes the byte only after the startup deadline is cleared", async () => {
    holdable();
    const h = harness();
    const deps = { ...h.deps, parentPid: () => (h.log.includes("ack") ? 1 : 500) };
    await runWatchdog(argv("hold"), deps);
    expect(h.log.indexOf("cleared")).toBeLessThan(h.log.indexOf("ack"));
  });
  it("arms a 5 second deadline that exits 2", async () => {
    holdable();
    const h = harness();
    const setTimer = vi.fn((callback: () => void, ms: number) => h.timers.push(callback) && ms);
    trust.loadPrelaunchDeployment.mockRejectedValue(new Error("x"));
    await runWatchdog(argv("hold"), { ...h.deps, setTimer });
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 5000);
    h.timers[0]!();
    expect(h.log).toContain("exit:2");
  });
  it.each([
    ["the same process group", identity(600, 500), identity(500, 500)],
    ["the same process", identity(500, 600), identity(500, 700)]
  ])("refuses when it shares %s with its parent", async (_name, self, parent) => {
    trust.loadPrelaunchDeployment.mockResolvedValue({});
    trust.processIdentity.mockImplementation(async (pid: number) => (pid === 600 ? self : parent));
    const h = harness();
    expect(await runWatchdog(argv("hold"), h.deps)).toBe(2);
    expect(h.log).not.toContain("ack");
  });
  it("exits 2 on any load refusal without a byte", async () => {
    trust.loadPrelaunchDeployment.mockRejectedValue(new Error("refused"));
    const h = harness();
    expect(await runWatchdog(argv("hold"), h.deps)).toBe(2);
    expect(h.log).not.toContain("ack");
  });
});

describe("mode dispatch", () => {
  it("prelaunch loads a prelaunch deployment in prelaunch mode and then refuses", async () => {
    holdable();
    trust.loadPrelaunchDeployment.mockResolvedValue({});
    expect(await runWatchdog(argv("prelaunch"), harness().deps)).toBe(2);
    expect(trust.loadPrelaunchDeployment).toHaveBeenCalledWith(
      "/cfg.json",
      "/art.cjs",
      "prelaunch"
    );
    expect(trust.loadSupervisorDeployment).not.toHaveBeenCalled();
  });
  it.each(["observe", "fence", "manage", "collect"])(
    "%s loads only a supervisor deployment",
    async (mode) => {
      trust.loadSupervisorDeployment.mockRejectedValue(new Error("refused"));
      expect(await runWatchdog(argv(mode), harness().deps)).toBe(2);
      expect(trust.loadSupervisorDeployment).toHaveBeenCalledWith(
        "/cfg.json",
        "/art.cjs",
        mode === "collect"
      );
      expect(trust.loadPrelaunchDeployment).not.toHaveBeenCalled();
    }
  );
  it("refuses unknown modes, missing configuration and extra arguments before any load", async () => {
    for (const args of [argv("nope"), ["node", "/art.cjs", "hold"], argv("hold", "extra")])
      expect(await runWatchdog(args, harness().deps)).toBe(2);
    expect(trust.loadPrelaunchDeployment).not.toHaveBeenCalled();
    expect(trust.loadSupervisorDeployment).not.toHaveBeenCalled();
  });
});

describe("entry script", () => {
  it("exits with the real code 2 when the watchdog is refused", () => {
    const result = spawnSync(
      "node_modules/.bin/tsx",
      ["scripts/computer-watchdog.ts", "hold", "/nonexistent/config.json"],
      { encoding: "utf8", timeout: 30000 }
    );
    expect(result.status).toBe(2);
  });
});
