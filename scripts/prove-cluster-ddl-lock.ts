// #1632 liveness proof harness.
//
// DB-touching. Per docs/superpowers/specs/2026-08-14-1632-cluster-ddl-lock-liveness.md's Status
// line and issue #1632's approval comment: "No DB/full-gate proof until implementation review
// clears." That review has not cleared (no PR exists yet for this branch as of authoring). This
// file must not be executed until that gate clears — it exists so the harness itself is reviewable
// alongside the implementation, per the acceptance checklist's proof-gate section.
//
// Ported (not copied) from the frozen #1013 reference at build-1013-ddl-lock:8bc7cd112's
// scripts/prove-cluster-ddl-lock.ts. That harness drove two *separate* sessions (a lock-holder
// plus DDL sessions) and existed to attribute XX000s across concurrent participant databases.
// #1632's primitive collapses lock-holder and DDL onto one owner session by design, so the
// multi-database attribution machinery is no longer the interesting surface — the two scenarios
// below are the ones the #1632 spec's proof-gate checklist actually calls out:
//   --mode=solo         N iterations of acquire -> protected DDL -> release, one process.
//                        ("A solo locked proof of at least 30 iterations is green with persisted
//                        owner-liveness traces.")
//   --mode=owner-loss    Acquire, terminate the owner backend mid-callback from a second admin
//                        connection, assert the callback rejects with
//                        ClusterDdlLockLivenessLostError within a bounded window, then attempt a
//                        follower acquisition and assert it succeeds with no residue. ("A
//                        controlled owner-loss proof is green, including an owner killed during
//                        protected work and follower acquisition after backend death.")
//
// Diagnostics are suppressed: onDiagnostic events are collected in memory and only printed for a
// failing trial, so a passing run's stdout stays a one-line-per-trial summary.
import { setTimeout as delay } from "node:timers/promises";

import {
  ClusterDdlLockLivenessLostError,
  getClusterLockDatabaseUrl,
  getMossDatabaseUrls,
  withClusterDdlLock,
  type ClusterDdlLockDiagnosticEvent
} from "@moss/db";
import pg from "pg";

const { Client } = pg;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
}

const mode = argument("mode") ?? "solo";
const iterations = Number(argument("iterations") ?? 30);
const livenessIntervalMs = Number(argument("liveness-interval-ms") ?? 250);

interface Trial {
  readonly ok: boolean;
  readonly detail: string;
  readonly diagnostics: ClusterDdlLockDiagnosticEvent[];
  readonly detectionLatencyMs?: number;
}

function suppressedSink(
  diagnostics: ClusterDdlLockDiagnosticEvent[]
): (event: ClusterDdlLockDiagnosticEvent) => void {
  // Collected, never console.logged here — kept out of stdout on the success path. The caller
  // prints them only when a trial fails.
  return (event) => diagnostics.push(event);
}

async function runSolo(bootstrapUrl: string): Promise<Trial[]> {
  const trials: Trial[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const diagnostics: ClusterDdlLockDiagnosticEvent[] = [];
    try {
      const acquired = await withClusterDdlLock(
        bootstrapUrl,
        async (client) => {
          await client.query("SELECT 1");
          return true;
        },
        { livenessIntervalMs, onDiagnostic: suppressedSink(diagnostics) }
      );
      trials.push({
        ok: acquired === true,
        detail: `iteration ${iteration} acquired+released`,
        diagnostics
      });
    } catch (error) {
      trials.push({
        ok: false,
        detail: `iteration ${iteration} failed: ${error instanceof Error ? error.message : String(error)}`,
        diagnostics
      });
    }
  }
  return trials;
}

async function runOwnerLossAndFollower(bootstrapUrl: string): Promise<Trial[]> {
  const admin = new Client({ connectionString: getClusterLockDatabaseUrl(bootstrapUrl) });
  await admin.connect();

  const diagnostics: ClusterDdlLockDiagnosticEvent[] = [];
  let ownerPid: number | undefined;
  const startedAt = Date.now();

  const ownerRun = withClusterDdlLock(
    bootstrapUrl,
    async (client) => {
      const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      ownerPid = identity.rows[0]?.pid;
      // Idle window while "protected work" is nominally in flight — this is the bounded
      // owner-loss window the harness kills into, mirroring the checklist's "owner killed during
      // protected work" case rather than an already-idle-and-forgotten callback.
      await delay(livenessIntervalMs * 4);
      await client.query("SELECT 1"); // must never observe success past owner death
      return "callback-completed-after-kill" as const;
    },
    { livenessIntervalMs, onDiagnostic: suppressedSink(diagnostics) }
  );

  await delay(Math.max(50, livenessIntervalMs));
  const killDetail =
    ownerPid === undefined
      ? "owner pid unknown — kill skipped"
      : `terminated owner pid ${ownerPid}`;
  if (ownerPid !== undefined) {
    await admin.query("SELECT pg_terminate_backend($1)", [ownerPid]);
  }

  const trials: Trial[] = [];
  try {
    const outcome = await ownerRun;
    trials.push({
      ok: false,
      detail:
        `owner-loss FAILED: callback resolved (${JSON.stringify(outcome)}) instead of raising ` +
        "liveness loss",
      diagnostics
    });
  } catch (error) {
    const detectionLatencyMs = Date.now() - startedAt;
    const isLivenessLoss = error instanceof ClusterDdlLockLivenessLostError;
    trials.push({
      ok: isLivenessLoss,
      detail: isLivenessLoss
        ? `owner-loss detected via ${(error as ClusterDdlLockLivenessLostError).signal} after ` +
          `~${detectionLatencyMs}ms (${killDetail})`
        : `owner-loss FAILED: wrong error type — ` +
          `${error instanceof Error ? error.constructor.name : typeof error}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      diagnostics,
      detectionLatencyMs
    });
  }

  const followerDiagnostics: ClusterDdlLockDiagnosticEvent[] = [];
  try {
    await withClusterDdlLock(
      bootstrapUrl,
      async (client) => {
        await client.query("SELECT 1");
      },
      { livenessIntervalMs, onDiagnostic: suppressedSink(followerDiagnostics) }
    );
    trials.push({
      ok: true,
      detail: "follower-acquisition succeeded after owner death",
      diagnostics: followerDiagnostics
    });
  } catch (error) {
    trials.push({
      ok: false,
      detail: `follower-acquisition FAILED: ${error instanceof Error ? error.message : String(error)}`,
      diagnostics: followerDiagnostics
    });
  } finally {
    await admin.end();
  }

  return trials;
}

async function main(): Promise<void> {
  if (mode !== "solo" && mode !== "owner-loss") {
    throw new Error(`--mode must be "solo" or "owner-loss", got "${mode}"`);
  }
  const bootstrapUrl = getMossDatabaseUrls().bootstrap;
  const trials =
    mode === "owner-loss"
      ? await runOwnerLossAndFollower(bootstrapUrl)
      : await runSolo(bootstrapUrl);

  const failed = trials.filter((trial) => !trial.ok);
  console.log(`ddl-lock proof mode=${mode} trials=${trials.length} failed=${failed.length}`);
  for (const trial of trials) console.log(`  ${trial.ok ? "PASS" : "FAIL"}: ${trial.detail}`);
  for (const trial of failed) {
    // Suppressed on success; a failing trial is exactly when the diagnostic trace is needed.
    console.log(`  diagnostics: ${JSON.stringify(trial.diagnostics)}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

await main();
