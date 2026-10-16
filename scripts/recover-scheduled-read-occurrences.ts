/** Bounded deployment/support adapter. Never run as part of ordinary application startup. */
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { createPgBossClient } from "@moss/jobs";
import {
  validateScheduledReadTargets,
  validateScheduledReadCutover,
  seedScheduledReadCutover,
  recoverScheduledReadCutover,
  type ScheduledReadSupportMode,
  type ScheduledReadSupportDeps
} from "../packages/chat/src/scheduled-reads/cutover.js";

export const MAX_MANIFEST_BYTES = 256_000;

function parseArguments(argv: readonly string[]) {
  if (
    argv.length !== 5 ||
    !["seed", "recover"].includes(argv[0] ?? "") ||
    argv[1] !== "--manifest" ||
    !argv[2] ||
    argv[3] !== "--limit" ||
    !/^[1-9][0-9]*$/.test(argv[4] ?? "")
  )
    throw new Error("Usage: seed|recover --manifest <file> --limit <1..1000>");
  const limit = Number(argv[4]);
  if (!Number.isSafeInteger(limit) || limit > 1000) throw new Error("Invalid invocation bound");
  return { mode: argv[0] as ScheduledReadSupportMode, manifestPath: argv[2], limit };
}

export function parseRecoveryInvocation(argv: readonly string[], manifest: string) {
  const invocation = parseArguments(argv);
  if (Buffer.byteLength(manifest, "utf8") > MAX_MANIFEST_BYTES)
    throw new Error("Manifest exceeds byte bound");
  const targets = validateScheduledReadTargets(JSON.parse(manifest), invocation.limit);
  return { ...invocation, targets };
}

export async function executeRecoveryInvocation(
  invocation: ReturnType<typeof parseRecoveryInvocation>,
  deps: ScheduledReadSupportDeps
) {
  await validateScheduledReadCutover(invocation.targets, invocation.limit, deps);
  const entries = [];
  for (const target of invocation.targets) {
    try {
      entries.push(
        await (invocation.mode === "seed" ? seedScheduledReadCutover : recoverScheduledReadCutover)(
          target,
          deps
        )
      );
    } catch {
      // Database/queue errors can include SQL, private values or connection strings.
      entries.push({ ...target, status: "error" as const, error: "operation_failed" as const });
    }
  }
  const counts = {
    successful: entries.filter(
      (e) => !["error", "paused", "deferred", "terminal"].includes(e.status)
    ).length,
    deferred: entries.filter((e) => ["paused", "deferred"].includes(e.status)).length,
    terminal: entries.filter((e) => e.status === "terminal").length,
    failed: entries.filter((e) => e.status === "error").length
  };
  return { mode: invocation.mode, entries, counts, exitCode: counts.failed ? 1 : 0 };
}

export async function runRecoveryCli(argv: readonly string[]): Promise<number> {
  const args = parseArguments(argv);
  const file = await open(args.manifestPath, "r");
  let manifest: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Manifest must be a regular file");
    if (stat.size > MAX_MANIFEST_BYTES) throw new Error("Manifest exceeds byte bound");
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_MANIFEST_BYTES) throw new Error("Manifest exceeds byte bound");
    manifest = bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
  const invocation = parseRecoveryInvocation(argv, manifest);
  const connectionString = getMossDatabaseUrls().worker;
  const db = createDatabase({ connectionString, maxConnections: 1 });
  // Keep asynchronous client errors out of receipts; operation failures are scrubbed below.
  const boss = createPgBossClient(connectionString, {}, { onError: () => undefined });
  try {
    const role = await sql<{ allowed: boolean }>`select
      current_user = 'jarvis_worker_runtime' and session_user = current_user
      and not rolsuper and not rolbypassrls as allowed
      from pg_roles where rolname = current_user`.execute(db);
    if (role.rows[0]?.allowed !== true) throw new Error("Worker database role required");
    const deps = { dataContext: new DataContextRunner(db), boss };
    await validateScheduledReadCutover(invocation.targets, invocation.limit, deps);
    await boss.start();
    const receipt = await executeRecoveryInvocation(invocation, deps);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return receipt.exitCode;
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await db.destroy();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRecoveryCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(
        "Scheduled read support failed; verify invocation, manifest, worker role and schema.\n"
      );
      process.exitCode = 1;
    });
}
