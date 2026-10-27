import assert from "node:assert/strict";
import { driveWorker, type DriveConsumer, type DriveInput } from "./n3-worker-drive.js";
import {
  EXPECTED_WINDOWS,
  verifyWindows,
  type WindowLog,
  type WindowMode
} from "./n3-window-handshake.js";

const RUN_END = 1_000;

function windowLog(modes: readonly WindowMode[], extra: Partial<WindowLog> = {}): WindowLog {
  return {
    completed: modes.map((mode, i) => ({ seq: i + 1, mode, window: i + 1, delta: {} })),
    failure: null,
    open: false,
    ...extra
  };
}

/** A fully fake worker run. Every call lands in `events`, in order. */
function scenario(
  overrides: Partial<DriveInput> = {},
  log: WindowLog = windowLog(EXPECTED_WINDOWS)
) {
  const events: string[] = [];
  const seen: Record<string, unknown> = {};
  const consumer = {
    open: async () => void events.push("observer.open"),
    close: async () => (events.push("observer.close"), { disposed: true }),
    beginWindow: async () => 1,
    finishWindow: async () => ({ delta: {} })
  } satisfies DriveConsumer;
  const plan = {
    option: { marker: "option" } as never,
    runId: { projectName: "uat-1_aa", suffix: "1_aa" },
    collector: { compose: () => ({ consumer }) } as never,
    lifecycleEnv: { LIFECYCLE_DIR: "/d", LIFECYCLE_NONCE: "n" }
  };
  const env: NodeJS.ProcessEnv = { KEEP: "1" };
  const input: DriveInput = {
    evidence: "/evidence",
    claimedPort: 5180,
    runEnd: RUN_END,
    plan,
    env,
    now: () => 0,
    isStopped: () => false,
    provision: (async (_kind: unknown, opts: unknown, deps: unknown) => {
      events.push("provision");
      Object.assign(seen, { opts, deps, provisionEnv: { ...env } });
      return {
        projectName: plan.runId.projectName,
        baseURL: "http://x",
        teardown: async () => void events.push("stack.remove")
      };
    }) as never,
    serveWindows: (dir) => {
      events.push("windows.serve");
      seen.windowsDir = dir;
      return { stop: async () => (events.push("windows.stop"), log) };
    },
    verifyWindows,
    verifyInstalled: async () => void events.push("installed"),
    runBrowser: async (childEnv, deadline) => {
      events.push("browser");
      Object.assign(seen, { childEnv, deadline });
      return 0;
    },
    listOwned: async () => ({ containers: [], volumes: [], networks: [] }),
    beforeStep: () => undefined,
    onError: () => undefined,
    ...overrides
  };
  return { input, plan, events, seen };
}

/** Returns the number of controls run; throws when any join is missing. */
export async function driveControls(): Promise<number> {
  let n = 0;
  await (async () => {
    const ok = scenario();
    const out = await driveWorker(ok.input);
    assert.equal(out.result, 0);
    assert.equal(out.cleanup, 0);
    n++;

    // The chosen run id, observer option and collector reach the provisioner.
    const deps = ok.seen.deps as { runId: unknown; n3BuildEvidence: unknown };
    assert.equal(deps.runId, ok.plan.runId);
    assert.equal(deps.n3BuildEvidence, ok.plan.collector);
    assert.equal((ok.seen.opts as { n3Observer: unknown }).n3Observer, ok.plan.option);
    n++;

    // Lifecycle settings reach provisioning, and never the browser child.
    const provisionEnv = ok.seen.provisionEnv as NodeJS.ProcessEnv;
    assert.equal(provisionEnv.LIFECYCLE_DIR, "/d");
    assert.equal(provisionEnv.LIFECYCLE_NONCE, "n");
    const childEnv = ok.seen.childEnv as NodeJS.ProcessEnv;
    assert.equal(childEnv.LIFECYCLE_DIR, undefined);
    assert.equal(childEnv.LIFECYCLE_NONCE, undefined);
    assert.equal(childEnv.KEEP, "1");
    assert.equal(childEnv.JARVIS_UAT_BASE_URL, "http://x");
    n++;

    // The browser runs under the time box.
    assert.equal(ok.seen.deadline, RUN_END);
    n++;

    // Observer opens before the window server, windows stop before the observer closes, and
    // the observer closes before the stack is removed.
    const order = ok.events;
    for (const [a, b] of [
      ["provision", "observer.open"],
      ["observer.open", "windows.serve"],
      ["windows.serve", "browser"],
      ["windows.stop", "observer.close"],
      ["observer.close", "stack.remove"]
    ] as const)
      assert.ok(order.indexOf(a) !== -1 && order.indexOf(a) < order.indexOf(b), `${a} before ${b}`);
    assert.equal(order.filter((e) => e === "observer.close").length, 1);
    n++;

    // A wrong, failed or unfinished window list fails the run and keeps the stack.
    for (const bad of [
      windowLog(["terminal", "terminal", "positive"]),
      windowLog(EXPECTED_WINDOWS.slice(0, 2)),
      windowLog(EXPECTED_WINDOWS, { open: true }),
      windowLog(EXPECTED_WINDOWS, { failure: "x" })
    ]) {
      const run = scenario({}, bad);
      const res = await driveWorker(run.input);
      assert.equal(res.result, 1);
      assert.equal(res.phase, "observer-windows");
      n++;
    }

    // A browser that outlives the time box is reported under the time-box phase.
    const late = scenario({ runBrowser: async () => 1, now: () => RUN_END });
    const lateOut = await driveWorker(late.input);
    assert.equal(lateOut.result, 1);
    assert.equal(lateOut.phase, "time-box");
    n++;
  })();
  return n;
}
