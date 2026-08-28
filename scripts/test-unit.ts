import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// #1324: `pnpm test:unit <file>` looked like it ran only <file>, but pnpm appends CLI args onto
// the package.json script's own args rather than replacing them, so the actual invocation was
// `vitest run tests/unit <file>` — the whole directory glob plus the one file, silently. This is
// the same flaw #1314 fixed for `test:integration`; mirroring that fix here so "no args" and
// "args" are two distinct, deliberate cases instead of one string pnpm can accidentally extend.
const UNIT_VITEST_ARGS: readonly string[] = ["--fileParallelism", "--maxWorkers=2"];
const DEFAULT_VITEST_ARGS: readonly string[] = ["tests/unit"];

export function resolveVitestArgs(cliArgs: readonly string[]): string[] {
  return [...UNIT_VITEST_ARGS, ...(cliArgs.length > 0 ? cliArgs : DEFAULT_VITEST_ARGS)];
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
  await runVitest(resolveVitestArgs(process.argv.slice(2)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
