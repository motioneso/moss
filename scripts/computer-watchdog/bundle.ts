import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export interface WatchdogBundle {
  readonly bytes: Buffer;
  readonly sha256: string;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Bundles one entry and everything it imports into a single CommonJS file.
 * The loader pins the hash of the file it runs, so the hash must cover all code that runs.
 */
export async function bundleWatchdog(root: string, entry: string): Promise<WatchdogBundle> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: "watchdog.cjs",
    platform: "node",
    target: "node24",
    format: "cjs",
    bundle: true,
    write: false,
    metafile: true,
    sourcemap: false,
    tsconfigRaw: {},
    logLevel: "silent"
  });
  const outputs = Object.values(result.metafile.outputs);
  if (
    result.outputFiles.length !== 1 ||
    outputs.some((output) => output.imports.some((item) => !item.external || !isBuiltin(item.path)))
  )
    throw new Error("Watchdog bundle has nonbuiltin runtime dependencies");
  const bytes = Buffer.from(result.outputFiles[0]!.contents);
  return Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
}

export const buildWatchdogBundle = (): Promise<WatchdogBundle> =>
  bundleWatchdog(repoRoot, "scripts/computer-watchdog.ts");
