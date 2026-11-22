// The approvals port against the real database with row-level security, through the real
// guest and service ports; then each protection is removed once in a disposable copy of the
// working tree and the matching test must fail. A protection test never seen failing proves
// nothing, so a control that stays green fails this gate.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { getMossDatabaseUrls } from "@moss/db";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
const urls = getMossDatabaseUrls();
const root = process.cwd();
const spike = join(root, "rust-spike");
const bootstrap = new pg.Client({ connectionString: urls.bootstrap });
let failed = false;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console[ok ? "log" : "error"](`${ok ? "PASS" : "FAIL"}: ${name}`, ok ? "" : JSON.stringify(detail));
  if (!ok) failed = true;
};
const tail = (text: string) => text.split("\n").slice(-60).join("\n");

// Each cargo run applies the host migration itself, so drop the schema first and every run
// recreates the table from the exact bytes under test, mutated copies included.
const freshSchema = () => bootstrap.query("DROP SCHEMA IF EXISTS moss_modules CASCADE");

function run(manifestPath: string, exact?: string) {
  const args = [
    "+1.95.0",
    "test",
    "--locked",
    "--offline",
    "--manifest-path",
    manifestPath,
    "--test",
    "approval_store_database",
    "--",
    "--include-ignored",
    "--nocapture",
    "--test-threads=1"
  ];
  if (exact) args.push("--exact", exact);
  return spawnSync("cargo", args, {
    encoding: "utf8",
    env: { ...process.env, JS43_APP_URL: urls.app, JS43_BOOTSTRAP_URL: urls.bootstrap }
  });
}

type Control = {
  name: string;
  file: string;
  pattern: RegExp;
  replacement: string;
  expect: number;
  test: string;
};

const controls: Control[] = [
  {
    name: "owner row security policy",
    file: "module-host/sql/0005_module_approvals.sql",
    // Both the USING and WITH CHECK clauses scope every row to the caller.
    pattern: /owner_user_id = app\.current_actor_user_id\(\)/g,
    replacement: "true",
    expect: 2,
    test: "another_accounts_record_is_not_found_and_changes_nothing"
  },
  {
    name: "module scope in get",
    file: "module-host/src/approval_port.rs",
    pattern: /WHERE id = \$1 AND module_id = \$2 AND resource = \$3"/,
    replacement: 'WHERE id = $1"',
    expect: 1,
    test: "a_modules_record_cannot_be_read_by_another_module"
  },
  {
    name: "single pending flip",
    file: "module-host/src/approval_port.rs",
    pattern: /AND resource = \$3 AND status = 'pending'/,
    replacement: "AND resource = $3",
    expect: 1,
    test: "a_second_confirm_is_refused_and_executes_nothing"
  }
];

try {
  await bootstrap.connect();
  // One disposable copy serves every control: each protection is planted, tested and
  // reverted in place, so the dependency build happens once, never in the working tree.
  const scratch = mkdtempSync(join(tmpdir(), "js399-approvals-"));
  cpSync(spike, join(scratch, "rust-spike"), {
    recursive: true,
    filter: (source: string) =>
      source === spike || !/\/target(\/|$)/.test(source.slice(spike.length))
  });
  const copy = join(scratch, "rust-spike");
  try {
    // The protected proof must pass first.
    await freshSchema();
    const proof = run(join(root, "rust-spike/module-host/Cargo.toml"));
    if (proof.status !== 0) console.error(tail(proof.stdout + proof.stderr));
    check("the protected approvals proof passes", proof.status === 0);

    for (const control of controls) {
      const path = join(copy, control.file);
      const original = readFileSync(path, "utf8");
      const mutated = original.replace(control.pattern, control.replacement);
      const hits = original.match(control.pattern)?.length ?? 0;
      if (hits !== control.expect) {
        check(
          `removal control ${control.name} found its protection`,
          false,
          `expected ${control.expect} match(es), found ${hits}`
        );
        continue;
      }
      writeFileSync(path, mutated);
      await freshSchema();
      const attempt = run(join(copy, "module-host/Cargo.toml"), control.test);
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
} finally {
  await Promise.allSettled([bootstrap.end()]);
}
process.exitCode = failed ? 1 : 0;
