import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// #1324: `pnpm test:unit <file>` looked like it ran only <file>, but pnpm appends CLI args onto
// the package.json script's own args rather than replacing them, so the actual invocation was
// `vitest run tests/unit <file>` — the whole directory glob plus the one file, silently. This is
// the same flaw #1314 fixed for `test:integration`; mirroring that fix here so "no args" and
// "args" are two distinct, deliberate cases instead of one string pnpm can accidentally extend.
const UNIT_VITEST_ARGS: readonly string[] = ["--fileParallelism", "--maxWorkers=2"];
// #2236: `vitest run <path>` filters against the FULL resolved file path, not a path relative
// to this script's cwd (repo root, since pnpm always runs scripts from the package that
// declares them - here that's already the root). "tests/unit" alone silently drops every
// package-local test directory vitest.config.ts's `include` also lists (packages/scratchpad,
// packages/people, ...), because none of those paths contain the substring "tests/unit". Each
// package-local suite has to be named explicitly here or CI never runs it.
const DEFAULT_VITEST_ARGS: readonly string[] = [
  "tests/unit",
  "packages/scratchpad/src/__tests__",
  "packages/acp/src",
  "packages/settings/src/app-action-tools.test.ts",
  "packages/ai/src/gateway/per-call-resolver.test.ts",
  "packages/ai/src/gateway/policy.test.ts",
  // Pure harness regressions live beside UAT code but do not provision Docker or providers.
  "tests/uat/fixtures/meeting-chat-fixture-server.test.ts",
  "tests/uat/provisioner.test.ts"
];

export function resolveVitestArgs(cliArgs: readonly string[], shard?: string): string[] {
  // CI sharding must not become a positional argument that replaces the default filters.
  // Vitest normalizes malformed shard values; reject those at this dedicated input boundary.
  if (shard !== undefined) {
    const parts = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
    const index = Number(parts?.[1]);
    const count = Number(parts?.[2]);
    if (!parts || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
      throw new Error(
        "MOSS_UNIT_TEST_SHARD must be positive safe integers index/count, index<=count"
      );
    }
  }
  return [
    ...UNIT_VITEST_ARGS,
    ...(cliArgs.length > 0 ? cliArgs : DEFAULT_VITEST_ARGS),
    ...(shard === undefined ? [] : [`--shard=${shard}`])
  ];
}

function runVitest(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("vitest", ["run", ...args], {
      env: process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`vitest exited with status ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  await runVitest(resolveVitestArgs(process.argv.slice(2), process.env.MOSS_UNIT_TEST_SHARD));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
