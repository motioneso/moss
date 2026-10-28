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
  log: WindowLog = windowLog(EXPECTED_WINDOWS),
  teardownFails = false
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
        teardown: async () => {
          if (teardownFails) throw new Error("synthetic leak");
          events.push("stack.remove");
        }
      };
    }) as never,
    serveWindows: (dir) => {
      events.push("windows.serve");
      seen.windowsDir = dir;
      return { stop: async () => (events.push("windows.stop"), log) };
    },
    verifyWindows,
    verifyInstalled: async (stack) => {
      events.push("installed");
      seen.installedFor = stack.projectName;
    },
    runBrowser: async (childEnv, deadline) => {
      events.push("browser");
      Object.assign(seen, { childEnv, deadline });
      return 0;
    },
    listOwned: async () => ({ containers: ["owned-1"], volumes: [], networks: [] }),
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
    assert.equal(ok.seen.windowsDir, "/evidence");
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

    // Cleanup errors turn a passing run red.
    const leak = scenario({}, windowLog(EXPECTED_WINDOWS), true);
    const leaked = await driveWorker(leak.input);
    assert.equal(leaked.result, 0);
    assert.ok(leaked.cleanup > 0);
    assert.equal(leaked.exitCode, 1);
    assert.equal(out.exitCode, 0);
    n++;

    // The installed-source check runs for this project, before the browser, and a failure
    // stops the run before any browser starts.
    assert.equal(ok.seen.installedFor, ok.plan.runId.projectName);
    assert.ok(ok.events.indexOf("installed") < ok.events.indexOf("browser"));
    const mismatch = scenario({
      verifyInstalled: async () => {
        throw new Error("installed bytes mismatch");
      }
    });
    const mismatched = await driveWorker(mismatch.input);
    assert.equal(mismatched.result, 1);
    assert.equal(mismatched.exitCode, 1);
    assert.ok(!mismatch.events.includes("browser"));
    n++;

    // A window left open (or failed) keeps the stack and reads what the project still owns.
    for (const bad of [
      windowLog(EXPECTED_WINDOWS, { open: true }),
      windowLog(EXPECTED_WINDOWS, { failure: "x" })
    ]) {
      const kept = scenario({}, bad);
      const keptOut = await driveWorker(kept.input);
      assert.ok(!kept.events.includes("stack.remove"));
      assert.equal(keptOut.teardown.retained, true);
      assert.deepEqual(keptOut.teardown.left?.containers, ["owned-1"]);
      n++;
    }
    assert.ok(ok.events.includes("stack.remove"));
    assert.equal(out.teardown.retained, false);
    n++;

    // An interrupt before or after the browser run fails the run; the browser never starts
    // when the interrupt came first.
    const before = scenario({ isStopped: () => true });
    assert.equal((await driveWorker(before.input)).result, 1);
    assert.ok(!before.events.includes("browser"));
    let polls = 0;
    const after = scenario({ isStopped: () => ++polls > 1 });
    assert.equal((await driveWorker(after.input)).result, 1);
    assert.ok(after.events.includes("browser"));
    n++;

    // Every teardown step consults the cleanup deadline.
    let steps = 0;
    const timed = scenario({ beforeStep: () => void steps++ });
    await driveWorker(timed.input);
    assert.ok(steps >= 3);
    const expired = scenario({
      beforeStep: () => {
        throw new Error("deadline passed");
      }
    });
    const expiredOut = await driveWorker(expired.input);
    assert.ok(expiredOut.cleanup > 0);
    assert.equal(expiredOut.exitCode, 1);
    assert.ok(!expired.events.includes("stack.remove"));
    n++;
  })();
  return n;
}

/**
 * Source-text controls for the runner's own call into the join. Each line below is a piece that
 * can be removed or swapped without any other test noticing, so the call must contain it verbatim.
 */
export function runnerCallControls(source: string): number {
  const start = source.indexOf("driveWorker({");
  const call = source.slice(start, source.indexOf("terminalRecord(", start));
  assert.ok(call.length > 0, "runner calls the join");
  const required = [
    "evidence,\n      claimedPort:",
    "claimedPort: claimedPort(process.env.JARVIS_UAT_CLAIMED_WEB_PORT),",
    "runEnd,",
    "plan,",
    "env: process.env,",
    "now: Date.now,",
    "provision: provisionForUat,",
    "serveWindows,",
    "verifyWindows,",
    "verifyInstalled: (stack) => verifyInstalled(evidence, stack.projectName),",
    "return boundedChild(browserChild, deadline);",
    "listOwned: listOwnedResources,",
    "beforeStep: () => void remaining(),"
  ];
  for (const line of required) assert.ok(call.includes(line), `runner call keeps: ${line}`);
  assert.ok(source.includes("return outcome.exitCode;"), "exit code comes from the join");
  return required.length + 1;
}
