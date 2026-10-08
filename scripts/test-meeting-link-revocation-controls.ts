import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

// Never treat a setup/import error as proof. Each mutation must fail its named, concrete
// assertion, and byte-for-byte restoration must pass the same test before proceeding.
const root = fileURLToPath(new URL("../", import.meta.url));
const suite = "tests/integration/meeting-link-revocation.test.ts";
const testName = "recording-only revocation refuses the next native upload";
interface Mutation {
  path: string;
  before: string;
  after: string;
}
interface Control {
  name: string;
  marker: string;
  difference: RegExp;
  edits: readonly Mutation[];
}
const controls: readonly Control[] = [
  {
    name: "recording-binding-and-fence-admission",
    marker: "revoked-next-native-audio-status",
    difference: /expected 200 to be 401/,
    // Both independent protections must be removed to admit revoked audio. Keep the
    // ordinary recording resolver intact so the failure is at the next-upload assertion.
    edits: [
      {
        path: "packages/meetings/src/capture-service.ts",
        before: `      await this.deps.assertRecordingBinding({
        actorUserId: actor.actorUserId,
        deviceId: grant.device_id,
        capabilityRevision: grant.capability_revision
      });`,
        after: "      void grant.capability_revision;"
      },
      {
        path: "packages/auth/src/capture-binding.ts",
        before: "    if (!capability.rows.length) throw new RecordingCapabilityError();",
        after: "    void capability;"
      }
    ]
  },
  {
    name: "request-revocation-persistence",
    marker: "revoked-immediate-persisted-grant-status",
    difference: /expected 'active' to be 'revoked'/,
    edits: [
      {
        path: "packages/meetings/src/capture-binding.ts",
        before: "    await repository.save(db, grant, state);",
        after: "    void state;"
      }
    ]
  },
  {
    name: "request-revocation-reason",
    marker: "revoked-immediate-persisted-reason",
    difference: /expected undefined to be 'recording-permission-revoked'/,
    edits: [
      {
        path: "packages/meetings/src/capture-binding.ts",
        before: "    state.revocationReason = failure.revocationReason;",
        after: "    void failure.revocationReason;"
      }
    ]
  }
];
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
    "expected 'active' to be 'revoked'",
    "expected undefined to be 'recording-permission-revoked'"
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
function validateAnchors(originals: ReadonlyMap<string, Buffer>) {
  for (const control of controls) {
    for (const edit of control.edits) {
      if (originals.get(edit.path)!.toString("utf8").split(edit.before).length !== 2)
        throw new Error(`${control.name}: expected exactly one source anchor in ${edit.path}`);
    }
  }
}
function restoreSources(originals: ReadonlyMap<string, Buffer>) {
  const failures: string[] = [];
  for (const [path, original] of originals) {
    try {
      writeFileSync(resolve(root, path), original);
      if (!readFileSync(resolve(root, path)).equals(original)) failures.push(path);
    } catch {
      failures.push(path);
    }
  }
  if (failures.length) throw new Error(`Source restoration failed: ${failures.join(", ")}`);
}
function mutateSources(control: Control, originals: ReadonlyMap<string, Buffer>) {
  const updated = new Map<string, string>();
  // Validate every input before writing anything, including multi-file controls.
  for (const [path, original] of originals) {
    if (!readFileSync(resolve(root, path)).equals(original))
      throw new Error(`Source changed during proof: ${path}`);
  }
  for (const edit of control.edits) {
    const before = updated.get(edit.path) ?? originals.get(edit.path)!.toString("utf8");
    updated.set(edit.path, before.replace(edit.before, edit.after));
  }
  for (const [path, contents] of updated) writeFileSync(resolve(root, path), contents);
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
/** Bounded synthetic assertion diagnostics, without stack traces or full report contents. */
export function failedAssertionLines(tests: readonly AssertionResult[]): string[] {
  return tests
    .filter((test) => test.status === "failed")
    .slice(0, 3)
    .map((test) => {
      const name = stripVTControlCharacters(test.fullName).replace(/\s+/g, " ").slice(0, 200);
      const first = stripVTControlCharacters(test.failureMessages[0] ?? "")
        .split(/\r?\n/)
        .find((line) => line.trim());
      const message = first?.trim().slice(0, 500) || "No assertion message";
      return `${name}: ${message}`;
    });
}
function reportFailures(result: Awaited<ReturnType<typeof runTests>>, label: string) {
  for (const line of failedAssertionLines(result.executed))
    console.error(`[meeting-link-revocation] ${label} FAIL ${line}`);
}
function assertGreen(result: Awaited<ReturnType<typeof runTests>>, label: string) {
  if (
    result.code !== 0 ||
    result.runtime.reason !== "passed" ||
    !result.report.success ||
    result.report.numFailedTests !== 0 ||
    result.executed.some((test) => test.status !== "passed")
  ) {
    reportFailures(result, label);
    throw new Error(`${label}: restored source is not green`);
  }
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
  const paths = [...new Set(controls.flatMap((control) => control.edits.map((edit) => edit.path)))];
  const originals = new Map(paths.map((path) => [path, readFileSync(resolve(root, path))]));
  validateAnchors(originals);
  if (mode === "--check") {
    console.log(
      "Validated 3 controls / 4 source anchors and proof recognition; no database or negative proof executed."
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
        mutateSources(control, originals);
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
        ) {
          reportFailures(result, control.name);
          throw new Error(
            `${control.name}: missing intended assertion failure (${control.marker})`
          );
        }
        console.log(`[meeting-link-revocation] ${control.name} RED at ${control.marker}`);
      } finally {
        restoreSources(originals);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
