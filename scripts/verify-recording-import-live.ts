/** Run only through run-gate.sh: owns a throwaway database and short-lived dev server. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGateRunDatabaseAccess } from "@moss/db";
import type { FastifyInstance } from "fastify";

const execute = promisify(execFile);
assertGateRunDatabaseAccess(process.env);
const browserScript = process.env.VOCCI_LIVE_BROWSER_SCRIPT;
if (!browserScript)
  throw new Error("Set VOCCI_LIVE_BROWSER_SCRIPT to the private browser proof script");
const port = Number((await execute("devports", ["claim", "vocci-import-proof"])).stdout.trim());
const directory = await mkdtemp(join(tmpdir(), "moss-recording-live-"));
process.env.PORT = String(port);
process.env.HOST = "127.0.0.1";
process.env.MOSS_VAULT_ROOT = join(directory, "vaults");
process.env.MOSS_EXTERNAL_MODULES_DIR = join(directory, "modules");
process.env.MOSS_AUTH_URL = `http://127.0.0.1:${port}`;
process.env.BETTER_AUTH_URL = process.env.MOSS_AUTH_URL;
let server: FastifyInstance | undefined;
try {
  const { createApiServer } = await import("../apps/api/src/server.js");
  server = createApiServer({ logger: false });
  await server.listen({ host: "127.0.0.1", port });
  const result = await execute("python3", [browserScript], {
    env: { ...process.env, VOCCI_LIVE_URL: `http://127.0.0.1:${port}` },
    timeout: 900_000,
    maxBuffer: 128 * 1024
  });
  process.stdout.write(result.stdout);
} catch {
  // Browser artifacts hold detailed, private diagnostics. Never dump captured transcript DOM.
  throw new Error("Recording live proof failed; inspect private browser proof artifacts");
} finally {
  try {
    await server?.close();
  } finally {
    await Promise.all([
      execute("devports", ["release", String(port)]),
      rm(directory, { recursive: true, force: true })
    ]);
  }
}
