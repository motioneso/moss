/**
 * #3529 supplemental seeded-owner proof: signup, nine blocking UATs, N1,
 * cancellation/unsaved/fault/due-worker and routine activation remain OUTSTANDING.
 * BLOCKED: no complete correlated fallback observer. All live entries fail closed.
 * After seam repair/executable review: --launch <NEW-private-evidence-directory> (read verify-gate).
 * One no-sweep test:uat:3529-real gate/wait; local Docker, pre-import private roots/source/image/DB.
 * Birth/group/session checked before signals/stop; uncertainty retains roots/port/resources (RED).
 * Aggregate 14m includes cleanup. RAW evidence is 0700/0600, without a zero-capture/erasure claim.
 * Supported auth copying reuses operator account in disposable volume; presence is not readiness.
 * --self-test: fake/local scratch only; no Docker/DB/browser/port/auth/network/provider.
 */
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { orderedTeardown } from "./n3-teardown.js";
import { DOCKER_HOST, rejectOverrides } from "./n3-launch-checks.js";
import {
  groupClosed,
  validateProcess,
  type ProcessIdentity,
  processIdentity,
  settled,
  signalOwned,
  startChild
} from "./n3-process-control.js";
import {
  EXPECTED_WINDOWS,
  serveWindows,
  verifyWindows,
  type WindowServer
} from "./n3-window-handshake.js";

const SELF = fileURLToPath(import.meta.url);
const BASE = "966527c413adc752def72f45ce0c54e660ca0615";
const SPEC = "tests/uat/specs/3529-scheduled-read-terminal-real.uat.spec.ts";
const PRODUCT = [
  "packages/chat/src/live/chat-session-ports.ts",
  "packages/chat/src/live/pre-model-turn.ts",
  "packages/chat/src/reminders/features.ts",
  "packages/chat/src/scheduled-reads/generation.ts",
  "packages/chat/src/scheduled-reads/request.ts"
];
const LEASE = [
  "package.json",
  "tests/uat/run-scheduled-read-terminal-uat.ts",
  SPEC,
  ".claude/skills/coordinate/uat-trigger-map.tsv"
];
const RUN_MS = 12 * 60_000;
const CLEANUP_MS = 120_000;
const TOTAL_MS = RUN_MS + CLEANUP_MS; // Includes teardown; +30m due retains >10m margin.
let protocolEnd = Infinity;
function remaining(max = 120_000): number {
  const left = protocolEnd - Date.now();
  check(left > 0, "aggregate protocol deadline exhausted; retain owned resources");
  return Math.max(1, Math.min(max, left));
}
export function requireFallbackObserver(): void {
  throw new Error(
    "N3_FALLBACK_OBSERVER_UNAVAILABLE: launch/submission/classifier attempts unobservable"
  );
}
async function protectedLifecycle(body: () => Promise<void>, cleanup: () => Promise<number>) {
  let failed = false;
  try {
    await body();
  } catch {
    failed = true;
  }
  let errors = 1;
  try {
    errors = await cleanup();
  } catch {
    /* Explicit RED; retain ownership. */
  }
  return { failed, cleanup: errors };
}
const uid = process.getuid?.();
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
export function claimedPort(value: string | undefined): number {
  check(value && /^\d+$/.test(value), "missing/invalid claimed port");
  const port = Number(value);
  check(port >= 5180 && port <= 5299, "claimed port outside shared range");
  return port;
}
function privateDir(path: string): void {
  const stat = lstatSync(path);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === uid &&
      (stat.mode & 0o777) === 0o700 &&
      realpathSync(path) === resolve(path),
    "unsafe private directory"
  );
}
function record(directory: string, name: string, data: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx"
  });
}
async function beforeDeadline<T>(operation: () => Promise<T>, until = Infinity): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budget = Math.min(remaining(Infinity), Math.max(1, until - Date.now()));
    if (!Number.isFinite(budget)) return operation(); // Fake controls have no live protocol.
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("async deadline; retain ownership")), budget);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function terminalRecord(directory: string, name: string, data: unknown): Promise<void> {
  const path = join(directory, name);
  const bytes = JSON.stringify(data, null, 2) + "\n";
  await beforeDeadline(() => writeFile(path, bytes, { mode: 0o600, flag: "wx" }));
}
async function exitCli(result: Promise<number>): Promise<never> {
  // Bounded terminal receipts precede exit; uncertain child/IO handles cannot extend host lifetime.
  process.exit(await result);
}
function capture(command: string, args: readonly string[], env = process.env): string {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout: remaining(),
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024
  });
  // Do not interpolate subprocess output into an error: it may contain secrets.
  check(result.status === 0, `command failed: ${command}`);
  return result.stdout.trim();
}
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function sourceReceipt() {
  check(capture("git", ["status", "--porcelain"]) === "", "clean source required");
  const head = capture("git", ["rev-parse", "HEAD"]);
  check(
    capture("git", ["merge-base", "--is-ancestor", BASE, head]) === "",
    "source ancestry mismatch"
  );
  const changed = capture("git", ["diff", "--name-only", BASE, head]).split("\n").filter(Boolean);
  check(
    changed.length === 4 && changed.every((path) => LEASE.includes(path)),
    "four-path lease mismatch"
  );
  const hashes: Record<string, string> = {};
  for (const path of capture("git", ["ls-files", "apps", "packages"]).split("\n").filter(Boolean)) {
    hashes[path] = digest(readFileSync(path));
  }
  return { head, productBase: BASE, productHashes: hashes };
}
export async function cleanupAll(
  actions: readonly (() => void | Promise<void>)[]
): Promise<number> {
  let errors = 0;
  for (const action of actions) {
    try {
      remaining();
      await action();
    } catch {
      errors++;
    }
  }
  return errors;
}
async function boundedChild(child: ChildProcess, until = Infinity): Promise<number> {
  try {
    return await beforeDeadline(() => settled(child), until);
  } catch {
    try {
      signalOwned(child, "SIGKILL");
    } catch {
      /* Unknown identity: retain. CLI exit does not wait for this referenced child. */
    }
    return 1;
  }
}
function projectsInLog(raw: string, pid: number): string[] {
  return [
    ...new Set(
      [
        ...raw.matchAll(
          new RegExp(`^\\[uat\\] provisioning (uat-${pid}_[a-f0-9]{8}) on port \\d+ subnet `, "gm")
        )
      ].map((match) => match[1]!)
    )
  ];
}

async function gateMain(): Promise<number> {
  requireFallbackObserver();
  check(process.env.JARVIS_GATE_RUN === "1", "verify-gate launcher required");
  const root = process.env.N3_UAT_ROOT!;
  const evidence = process.env.N3_UAT_EVIDENCE!;
  privateDir(root);
  privateDir(evidence);
  rejectOverrides(process.env);
  const input = JSON.parse(readFileSync(join(evidence, "inputs.json"), "utf8")) as { head: string };
  check(sourceReceipt().head === input.head, "source freeze changed before gate");
  claimedPort(process.env.JARVIS_UAT_CLAIMED_WEB_PORT);
  for (const [key, subdir] of [
    ["TMPDIR", "tmp"],
    ["JARVIS_CHAT_HOME", "chat"],
    ["JARVIS_CLI_HOME_BASE", "cli"],
    ["JARVIS_GATE_DIR", "gate"]
  ]) {
    check(process.env[key!] === join(root, subdir!), "pre-import root mismatch");
    privateDir(process.env[key!]!);
  }
  check(process.env.JARVIS_IMAGE_TAG?.match(/^uat-n3-[a-f0-9]{24}$/), "unique image tag required");
  protocolEnd = Number(process.env.N3_UAT_DEADLINE);
  check(Number.isFinite(protocolEnd), "aggregate deadline missing");
  return supervisedWorker(
    evidence,
    () =>
      startChild(
        [process.execPath, "--import", "tsx", SELF, "--worker"],
        process.env,
        join(evidence, "worker-raw.log"),
        true
      ),
    remaining(Math.max(1, protocolEnd - CLEANUP_MS - Date.now()))
  );
}
async function supervisedWorker(
  evidence: string,
  create: () => ChildProcess,
  budget: number,
  write = record
): Promise<number> {
  write(evidence, "worker-intent.json", { spawning: true }); // Durable BEFORE spawn.
  const child = create();
  const supervision = supervise(child, budget); // Own before any fallible receipt.
  let failed = false;
  try {
    write(evidence, "worker.json", { pid: child.pid });
  } catch {
    failed = true;
    supervision.stop();
  }
  const result = await supervision.done;
  const closed = groupClosed(child);
  await terminalRecord(evidence, "worker-exit.json", { ...result, closed });
  return failed || result.interrupted || !closed ? 1 : result.rc;
}
function supervise(child: ChildProcess, budget: number, grace = 30_000) {
  let interrupted = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let finish!: (rc: number) => void;
  const completion = new Promise<number>((resolveResult) => {
    finish = resolveResult;
  });
  void settled(child).then(finish);
  const stop = () => {
    interrupted = true;
    try {
      signalOwned(child, "SIGTERM", true);
    } catch {
      /* Unknown identity: retain. */
    }
    killer ??= setTimeout(
      () => {
        try {
          signalOwned(child, "SIGKILL", true);
        } catch {
          /* Never signal a reused PID. */
        }
        // Allow close/reap to settle, but never wait past the aggregate deadline.
        killer = setTimeout(() => finish(1), Math.max(1, Math.min(100, protocolEnd - Date.now())));
      },
      Math.max(1, Math.min(grace, protocolEnd - Date.now()))
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const deadline = setTimeout(stop, budget);
  const done = completion.then((rc) => {
    clearTimeout(deadline);
    clearTimeout(killer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    try {
      signalOwned(child, "SIGKILL", true);
    } catch {
      interrupted = true;
    }
    return { rc, interrupted };
  });
  return { done, stop };
}
function requireWorkerClosure(evidence: string): number {
  const { pid } = JSON.parse(readFileSync(join(evidence, "worker.json"), "utf8")) as {
    pid: number;
  };
  check(Number.isSafeInteger(pid) && pid > 1, "missing/invalid worker identity; retain resources");
  const receipt = JSON.parse(readFileSync(join(evidence, "worker-exit.json"), "utf8")) as {
    closed?: boolean;
  };
  check(receipt.closed === true, "worker close receipt missing; retain resources");
  return pid;
}
async function worker(): Promise<number> {
  requireFallbackObserver();
  check(
    process.env.JARVIS_GATE_RUN === "1" && process.env.N3_UAT_ROOT,
    "worker requires owned gate"
  );
  protocolEnd = Number(process.env.N3_UAT_DEADLINE);
  check(Number.isFinite(protocolEnd), "aggregate deadline missing");
  remaining();
  const evidence = process.env.N3_UAT_EVIDENCE!;
  for (const prefix of ["MOSS", "JARVIS"])
    for (const role of ["BOOTSTRAP", "MIGRATION", "APP", "AUTH", "WORKER"])
      delete process.env[`${prefix}_${role}_DATABASE_URL`];
  const { provisionForUat } = await import("./provisioner.js");
  const { planWorkerObserver } = await import("./n3-worker-wiring.js");
  const { listOwnedResources } = await import("./provisioner-cleanup.js");
  const runEnd = protocolEnd - CLEANUP_MS; // The run time box; cleanup keeps the rest.
  const plan = planWorkerObserver({
    evidenceDir: evidence,
    repoRoot: process.cwd(),
    claimedPort: claimedPort(process.env.JARVIS_UAT_CLAIMED_WEB_PORT),
    imageTag: process.env.JARVIS_IMAGE_TAG!,
    deadline: runEnd
  });
  Object.assign(process.env, plan.lifecycleEnv);
  let consumer: ReturnType<typeof plan.collector.compose>["consumer"] | undefined;
  let windows: WindowServer | undefined;
  let stopped = false;
  let browserChild: ChildProcess | undefined;
  const stop = () => {
    stopped = true;
    if (browserChild) signalOwned(browserChild, "SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let stack: Awaited<ReturnType<typeof provisionForUat>> | undefined;
  let result = 1;
  let phase = "provision";
  let cleanup: number;
  let teardown: Awaited<ReturnType<typeof orderedTeardown>>;
  try {
    stack = await provisionForUat(
      "solo-admin",
      {
        claimedWebPort: claimedPort(process.env.JARVIS_UAT_CLAIMED_WEB_PORT),
        n3Observer: plan.option
      },
      { n3BuildEvidence: plan.collector, runId: plan.runId }
    );
    check(!stopped, "interrupted during provisioning");
    phase = "observer-open";
    consumer = plan.collector.compose().consumer;
    await consumer.open();
    windows = serveWindows(evidence, consumer);
    phase = "installed-source-correspondence";
    const image = `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG}`;
    const imageId = capture("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
    check(/^sha256:[a-f0-9]{64}$/.test(imageId), "immutable image missing");
    const container = `${stack.projectName}-jarv1s-1`;
    check(
      capture("docker", ["inspect", "--format", "{{.Image}}", container]) === imageId,
      "installed image mismatch"
    );
    const databaseBoundary = capture("docker", [
      "exec",
      container,
      "node",
      "-e",
      "const roles=['BOOTSTRAP','MIGRATION','APP','AUTH','WORKER'];" +
        "for(const role of roles){const u=new URL(process.env['MOSS_'+role+'_DATABASE_URL']??process.env['JARVIS_'+role+'_DATABASE_URL']);" +
        "if(u.hostname!=='postgres'||u.port!=='5432'||u.pathname!=='/jarv1s')process.exit(1)};console.log('owned-compose-postgres')"
    ]);
    check(databaseBoundary === "owned-compose-postgres", "UAT DB endpoint mismatch");
    const installed: Record<string, string> = {};
    for (const path of PRODUCT) {
      const hash = capture("docker", ["exec", container, "sha256sum", `/app/${path}`]).split(
        /\s+/
      )[0]!;
      check(hash === digest(readFileSync(path)), "installed product bytes mismatch");
      installed[path] = hash;
    }
    const input = JSON.parse(readFileSync(join(evidence, "inputs.json"), "utf8")) as {
      head: string;
    };
    check(sourceReceipt().head === input.head, "source freeze changed during build");
    record(evidence, "installed.json", {
      project: stack.projectName,
      imageId,
      databaseBoundary,
      installed,
      callerRoot: process.env.N3_UAT_ROOT,
      fixtureRoots: ["/data/cli-auth", `/data/vaults/00000000-0000-4000-8000-000000000001`]
    });
    const env = {
      ...process.env,
      JARVIS_UAT_BASE_URL: stack.baseURL,
      JARVIS_UAT_PROJECT_NAME: stack.projectName,
      MOSS_UAT_CAPTURE_OFF: "1",
      MOSS_UAT_BROWSER: "chromium"
    };
    phase = "playwright";
    browserChild = startChild(
      [
        process.execPath,
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "tests/uat/playwright.uat.config.ts",
        "--workers=1",
        "--retries=0",
        "--reporter=line",
        "--output",
        join(process.env.N3_UAT_ROOT!, "playwright"),
        SPEC
      ],
      env,
      join(evidence, "playwright-raw.log")
    );
    result = await boundedChild(browserChild, runEnd);
    if (stopped) result = 1;
    if (result && Date.now() >= runEnd) phase = "time-box";
    phase = "observer-windows";
    verifyWindows(await windows.stop(), EXPECTED_WINDOWS);
  } catch (error) {
    console.error(error); // Quarantined worker-raw.log only; never relay this output.
    result = 1;
  } finally {
    teardown = await orderedTeardown({
      project: plan.runId.projectName,
      stopWindows: async () => windows?.stop(),
      closeObserver: async () => consumer?.close(),
      removeStack: async () => stack?.teardown(),
      listOwned: listOwnedResources,
      beforeStep: () => void remaining()
    });
    cleanup = teardown.errors;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await terminalRecord(evidence, "stack-exit.json", {
      result,
      cleanup,
      stopped,
      phase,
      teardown
    });
  }
  return result || cleanup ? 1 : 0;
}
async function removeDocker(list: string[], remove: string[], valid = (_id: string) => true) {
  const ids = capture("docker", list).split("\n").filter(Boolean);
  const errors = await cleanupAll(
    ids.map((id) => () => {
      check(valid(id), "Docker resource identity changed");
      capture("docker", [...remove, id]);
    })
  );
  check(errors === 0 && capture("docker", list) === "", "Docker inventory cleanup incomplete");
}
async function cleanupProject(project: string): Promise<void> {
  check(/^uat-\d+_[a-f0-9]{8}$/.test(project), "unowned project name");
  const filter = `label=com.docker.compose.project=${project}`;
  let errors = 0;
  for (const kind of ["container", "volume", "network"]) {
    const list = kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"];
    const remove = kind === "container" ? ["rm", "--force", "--volumes"] : [kind, "rm"];
    errors += await cleanupAll([() => removeDocker([...list, "--filter", filter], remove)]);
  }
  check(errors === 0, "project cleanup incomplete");
}
async function launch(destination: string): Promise<number> {
  requireFallbackObserver();
  process.umask(0o077);
  rejectOverrides(process.env);
  // All launch, observation, fixture, spec and cleanup calls inherit one endpoint.
  process.env.DOCKER_HOST = DOCKER_HOST;
  const source = sourceReceipt();
  check(
    isAbsolute(destination) && !existsSync(destination),
    "new absolute private evidence path required"
  );
  privateDir(dirname(destination));
  protocolEnd = Date.now() + TOTAL_MS;
  let root: string | undefined;
  let env: NodeJS.ProcessEnv = {};
  const nonce = randomBytes(12).toString("hex");
  const owner = `moss-n3-live-${nonce}`;
  const imageTag = `uat-n3-${nonce}`;
  const authPath = resolve(
    process.env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE ?? join(homedir(), ".codex/auth.json")
  );
  let port: number | undefined;
  let log: string | undefined;
  let start = -1;
  let wait = -1;
  let raw = -1;
  let interrupted = false;
  let operation: ChildProcess | undefined;
  // Sole observer captures anonymous PG volumes before gate EXIT removes their container.
  let gateResources: { container: string; id: string; volumes: string[] } | undefined;
  let gateIdentity: ProcessIdentity | undefined;
  let observerFailed = false;
  const observeGate = () => {
    try {
      const logs = readdirSync(join(root!, "gate")).filter((name) => name.endsWith(".log"));
      if (logs.length !== 1) return;
      const candidate = join(root!, "gate", logs[0]!);
      log ??= candidate;
      const contents = readFileSync(candidate, "utf8");
      const gatePid = Number(contents.match(/^### PID\s+(\d+)$/m)?.[1]);
      if (!gateIdentity && gatePid) {
        const identity = processIdentity(gatePid);
        if (identity) {
          const args = readFileSync(`/proc/${gatePid}/cmdline`, "utf8").split("\0");
          check(
            args.includes("__run") &&
              args.includes(candidate) &&
              args.some((arg) => arg.endsWith("run-gate.sh")),
            "unexpected gate process"
          );
          gateIdentity = identity;
          record(destination, "gate-process.json", identity);
        }
      }
      if (gateResources) return;
      const container = contents.match(/^### GATE_CONTAINER (jarv1s-gate-[\w-]+)/m)?.[1];
      if (!container) return;
      const result = spawnSync(
        "docker",
        ["inspect", "--format", "{{json .Mounts}}|{{.Id}}", container],
        { encoding: "utf8", timeout: remaining(2000), stdio: ["ignore", "pipe", "pipe"] }
      );
      if (result.status !== 0) return; // Container can still be in its recorded starting phase.
      const [mounts, id] = result.stdout.trim().split("|");
      const volumes = (JSON.parse(mounts!) as { Type: string; Name?: string }[])
        .filter((mount) => mount.Type === "volume")
        .map((mount) => mount.Name!);
      gateResources = { container, id: id!, volumes };
      record(destination, "gate-resources.json", gateResources);
    } catch {
      observerFailed = true;
    }
  };
  let observer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    interrupted = true;
    if (operation) {
      try {
        signalOwned(operation, "SIGTERM");
      } catch {
        observerFailed = true;
      }
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = setTimeout(stop, RUN_MS);
  let workerClosed = true;
  let projectsClean = true;
  const disposition = await protectedLifecycle(
    async () => {
      mkdirSync(destination, { mode: 0o700 });
      privateDir(destination);
      root = mkdtempSync(join(tmpdir(), "moss-n3-live-"));
      privateDir(root);
      for (const name of ["tmp", "chat", "cli", "gate"])
        mkdirSync(join(root, name), { mode: 0o700 });
      env = {
        ...process.env,
        N3_UAT_DEADLINE: String(protocolEnd),
        N3_UAT_ROOT: root,
        N3_UAT_EVIDENCE: destination,
        TMPDIR: join(root, "tmp"),
        JARVIS_CHAT_HOME: join(root, "chat"),
        JARVIS_CLI_HOME_BASE: join(root, "cli"),
        JARVIS_GATE_DIR: join(root, "gate"),
        JARVIS_IMAGE_TAG: imageTag,
        JARVIS_UAT_BUILD: "1",
        JARVIS_UAT_REAL_CHAT_PROVIDER: "codex",
        JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE: authPath
      };
      delete env.MOSS_CHAT_HOME;
      delete env.MOSS_CLI_HOME_BASE;
      observer = setInterval(observeGate, 500);
      check(!interrupted, "interrupted during setup");
      check(existsSync(authPath), "operator auth unavailable (presence only)");
      port = claimedPort(capture("devports", ["claim", owner]));
      Object.assign(env, { JARVIS_UAT_CLAIMED_WEB_PORT: String(port) });
      record(destination, "inputs.json", {
        ...source,
        nonce,
        owner,
        port,
        authPath,
        dockerEndpoint: DOCKER_HOST,
        root,
        imageTag,
        signup: "OUTSTANDING",
        seededLogin: "supplemental",
        rawCapture: true
      });
      workerClosed = false;
      projectsClean = false; // Gate may spawn even if every subsequent receipt fails.
      operation = startChild(
        ["scripts/run-gate.sh", "start", "--no-sweep", "--gate", "test:uat:3529-real"],
        env,
        join(destination, "start.out")
      );
      start = await boundedChild(operation);
      observeGate();
      const receipt = readFileSync(join(destination, "start.out"), "utf8");
      log = receipt.match(/^LOG=(.+)$/m)?.[1];
      // Start can fail before emitting LOG. Only this fresh root's sole log is admissible.
      if (!log) {
        const logs = readdirSync(join(root!, "gate")).filter((name) => name.endsWith(".log"));
        if (logs.length === 1) log = join(root, "gate", logs[0]!);
      }
      check(log && dirname(log) === join(root!, "gate"), "missing exact emitted gate log");
      check(start === 0 && !interrupted, "gate start failed/interrupted");
      operation = startChild(
        ["scripts/run-gate.sh", "wait", "--follow", "--log", log],
        env,
        join(destination, "wait.out")
      );
      wait = await boundedChild(operation);
      const gate = readFileSync(log, "utf8");
      raw = Number(gate.match(/^### FINAL rc=(\d+)$/m)?.[1] ?? -1);
    },
    async () => {
      clearInterval(observer);
      let cleanup = 0;
      const actions = [
        async () => {
          if (log && !/^### FINAL rc=/m.test(readFileSync(log, "utf8"))) {
            const gatePid = Number(readFileSync(log, "utf8").match(/^### PID\s+(\d+)$/m)?.[1]);
            check(gatePid, "missing owned gate PID");
            const current = processIdentity(gatePid);
            check(current, "gate PID gone without terminal receipt; do not signal reused group");
            validateProcess(gateIdentity, current);
            const child = startChild(
              ["scripts/run-gate.sh", "stop", "--log", log],
              env,
              join(destination, "stop.out")
            );
            check((await boundedChild(child)) === 0, "gate stop failed");
          }
        },
        async () => {
          if (!workerClosed) {
            // Absence after possible spawn is uncertainty, never closure.
            const until = Date.now() + remaining(40_000);
            while (!existsSync(join(destination, "worker-exit.json")) && Date.now() < until) {
              remaining();
              await new Promise((resume) => setTimeout(resume, Math.min(250, remaining())));
            }
            const pid = requireWorkerClosure(destination);
            workerClosed = true;
            const rawPath = join(destination, "worker-raw.log");
            const projects = projectsInLog(readFileSync(rawPath, "utf8"), pid);
            record(destination, "owned-projects.json", projects);
            check(
              (await cleanupAll(projects.map((project) => () => cleanupProject(project)))) === 0,
              "owned projects remain"
            );
            projectsClean = true;
          }
        },
        async () => {
          check(workerClosed, "worker not reaped");
          if (!log) return;
          const gate = readFileSync(log, "utf8");
          copyFileSync(log, join(destination, "gate.log"));
          const container = gate.match(/^### GATE_CONTAINER (jarv1s-gate-[\w-]+)/m)?.[1];
          check(
            container && gateResources?.container === container,
            "gate resource inventory missing"
          );
          await removeDocker(
            ["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`],
            ["rm", "--force", "--volumes"],
            (id) => id === gateResources!.id
          );
          for (const volume of gateResources!.volumes) {
            check(/^[a-f0-9]{64}$/.test(volume), "unexpected gate volume identity");
            await removeDocker(
              ["volume", "ls", "-q", "--filter", `name=^${volume}$`],
              ["volume", "rm"],
              (id) => id === volume
            );
          }
        },
        () => {
          check(workerClosed, "worker not reaped");
          if (!operation) return;
          const image = `ghcr.io/motioneso/moss:${imageTag}`;
          return removeDocker(["image", "ls", "-q", image], ["image", "rm"]);
        },
        () => {
          remaining();
          check(workerClosed, "worker not reaped");
          check(cleanup === 0 && !observerFailed, "retain port after any uncertain cleanup");
          check(projectsClean, "retain port reservation while owned stack cleanup is uncertain");
          if (port === undefined) return;
          check(
            readFileSync(`/tmp/devports/${port}/owner`, "utf8").trim() === owner,
            "port ownership changed"
          );
          capture("devports", ["release", String(port)]);
          check(!existsSync(`/tmp/devports/${port}`), "port reservation remains");
        }
      ];
      for (const action of actions) cleanup += await cleanupAll([action]);
      if (observerFailed || Date.now() >= protocolEnd) cleanup++;
      if (log && existsSync(log))
        raw = Number(readFileSync(log, "utf8").match(/^### FINAL rc=(\d+)$/m)?.[1] ?? -1);
      if (cleanup === 0)
        cleanup += await cleanupAll([
          () => {
            remaining();
            if (!root) return;
            privateDir(root);
            rmSync(root, { recursive: true });
            check(!existsSync(root), "owned root remains");
          }
        ]);
      // A failed cleanup retains the owned root for diagnosis, and terminal is RED.
      return cleanup;
    }
  );
  clearTimeout(timer);
  clearInterval(observer);
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  let cleanup = disposition.cleanup;
  let result =
    !disposition.failed && start === 0 && wait === 0 && raw === 0 && cleanup === 0 && !interrupted
      ? 0
      : 1;
  try {
    await terminalRecord(destination, "terminal.json", {
      start,
      wait,
      raw,
      cleanup,
      interrupted,
      result,
      deadline: protocolEnd,
      expired: Date.now() >= protocolEnd,
      workerClosed,
      projectsClean,
      rootRetained: root !== undefined && existsSync(root)
    });
  } catch {
    cleanup++;
    result = 1;
  }
  console.info(
    JSON.stringify({ n3: "supplemental", start, wait, raw, cleanup, result, signup: "OUTSTANDING" })
  );
  return cleanup ? 1 : result;
}
async function selfTest(): Promise<void> {
  let controls = 0;
  const windowLog = (modes: readonly ("positive" | "terminal")[], extra = {}) => ({
    completed: modes.map((mode, i) => ({ seq: i + 1, mode, window: i + 1, delta: {} })),
    failure: null,
    open: false,
    ...extra
  });
  verifyWindows(windowLog(EXPECTED_WINDOWS), EXPECTED_WINDOWS);
  for (const bad of [
    windowLog(["positive", "terminal"]),
    windowLog(["terminal", "terminal", "positive"]),
    windowLog(EXPECTED_WINDOWS, { open: true }),
    windowLog(EXPECTED_WINDOWS, { failure: "x" })
  ])
    assert.throws(() => verifyWindows(bad, EXPECTED_WINDOWS));
  controls += 5;
  for (const value of [undefined, "", "5173", "1533", "5300", "5180x"]) {
    assert.throws(() => claimedPort(value));
    controls++;
  }
  assert.equal(claimedPort("5180"), 5180);
  assert.equal(claimedPort("5299"), 5299);
  controls += 2;
  assert.deepEqual(
    projectsInLog(
      "[uat] provisioning uat-123_abcd1234 on port 5180 subnet x\n" +
        "[uat] provisioning uat-456_abcd1234 on port 5181 subnet x",
      123
    ),
    ["uat-123_abcd1234"]
  );
  controls++;
  for (const key of [
    "MOSS_UAT_REAL_CHAT_MODEL",
    "NODE_OPTIONS",
    "JARVIS_UAT_BUILD",
    "JARVIS_UAT_REAL_CHAT_PROVIDER",
    "DOCKER_HOST",
    "DOCKER_CONTEXT"
  ]) {
    assert.throws(() => rejectOverrides({ [key]: key.endsWith("BUILD") ? "0" : "override" }));
    controls++;
  }
  const identity = { pid: 42, start: "100", group: 42, session: 42 };
  validateProcess(identity, { ...identity });
  assert.throws(() => validateProcess(identity, { ...identity, start: "101" }));
  assert.throws(() => validateProcess(identity, { ...identity, group: 43 }));
  assert.throws(() => validateProcess(undefined, identity));
  controls += 4;
  const seen: number[] = [];
  const cleanupStep =
    (step: number, fail = false) =>
    () => {
      seen.push(step);
      if (fail) throw Error("synthetic cleanup failure");
    };
  assert.equal(await cleanupAll([cleanupStep(1, true), cleanupStep(2), cleanupStep(3, true)]), 2);
  assert.deepEqual(seen, [1, 2, 3]);
  controls++;
  const root = mkdtempSync(join(tmpdir(), "n3-fake-"));
  try {
    privateDir(root);
    record(root, "receipt.json", { synthetic: true });
    assert.equal(lstatSync(join(root, "receipt.json")).mode & 0o777, 0o600);
    assert.throws(() => record(root, "receipt.json", { replaced: true }));
    controls++;
    assert.throws(requireFallbackObserver, /N3_FALLBACK_OBSERVER_UNAVAILABLE/);
    controls++;
    for (const failAt of [0, 1, 2]) {
      let partial: string | undefined;
      const disposition = await protectedLifecycle(
        async () => {
          partial = mkdtempSync(join(root, "partial-"));
          for (let step = 0; step < 3; step++) {
            if (step === failAt) throw Error("synthetic setup failure");
            mkdirSync(join(partial, String(step)));
          }
        },
        async () =>
          cleanupAll([
            () => {
              if (partial) rmSync(partial, { recursive: true });
            }
          ])
      );
      assert.deepEqual(disposition, { failed: true, cleanup: 0 });
      assert.equal(existsSync(partial!), false);
      controls++;
    }
    const failedCleanup = await protectedLifecycle(
      () => Promise.reject(Error("setup")),
      () => Promise.reject(Error("cleanup"))
    );
    assert.deepEqual(failedCleanup, { failed: true, cleanup: 1 });
    controls++;
    const receiptRoot = mkdtempSync(join(root, "receipt-failure-"));
    let owned: ChildProcess | undefined;
    assert.equal(
      await supervisedWorker(
        receiptRoot,
        () => {
          owned = startChild(
            [process.execPath, "-e", "setTimeout(()=>process.exit(0),1000)"],
            process.env,
            join(receiptRoot, "child.log"),
            true
          );
          return owned;
        },
        2000,
        (directory, name, data) => {
          if (name === "worker.json") throw Error("synthetic receipt write failure");
          record(directory, name, data);
        }
      ),
      1
    );
    assert.equal(groupClosed(owned!), true);
    assert.throws(() => requireWorkerClosure(receiptRoot)); // Exit alone cannot replace identity.
    controls += 2;
    const identityRoot = mkdtempSync(join(root, "missing-identity-"));
    record(identityRoot, "worker.json", { pid: 42 });
    assert.throws(() => requireWorkerClosure(identityRoot));
    record(identityRoot, "worker-exit.json", { closed: false });
    assert.throws(() => requireWorkerClosure(identityRoot));
    controls += 2;
    protocolEnd = Date.now() + 80;
    assert(remaining(10) <= 10);
    const started = Date.now();
    assert.throws(() => capture(process.execPath, ["-e", "setTimeout(()=>{},1000)"]));
    assert(Date.now() - started < 750, "command exceeded aggregate deadline");
    assert.throws(() => remaining());
    const retained = mkdtempSync(join(root, "deadline-retains-"));
    assert.equal(await cleanupAll([() => rmSync(retained, { recursive: true })]), 1);
    assert.equal(existsSync(retained), true); // Expired cleanup retains actual owned roots.
    protocolEnd = Infinity;
    controls += 3;
    const raw = join(root, "child.log");
    const failed = startChild(
      [process.execPath, "-e", 'process.stderr.write("synthetic-private");process.exit(7)'],
      process.env,
      raw,
      true
    );
    assert.deepEqual(await supervise(failed, 5000).done, { rc: 7, interrupted: false });
    assert.equal(readFileSync(raw, "utf8"), "synthetic-private");
    assert.equal(lstatSync(raw).mode & 0o777, 0o600);
    controls++;
    const hanging = startChild(
      [process.execPath, "-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      process.env,
      join(root, "hanging.log"),
      true
    );
    const killed = await supervise(hanging, 200, 100).done;
    assert.equal(killed.interrupted, true);
    assert.notEqual(killed.rc, 0);
    assert.throws(() => process.kill(hanging.pid!, 0));
    assert.equal(groupClosed(hanging), true);
    controls++;
    const absent = startChild(
      [join(root, "missing-binary")],
      process.env,
      join(root, "absent.log"),
      true
    );
    assert.equal((await supervise(absent, 5000).done).rc, 1);
    controls++;
  } finally {
    rmSync(root, { recursive: true });
  }
  console.info(`N3 fake-only controls PASS (${controls}); no live effects`);
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") await selfTest();
  else if (args.length === 2 && args[0] === "--launch") await exitCli(launch(resolve(args[1]!)));
  else if (args.length === 1 && args[0] === "--worker") await exitCli(worker());
  else if (args.length === 0) await exitCli(gateMain());
  else throw new Error("invalid N3 runner invocation");
}
