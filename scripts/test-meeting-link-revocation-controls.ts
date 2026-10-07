import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Never treat a setup/import error as proof. Each mutation must fail its named, concrete
// assertion, and byte-for-byte restoration must pass the same test before proceeding.
const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "packages/meetings/src/capture-service.ts");
const suite = "tests/integration/meeting-link-revocation.test.ts";
const testName = "recording-only revocation refuses the next native upload";
const controls = [
  {
    name: "recording-binding-admission",
    marker: "revoked-next-native-audio-status",
    difference: /expected 200 to be 401/,
    before: `      await this.deps.assertRecordingBinding({
        actorUserId: actor.actorUserId,
        deviceId: grant.device_id,
        capabilityRevision: grant.capability_revision
      });`,
    after: "      void grant.capability_revision;"
  },
  {
    name: "browser-revocation-observation",
    marker: "revoked-browser-capture-state",
    difference: /expected 'recording' to be 'revoked'/,
    before: `            if (error instanceof MeetingCaptureError && error.httpStatus === 401)
              state.desired = "revoked";
            else throw error;`,
    after: `            if (error instanceof MeetingCaptureError && error.httpStatus === 401)
              void error;
            else throw error;`
  },
  {
    name: "browser-revocation-persistence",
    marker: "revoked-persisted-grant-status",
    difference: /expected 'active' to be 'revoked'/,
    before: `        if (JSON.stringify(state) !== grant.state_json)
          await this.repository.save(db, grant, state);`,
    after: "        void state;"
  }
] as const;
type Control = (typeof controls)[number];
interface AssertionResult {
  fullName: string;
  status: string;
  failureMessages: string[];
}
interface Report {
  numFailedTests: number;
  success: boolean;
  testResults: { assertionResults: AssertionResult[] }[];
}
interface CleanRuntimeReport {
  schemaVersion: 1;
  reason: "passed" | "failed";
  moduleCount: 1;
  unhandledErrors: 0;
  collectionErrors: 0;
}
function cleanRuntimeReport(value: unknown): value is CleanRuntimeReport {
  if (value === null || typeof value !== "object") return false;
  const report = value as Partial<CleanRuntimeReport>;
  return (
    report.schemaVersion === 1 &&
    (report.reason === "passed" || report.reason === "failed") &&
    report.moduleCount === 1 &&
    report.unhandledErrors === 0 &&
    report.collectionErrors === 0
  );
}
function expectedFailure(control: Control, text: string): boolean {
  return text.includes(`AssertionError: ${control.marker}:`) && control.difference.test(text);
}
function selfTest() {
  const runtime = {
    schemaVersion: 1,
    reason: "passed",
    moduleCount: 1,
    unhandledErrors: 0,
    collectionErrors: 0
  };
  if (!cleanRuntimeReport(runtime) || !cleanRuntimeReport({ ...runtime, reason: "failed" }))
    throw new Error("Proof recognition rejected a clean runtime receipt");
  for (const invalid of [
    null,
    {},
    { ...runtime, schemaVersion: 2 },
    { ...runtime, reason: "interrupted" },
    { ...runtime, moduleCount: 0 },
    { ...runtime, moduleCount: 2 },
    { ...runtime, unhandledErrors: 1 },
    { ...runtime, unhandledErrors: undefined },
    { ...runtime, collectionErrors: 1 },
    { ...runtime, collectionErrors: undefined }
  ]) {
    if (cleanRuntimeReport(invalid))
      throw new Error("Proof recognition accepted a missing or unclean runtime receipt");
  }
  const differences = [
    "expected 200 to be 401",
    "expected 'recording' to be 'revoked'",
    "expected 'active' to be 'revoked'"
  ];
  for (const [index, control] of controls.entries()) {
    const named = `${control.marker}: ${differences[index]}`;
    if (!expectedFailure(control, `AssertionError: ${named}`))
      throw new Error("Proof recognition rejected its named assertion");
    for (const invalid of [
      `Error: ${named}`,
      `AssertionError: ${differences[index]}`,
      `AssertionError: ${control.marker}: expected 503 to be 200`,
      `TypeError: ${control.marker}: fixture setup failed`
    ]) {
      if (expectedFailure(control, invalid))
        throw new Error("Proof recognition accepted a setup/unrelated failure");
    }
  }
}
function validateAnchors(original: string) {
  for (const control of controls) {
    if (original.split(control.before).length !== 2)
      throw new Error(`${control.name}: expected exactly one source anchor`);
  }
}
function restoreSource(original: Buffer) {
  writeFileSync(source, original);
  if (!readFileSync(source).equals(original)) throw new Error("Source restoration failed");
}
function requireHostedGate() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.JARVIS_GATE_RUN !== "1" ||
    process.env.MOSS_GATE_RUN !== "1"
  )
    throw new Error("Run --hosted only through the canonical gate on the hosted runner");
  const targets = new Set<string>();
  for (const prefix of ["JARVIS", "MOSS"]) {
    for (const role of ["BOOTSTRAP", "MIGRATION", "APP", "AUTH", "WORKER"]) {
      const url = new URL(process.env[`${prefix}_${role}_DATABASE_URL`] ?? "");
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.search ||
        url.hash ||
        !/^\/jarvis_gate_[a-zA-Z0-9_]+$/.test(url.pathname) ||
        url.pathname !== `/${process.env.JARVIS_PGDATABASE}`
      )
        throw new Error("Missing canonical isolated gate database identity");
      targets.add(`${url.hostname}:${url.port}${url.pathname}`);
    }
  }
  if (targets.size !== 1) throw new Error("Gate roles do not share one isolated database");
}

let interrupted = false;
let running: ChildProcess | undefined;
function interrupt() {
  interrupted = true;
  running?.kill("SIGTERM");
}
async function runTests(directory: string, label: string, selected: boolean) {
  if (interrupted) throw new Error("Interrupted; sources restored");
  const reportPath = resolve(directory, `${label}.json`);
  const runtimePath = resolve(directory, `${label}-runtime.json`);
  const log = createWriteStream(resolve(directory, `${label}.log`));
  const args = [
    "node_modules/vitest/vitest.mjs",
    "run",
    suite,
    ...(selected ? ["-t", testName] : []),
    "--reporter=json",
    "--reporter=./scripts/meeting-proof-runtime-reporter.ts",
    `--outputFile=${reportPath}`
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, MOSS_PROOF_RUNTIME_REPORT: runtimePath }
  });
  running = child;
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 300000);
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((resolveRun, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveRun({ code, signal }));
    });
  } finally {
    clearTimeout(timeout);
    running = undefined;
    await new Promise<void>((done) => log.end(done));
  }
  if (timedOut || interrupted || result.signal)
    throw new Error(`${label}: interrupted or timed out; not an assertion failure`);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  const runtime: unknown = JSON.parse(readFileSync(runtimePath, "utf8"));
  if (!cleanRuntimeReport(runtime))
    throw new Error(`${label}: missing or unclean runtime receipt; not an assertion failure`);
  const executed = report.testResults
    .flatMap((test) => test.assertionResults)
    .filter((test) => test.status === "passed" || test.status === "failed");
  if (
    executed.length !== (selected ? 1 : 2) ||
    (selected && !executed[0]!.fullName.includes(testName))
  )
    throw new Error(`${label}: wrong test selection or runtime failure`);
  return { ...result, report, runtime, executed };
}
function assertGreen(result: Awaited<ReturnType<typeof runTests>>, label: string) {
  if (
    result.code !== 0 ||
    result.runtime.reason !== "passed" ||
    !result.report.success ||
    result.report.numFailedTests !== 0 ||
    result.executed.some((test) => test.status !== "passed")
  )
    throw new Error(`${label}: restored source is not green`);
}

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--check", "--self-test", "--hosted"].includes(mode ?? ""))
    throw new Error("Expected --check, --self-test or --hosted");
  selfTest();
  if (mode === "--self-test") {
    console.log("Proof-recognition self-test passed; no database or source mutation executed.");
    return;
  }
  const original = readFileSync(source);
  validateAnchors(original.toString("utf8"));
  if (mode === "--check") {
    console.log(
      "Validated 3 source anchors and proof recognition; no database or negative proof executed."
    );
    return;
  }
  requireHostedGate();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupt);
  const directory = mkdtempSync(resolve(tmpdir(), "moss-meeting-revocation-"));
  let passed = false;
  try {
    assertGreen(await runTests(directory, "positive", false), "positive baseline");
    console.log("[meeting-link-revocation] Real recording-only revoke and Unlink baseline GREEN");
    for (const control of controls) {
      try {
        if (!readFileSync(source).equals(original)) throw new Error("Source changed during proof");
        writeFileSync(source, original.toString("utf8").replace(control.before, control.after));
        const result = await runTests(directory, `${control.name}-red`, true);
        const test = result.executed[0]!;
        if (
          result.code !== 1 ||
          result.runtime.reason !== "failed" ||
          result.report.success ||
          result.report.numFailedTests !== 1 ||
          test.status !== "failed" ||
          test.failureMessages.length !== 1 ||
          !expectedFailure(control, test.failureMessages[0]!)
        )
          throw new Error(
            `${control.name}: missing intended assertion failure (${control.marker})`
          );
        console.log(`[meeting-link-revocation] ${control.name} RED at ${control.marker}`);
      } finally {
        restoreSource(original);
      }
      assertGreen(await runTests(directory, `${control.name}-green`, true), control.name);
      console.log(`[meeting-link-revocation] ${control.name} restored GREEN`);
    }
    passed = true;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupt);
    if (passed) rmSync(directory, { recursive: true, force: true });
    else console.error(`[meeting-link-revocation] Failure reports retained at ${directory}`);
  }
}

await main();
