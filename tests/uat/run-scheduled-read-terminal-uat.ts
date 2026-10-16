/**
 * #3529 supplemental seeded-owner N3 proof. Signup remains OUTSTANDING, as do
 * the nine existing blocking UATs, advisory, N1, cancellation/unsaved/fault and
 * due-worker proofs. This harness never runs those specs or activates a routine.
 *
 * EXECUTABLE PROTOCOL (only AFTER independent review of the exact clean SHA):
 *   cd ~/Jarv1s/.claude/worktrees/n3-terminal-creation
 *   pnpm exec tsx tests/uat/run-scheduled-read-terminal-uat.ts --launch <NEW-private-evidence-directory>
 * Read verify-gate first. --launch creates pre-import 0700 TMPDIR/chat/CLI/gate
 * roots, claims exactly one devport, then invokes exactly:
 *   scripts/run-gate.sh start --no-sweep --gate test:uat:3529-real
 * It waits ONCE with --follow --log <emitted-log>, records numeric start/wait/raw
 * exits, and checks both gate DB and UAT cleanup. No pipeline or automatic retry.
 * On interruption it stops that exact gate, awaits its children, then cleans only
 * recorded project labels, the unique image, roots and exact port reservation.
 * Linux process birth/group/session identities are rechecked before each signal
 * and gate stop. An uncertain surviving group retains resources and returns RED.
 * One explicit local Docker endpoint is inherited through launch and cleanup;
 * gate DB aliases are removed before importing the independent UAT provisioner.
 *
 * Private evidence includes unavoidable RAW provisioner setup-failure dumps
 * (app/DB/transcripts), seed credentials and assertions; 0700 directory/0600
 * files, no visual capture. Review bounded metadata before publication. This is
 * retention, NOT zero capture or secure erasure. Codex auth path is an identity
 * only; supported copying REUSES THE OPERATOR ACCOUNT in a disposable volume.
 * File presence is not ready authentication. The spec proves ready + real turns.
 * --self-test uses only fake receipts/lifecycle and local scratch: no Docker,
 * DB, browser, port claim, credential read, network or provider calls.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const RUN_MS = 12 * 60_000; // Entire proof, including build, stays far short of +30m.
const DOCKER_HOST = "unix:///var/run/docker.sock";
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
function capture(command: string, args: readonly string[], env = process.env): string {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 120_000,
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
  // Freeze every installed product file, not only the five changed chat files.
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
      await action();
    } catch {
      errors++;
    }
  }
  return errors;
}
export interface RefusalReceipt {
  admitted: boolean;
  structuredOk: number;
  ordinary: number;
  assistants: number;
  refused: boolean;
  stored: boolean;
  reminderDelta: number;
  sourceDelta: number;
  jobDelta: number;
}
export function assertRefusal(r: RefusalReceipt): void {
  check(r.admitted && r.structuredOk >= 1, "no admitted successful interpretation evidence");
  check(
    r.ordinary === 0 && r.assistants === 1 && r.refused && r.stored,
    "terminal persisted refusal absent"
  );
  check(r.reminderDelta === 0 && r.sourceDelta === 0 && r.jobDelta === 0, "refusal created work");
}
export interface SavedReceipt {
  owner: string;
  expectedOwner: string;
  item: string;
  expectedItem: string;
  repeat: string | null;
  due: number;
  submitted: number;
  finished: number;
  reminders: number;
  sources: number;
  jobs: number;
  ordinary: number;
  structuredOk: number;
}
export function assertSaved(r: SavedReceipt): void {
  check(r.owner === r.expectedOwner && r.item === r.expectedItem, "saved identity mismatch");
  check(
    r.repeat === null && Math.abs(r.due - r.submitted - 30 * 60_000) <= 90_000,
    "saved timing mismatch"
  );
  check(r.finished < r.due - 10 * 60_000, "proof too close to due time");
  check(
    r.reminders === 1 && r.sources === 1 && r.jobs === 1 && r.ordinary === 0 && r.structuredOk >= 1,
    "saved terminal inventory mismatch"
  );
}
function rejectOverrides(env: NodeJS.ProcessEnv): void {
  check(!env.DOCKER_HOST || env.DOCKER_HOST === DOCKER_HOST, "local Docker daemon required");
  for (const key of [
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "MOSS_UAT_REAL_CHAT_MODEL",
    "JARVIS_UAT_SEED_CHAT_SCRIPT",
    "MOSS_UAT_SEED_CHAT_SCRIPT",
    "MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF",
    "UAT_DOCKER_SUBNET",
    "MOSS_NATIVE_SANDBOX",
    "MOSS_UAT_NODE_ENV",
    "MOSS_TEST_GOOGLE_CALENDAR_BASE_URL",
    "JARVIS_ENV_FILE",
    "COMPOSE_FILE",
    "COMPOSE_PROJECT_NAME",
    "NODE_OPTIONS",
    "MOSS_UAT_REAL_CHAT_PROVIDER"
  ])
    check(!env[key], `override rejected: ${key}`);
  check(
    !env.JARVIS_UAT_REAL_CHAT_PROVIDER || env.JARVIS_UAT_REAL_CHAT_PROVIDER === "codex",
    "Codex required"
  );
  check(env.JARVIS_UAT_BUILD !== "0" && env.MOSS_UAT_BUILD !== "0", "fresh build required");
}
function startChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  log: string,
  detached = false
): ChildProcess {
  const fd = openSync(log, "wx", 0o600);
  try {
    const child = spawn(args[0]!, args.slice(1), { env, stdio: ["ignore", fd, fd], detached });
    if (child.pid) births.set(child, processIdentity(child.pid));
    return child;
  } finally {
    closeSync(fd);
  }
}
function settled(child: ChildProcess): Promise<number> {
  return new Promise((resolveResult) => {
    child.once("error", () => resolveResult(1));
    child.once("close", (code) => resolveResult(code ?? 1));
  });
}
interface ProcessIdentity {
  pid: number;
  start: string;
  group: number;
  session: number;
}
const births = new WeakMap<ChildProcess, ProcessIdentity | undefined>();
function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, start: fields[19]!, group: Number(fields[2]), session: Number(fields[3]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function validateProcess(expected: ProcessIdentity | undefined, actual: ProcessIdentity): void {
  check(
    expected && JSON.stringify(expected) === JSON.stringify(actual),
    "process identity changed"
  );
}
function signalOwned(child: ChildProcess, signal: NodeJS.Signals, group = false): void {
  if (!child.pid) return;
  const current = processIdentity(child.pid);
  if (!current) return;
  validateProcess(births.get(child), current); // Revalidate before EVERY TERM/KILL.
  if (group) check(current.group === child.pid && current.session === child.pid, "unowned group");
  try {
    process.kill(group ? -child.pid : child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function groupClosed(child: ChildProcess): boolean {
  if (!child.pid) return true;
  return !readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .some((name) => processIdentity(Number(name))?.group === child.pid);
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
  const child = startChild(
    [process.execPath, "--import", "tsx", SELF, "--worker"],
    process.env,
    join(evidence, "worker-raw.log"),
    true
  );
  record(evidence, "worker.json", { pid: child.pid });
  const result = await supervise(child, RUN_MS);
  const closed = groupClosed(child);
  record(evidence, "worker-exit.json", { ...result, closed });
  return result.interrupted || !closed ? 1 : result.rc;
}
async function supervise(
  child: ChildProcess,
  budget: number,
  grace = 30_000
): Promise<{ rc: number; interrupted: boolean }> {
  let interrupted = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    interrupted = true;
    signalOwned(child, "SIGTERM", true);
    killer ??= setTimeout(() => signalOwned(child, "SIGKILL", true), grace);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const deadline = setTimeout(stop, budget);
  try {
    const rc = await settled(child);
    return { rc, interrupted };
  } finally {
    clearTimeout(deadline);
    clearTimeout(killer);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    // Covers descendants surviving a failed/killed Playwright or provisioning child.
    signalOwned(child, "SIGKILL", true);
  }
}
async function worker(): Promise<number> {
  check(
    process.env.JARVIS_GATE_RUN === "1" && process.env.N3_UAT_ROOT,
    "worker requires owned gate"
  );
  const evidence = process.env.N3_UAT_EVIDENCE!;
  // Gate DB URLs belong to migrations, never to the independently provisioned UAT.
  for (const prefix of ["MOSS", "JARVIS"])
    for (const role of ["BOOTSTRAP", "MIGRATION", "APP", "AUTH", "WORKER"])
      delete process.env[`${prefix}_${role}_DATABASE_URL`];
  const { provisionForUat } = await import("./provisioner.js");
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
  try {
    stack = await provisionForUat("solo-admin", {
      claimedWebPort: claimedPort(process.env.JARVIS_UAT_CLAIMED_WEB_PORT)
    });
    check(!stopped, "interrupted during provisioning");
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
    result = await settled(browserChild);
    if (stopped) result = 1;
  } catch (error) {
    console.error(error); // Quarantined worker-raw.log only; never relay this output.
    result = 1;
  } finally {
    cleanup = await cleanupAll([
      async () => {
        await stack?.teardown();
      }
    ]);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    record(evidence, "stack-exit.json", { result, cleanup, stopped, phase });
  }
  return result || cleanup ? 1 : 0;
}
async function cleanupProject(project: string): Promise<void> {
  check(/^uat-\d+_[a-f0-9]{8}$/.test(project), "unowned project name");
  const filter = `label=com.docker.compose.project=${project}`;
  let errors = 0;
  for (const [kind, list, remove] of [
    ["container", ["ps", "-aq"], ["rm", "--force", "--volumes"]],
    ["volume", ["volume", "ls", "-q"], ["volume", "rm"]],
    ["network", ["network", "ls", "-q"], ["network", "rm"]]
  ] as const) {
    errors += await cleanupAll([
      () => {
        const ids = capture("docker", [...list, "--filter", filter])
          .split("\n")
          .filter(Boolean);
        for (const id of ids) capture("docker", [...remove, id]);
        check(capture("docker", [...list, "--filter", filter]) === "", `${kind} cleanup failed`);
      }
    ]);
  }
  check(errors === 0, "project cleanup incomplete");
}
async function launch(destination: string): Promise<number> {
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
  mkdirSync(destination, { mode: 0o700 });
  privateDir(destination);
  const nonce = randomBytes(12).toString("hex");
  const root = mkdtempSync(join(tmpdir(), "moss-n3-live-"));
  privateDir(root);
  for (const name of ["tmp", "chat", "cli", "gate"]) mkdirSync(join(root, name), { mode: 0o700 });
  const owner = `moss-n3-live-${nonce}`;
  const imageTag = `uat-n3-${nonce}`;
  const authPath = resolve(
    process.env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE ?? join(homedir(), ".codex/auth.json")
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
  let port: number | undefined;
  let log: string | undefined;
  let start = -1;
  let wait = -1;
  let raw = -1;
  let interrupted = false;
  let operation: ChildProcess | undefined;
  // Owned resource observer, part of this sole monitor: record anonymous PG
  // volume IDs BEFORE run-gate's container-only EXIT cleanup loses their identity.
  let gateResources: { container: string; id: string; volumes: string[] } | undefined;
  let gateIdentity: ProcessIdentity | undefined;
  let observerFailed = false;
  const observeGate = () => {
    try {
      const logs = readdirSync(join(root, "gate")).filter((name) => name.endsWith(".log"));
      if (logs.length !== 1) return;
      const candidate = join(root, "gate", logs[0]!);
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
        { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }
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
  const observer = setInterval(observeGate, 500);
  const stop = () => {
    interrupted = true;
    if (operation) signalOwned(operation, "SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = setTimeout(stop, RUN_MS + 120_000);
  let cleanup: number;
  let workerClosed = true;
  let projectsClean = true;
  try {
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
    operation = startChild(
      ["scripts/run-gate.sh", "start", "--no-sweep", "--gate", "test:uat:3529-real"],
      env,
      join(destination, "start.out")
    );
    start = await settled(operation);
    observeGate();
    const receipt = readFileSync(join(destination, "start.out"), "utf8");
    log = receipt.match(/^LOG=(.+)$/m)?.[1];
    // Start can fail before emitting LOG. Only this fresh root's sole log is admissible.
    if (!log) {
      const logs = readdirSync(join(root, "gate")).filter((name) => name.endsWith(".log"));
      if (logs.length === 1) log = join(root, "gate", logs[0]!);
    }
    check(log && dirname(log) === join(root, "gate"), "missing exact emitted gate log");
    check(start === 0 && !interrupted, "gate start failed/interrupted");
    operation = startChild(
      ["scripts/run-gate.sh", "wait", "--follow", "--log", log],
      env,
      join(destination, "wait.out")
    );
    wait = await settled(operation);
    const gate = readFileSync(log, "utf8");
    raw = Number(gate.match(/^### FINAL rc=(\d+)$/m)?.[1] ?? -1);
  } catch {
    // Numeric failure and private receipts are retained; no raw diagnostics on stdout.
  } finally {
    clearTimeout(timer);
    clearInterval(observer);
    cleanup = await cleanupAll([
      async () => {
        if (log && !/^### FINAL rc=/m.test(readFileSync(log, "utf8"))) {
          const gatePid = Number(readFileSync(log, "utf8").match(/^### PID\s+(\d+)$/m)?.[1]);
          if (gatePid) {
            const current = processIdentity(gatePid);
            check(current, "gate PID gone without terminal receipt; do not signal reused group");
            validateProcess(gateIdentity, current);
          }
          const child = startChild(
            ["scripts/run-gate.sh", "stop", "--log", log],
            env,
            join(destination, "stop.out")
          );
          check((await settled(child)) === 0, "gate stop failed");
        }
      },
      async () => {
        const workerPath = join(destination, "worker.json");
        if (existsSync(workerPath)) {
          workerClosed = false;
          projectsClean = false;
          const { pid } = JSON.parse(readFileSync(workerPath, "utf8")) as { pid: number };
          check(Number.isSafeInteger(pid) && pid > 1, "invalid owned child");
          // run-gate stop waits only 20s; our worker can need 30s to reap children.
          // Do not tear resources out from under provisioning/build/browser work.
          const until = Date.now() + 40_000;
          while (!existsSync(join(destination, "worker-exit.json")) && Date.now() < until)
            await new Promise((resume) => setTimeout(resume, 250));
          const exitPath = join(destination, "worker-exit.json");
          workerClosed =
            existsSync(exitPath) &&
            (JSON.parse(readFileSync(exitPath, "utf8")) as { closed?: boolean }).closed === true;
          check(workerClosed, "worker close receipt missing; retain owned resources");
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
      () => {
        check(workerClosed, "worker not reaped");
        if (!log) return;
        const gate = readFileSync(log, "utf8");
        copyFileSync(log, join(destination, "gate.log"));
        const container = gate.match(/^### GATE_CONTAINER (jarv1s-gate-[\w-]+)/m)?.[1];
        check(
          container && gateResources?.container === container,
          "gate resource inventory missing"
        );
        const ids = capture("docker", [
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          `name=^/${container}$`
        ]);
        if (ids) {
          check(ids === gateResources!.id, "gate container identity changed");
          capture("docker", ["rm", "--force", "--volumes", ids]);
        }
        for (const volume of gateResources!.volumes) {
          check(/^[a-f0-9]{64}$/.test(volume), "unexpected gate volume identity");
          const remains = capture("docker", ["volume", "ls", "-q", "--filter", `name=^${volume}$`]);
          if (remains) capture("docker", ["volume", "rm", volume]);
          check(
            capture("docker", ["volume", "ls", "-q", "--filter", `name=^${volume}$`]) === "",
            "gate volume remains"
          );
        }
        check(
          capture("docker", ["ps", "-aq", "--no-trunc", "--filter", `name=^/${container}$`]) === "",
          "gate container remains"
        );
      },
      () => {
        check(workerClosed, "worker not reaped");
        const image = `ghcr.io/motioneso/moss:${imageTag}`;
        const images = capture("docker", ["image", "ls", "-q", image]);
        if (images) capture("docker", ["image", "rm", image]);
        check(capture("docker", ["image", "ls", "-q", image]) === "", "owned image remains");
      },
      () => {
        check(workerClosed, "worker not reaped");
        check(projectsClean, "retain port reservation while owned stack cleanup is uncertain");
        if (port === undefined) return;
        check(
          readFileSync(`/tmp/devports/${port}/owner`, "utf8").trim() === owner,
          "port ownership changed"
        );
        capture("devports", ["release", String(port)]);
        check(!existsSync(`/tmp/devports/${port}`), "port reservation remains");
      }
    ]);
    if (observerFailed) cleanup++;
    if (log && existsSync(log))
      raw = Number(readFileSync(log, "utf8").match(/^### FINAL rc=(\d+)$/m)?.[1] ?? -1);
    if (cleanup === 0)
      cleanup += await cleanupAll([
        () => {
          privateDir(root);
          rmSync(root, { recursive: true });
          check(!existsSync(root), "owned root remains");
        }
      ]);
    // A failed cleanup retains the owned root for diagnosis, and terminal is RED.
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  const result = start === 0 && wait === 0 && raw === 0 && cleanup === 0 && !interrupted ? 0 : 1;
  record(destination, "terminal.json", { start, wait, raw, cleanup, interrupted, result });
  console.info(
    JSON.stringify({ n3: "supplemental", start, wait, raw, cleanup, result, signup: "OUTSTANDING" })
  );
  return result;
}
async function selfTest(): Promise<void> {
  let controls = 0;
  for (const value of [undefined, "", "5173", "1533", "5300", "5180x"]) {
    assert.throws(() => claimedPort(value));
    controls++;
  }
  assert.equal(claimedPort("5180"), 5180);
  assert.equal(claimedPort("5299"), 5299);
  controls += 2;
  const refusal: RefusalReceipt = {
    admitted: true,
    structuredOk: 1,
    ordinary: 0,
    assistants: 1,
    refused: true,
    stored: true,
    reminderDelta: 0,
    sourceDelta: 0,
    jobDelta: 0
  };
  assertRefusal(refusal);
  controls++;
  for (const mutation of [
    { admitted: false },
    { structuredOk: 0 },
    { ordinary: 1 },
    { assistants: 2 },
    { refused: false },
    { stored: false },
    { reminderDelta: 1 },
    { sourceDelta: 1 },
    { jobDelta: 1 }
  ]) {
    assert.throws(() => assertRefusal({ ...refusal, ...mutation }));
    controls++;
  }
  const saved: SavedReceipt = {
    owner: "a",
    expectedOwner: "a",
    item: "b",
    expectedItem: "b",
    repeat: null,
    submitted: 0,
    due: 1_800_000,
    finished: 10_000,
    reminders: 1,
    sources: 1,
    jobs: 1,
    ordinary: 0,
    structuredOk: 1
  };
  assertSaved(saved);
  controls++;
  for (const mutation of [
    { owner: "foreign" },
    { item: "wrong" },
    { repeat: "interval" },
    { due: 1000 },
    { finished: 1_700_000 },
    { reminders: 0 },
    { sources: 2 },
    { jobs: 0 },
    { ordinary: 1 },
    { structuredOk: 0 }
  ]) {
    assert.throws(() => assertSaved({ ...saved, ...mutation }));
    controls++;
  }
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
  assert.equal(
    await cleanupAll([
      () => {
        seen.push(1);
        throw Error("setup");
      },
      async () => {
        seen.push(2);
      },
      () => {
        seen.push(3);
        throw Error("teardown");
      }
    ]),
    2
  );
  assert.deepEqual(seen, [1, 2, 3]);
  controls++;
  const root = mkdtempSync(join(tmpdir(), "n3-fake-"));
  try {
    privateDir(root);
    record(root, "receipt.json", { synthetic: true });
    assert.equal(lstatSync(join(root, "receipt.json")).mode & 0o777, 0o600);
    assert.throws(() => record(root, "receipt.json", { replaced: true }));
    controls++;
    const raw = join(root, "child.log");
    const failed = startChild(
      [process.execPath, "-e", 'process.stderr.write("synthetic-private");process.exit(7)'],
      process.env,
      raw,
      true
    );
    assert.deepEqual(await supervise(failed, 5000), { rc: 7, interrupted: false });
    assert.equal(readFileSync(raw, "utf8"), "synthetic-private");
    assert.equal(lstatSync(raw).mode & 0o777, 0o600);
    controls++;
    const hanging = startChild(
      [process.execPath, "-e", 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      process.env,
      join(root, "hanging.log"),
      true
    );
    const killed = await supervise(hanging, 200, 100);
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
    assert.equal((await supervise(absent, 5000)).rc, 1);
    controls++;
  } finally {
    rmSync(root, { recursive: true });
  }
  console.info(`N3 fake-only controls PASS (${controls}); no live effects`);
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--self-test") await selfTest();
  else if (args.length === 2 && args[0] === "--launch")
    process.exitCode = await launch(resolve(args[1]!));
  else if (args.length === 1 && args[0] === "--worker") process.exitCode = await worker();
  else if (args.length === 0) process.exitCode = await gateMain();
  else throw new Error("invalid N3 runner invocation");
}
