// The day-plan apply protections, each removed once in a disposable copy of the
// working tree; the matching unit test must fail. A protection test never seen
// failing proves nothing, so a control that stays green fails this gate. The
// database row-security controls run inside the day_plan_apply suite instead,
// as RED/GREEN sequences against the live policies.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const root = process.cwd();
let failed = false;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console[ok ? "log" : "error"](`${ok ? "PASS" : "FAIL"}: ${name}`, ok ? "" : JSON.stringify(detail));
  if (!ok) failed = true;
};
const tail = (text: string) => text.split("\n").slice(-40).join("\n");

// The protected suites must pass first: the guest suites that guard the
// protections this gate removes.
const green = (manifestPath: string, suite?: string) => {
  const args = ["+1.95.0", "test", "--locked", "--offline", "--manifest-path", manifestPath];
  if (suite) args.push("--test", suite);
  const run = spawnSync("cargo", args, { encoding: "utf8", env: process.env });
  if (run.status !== 0) console.error(tail(run.stdout + run.stderr));
  return run.status === 0;
};

type Control = {
  name: string;
  file: string;
  pattern: RegExp;
  replacement: string;
  expect: number;
  /** The guest test target that proves this protection. */
  suite: "apply" | "execution";
  test: string;
};

const controls: Control[] = [
  {
    name: "confirm binding equality",
    // Widening the binding comparison to always match must let a drifted or
    // foreign approval execute the gated batch.
    file: "modules/calendar/src/change_approval.rs",
    pattern: /skip \|\| mine == theirs/,
    replacement: "true",
    expect: 1,
    suite: "execution",
    test: "confirm_refuses_a_foreign_or_drifted_approval_and_writes_nothing"
  },
  {
    name: "idempotency replay branch",
    // A reserve that never finds the stored header must re-execute a replayed
    // apply instead of returning the stored result.
    file: "modules/calendar/src/apply.rs",
    pattern: /let found = query\(\n/,
    replacement: "let found: Vec<Value> = vec![]; let _ = query(\n",
    expect: 1,
    suite: "execution",
    test: "a_replayed_apply_returns_the_settled_result_without_new_provider_work"
  },
  {
    name: "fail-closed availability probe",
    // A probe that answers without the Connectors package must let the route
    // write the reservation before failing.
    file: "modules/calendar/src/execution.rs",
    pattern: /\)\?;\n    Ok\(Accounts \{/,
    replacement: ').unwrap_or(json!({"accounts":[],"gaps":[]}));\n    Ok(Accounts {',
    expect: 1,
    suite: "apply",
    test: "the_route_validates_then_fails_closed_without_writing"
  }
];

const scratch = mkdtempSync(join(tmpdir(), "js394-apply-"));
const copyTree = (name: string) => {
  const top = join(root, name);
  cpSync(top, join(scratch, name), {
    recursive: true,
    filter: (source: string) => source === top || !/\/(target|node_modules)(\/|$)/.test(source.slice(top.length))
  });
};
try {
  check("the protected guest suites pass", green("modules/calendar/src/Cargo.toml"));
  copyTree("rust-spike");
  copyTree("modules");
  const copy = join(scratch, "modules/calendar/src/Cargo.toml");
  // The copy builds against its own target directory, deleted with the scratch.
  const copyTarget = join(scratch, "target");
  for (const control of controls) {
    const path = join(scratch, control.file);
    const original = readFileSync(path, "utf8");
    const hits = original.match(control.pattern)?.length ?? 0;
    if (hits !== control.expect) {
      check(`removal control ${control.name} found its protection`, false, {
        expected: control.expect,
        found: hits
      });
      continue;
    }
    writeFileSync(path, original.replace(control.pattern, control.replacement));
    const attempt = spawnSync(
      "cargo",
      [
        "+1.95.0",
        "test",
        "--locked",
        "--offline",
        "--manifest-path",
        copy,
        "--test",
        control.suite,
        "--",
        control.test,
        "--exact"
      ],
      { encoding: "utf8", env: { ...process.env, CARGO_TARGET_DIR: copyTarget } }
    );
    const caught =
      attempt.status !== 0 && /test result: FAILED/.test(attempt.stdout + attempt.stderr);
    if (!caught) console.error(tail(attempt.stdout + attempt.stderr));
    check(`removal control ${control.name} fails its test`, caught, {
      status: attempt.status
    });
    writeFileSync(path, original);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
