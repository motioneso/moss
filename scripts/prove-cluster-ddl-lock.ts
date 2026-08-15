// #1632 liveness proof harness.
//
// DB-touching. Per docs/superpowers/specs/2026-08-14-1632-cluster-ddl-lock-liveness.md's Status
// line and issue #1632's approval comment: "No DB/full-gate proof until implementation review
// clears." That review has not cleared. This file must not be executed until that gate clears — it
// exists so the harness itself is reviewable alongside the implementation, per the acceptance
// checklist's proof-gate section.
//
// #1632's primitive splits the lock holder and the DDL onto two sessions by design: a lock session
// on the maintenance database (where the advisory lock must live, because lock tags are keyed per
// database) and a DDL session on the caller's target database (where DDL must run). The three
// modes below are what the spec's proof-gate checklist calls out:
//   --mode=solo                 N iterations of acquire -> protected DDL -> release, one process.
//                               ("A solo locked proof of at least 30 iterations is green with
//                               persisted owner-liveness traces" — the `heartbeat` diagnostic
//                               events are those traces.)
//   --mode=owner-loss           Per iteration: acquire, terminate the LOCK-SESSION backend
//                               mid-callback from a second admin connection, assert the callback
//                               rejects with ClusterDdlLockLivenessLostError, then assert a
//                               follower acquires with no residue. Detection latency is measured
//                               from the kill instant and reported as p50/p99/max against the
//                               documented bound (2 x livenessIntervalMs + scheduler jitter).
//   --mode=cross-db             The live twin of the cross-database unit test: two child lanes,
//                               each looping locked role DDL against its own per-run-unique
//                               scratch database, must never overlap inside the locked section and
//                               must raise no shared-catalog errors. This is the scenario the
//                               round-2 per-target-database locking scheme passed in unit tests
//                               and failed in reality.
//
// Diagnostics are suppressed: onDiagnostic events are collected in memory and only printed for a
// failing trial, so a passing run's stdout stays a one-line-per-trial summary.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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
const laneDatabase = argument("lane-db");
const laneLabel = argument("lane-label") ?? "?";

/** Detection is bounded by two heartbeat intervals; the slack absorbs scheduler jitter. */
const DETECTION_BOUND_MS = 2 * livenessIntervalMs + 500;

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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? Number.NaN;
}

function withDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
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
      const heartbeats = diagnostics.filter((event) => event.type === "heartbeat").length;
      trials.push({
        ok: acquired === true,
        detail: `iteration ${iteration} acquired+released (${heartbeats} heartbeat traces)`,
        diagnostics
      });
    } catch (error) {
      trials.push({
        ok: false,
        detail: `iteration ${iteration} failed: ${describe(error)}`,
        diagnostics
      });
    }
  }
  return trials;
}

/**
 * One owner-loss iteration: the lock-session backend is terminated while protected work is in
 * flight. Latency is measured from the kill instant, not from acquisition — the earlier
 * start-anchored measurement conflated the deliberate idle window with detection time.
 */
async function runOwnerLossIteration(
  bootstrapUrl: string,
  admin: pg.Client,
  iteration: number
): Promise<Trial[]> {
  const diagnostics: ClusterDdlLockDiagnosticEvent[] = [];
  let lockPid: number | undefined;

  const ownerRun = withClusterDdlLock(
    bootstrapUrl,
    async (client) => {
      // An idle window while "protected work" is nominally in flight — the bounded owner-loss
      // window the harness kills into, per the checklist's "owner killed during protected work".
      await delay(livenessIntervalMs * 4);
      await client.query("SELECT 1"); // must never observe success past lock-session death
      return "callback-completed-after-kill" as const;
    },
    {
      livenessIntervalMs,
      onDiagnostic: (event) => {
        // The lock-session pid comes from the primitive itself; querying pg_backend_pid() inside
        // the callback would return the DDL session's pid, which is not what holds the lock.
        if (event.type === "acquired") lockPid = event.ownerPid;
        suppressedSink(diagnostics)(event);
      }
    }
  );

  await delay(Math.max(50, livenessIntervalMs));
  if (lockPid === undefined) {
    await ownerRun.catch(() => {});
    return [
      {
        ok: false,
        detail: `iteration ${iteration} FAILED: lock-session pid never reported — kill skipped`,
        diagnostics
      }
    ];
  }
  await admin.query("SELECT pg_terminate_backend($1)", [lockPid]);
  const killedAt = Date.now();

  const trials: Trial[] = [];
  try {
    const outcome = await ownerRun;
    trials.push({
      ok: false,
      detail:
        `iteration ${iteration} FAILED: callback resolved (${JSON.stringify(outcome)}) instead ` +
        "of raising liveness loss",
      diagnostics
    });
  } catch (error) {
    const detectionLatencyMs = Date.now() - killedAt;
    const isLivenessLoss = error instanceof ClusterDdlLockLivenessLostError;
    trials.push({
      ok: isLivenessLoss && detectionLatencyMs <= DETECTION_BOUND_MS,
      detail: isLivenessLoss
        ? `iteration ${iteration} detected via ${error.signal} ${detectionLatencyMs}ms after ` +
          `killing lock pid ${lockPid} (bound ${DETECTION_BOUND_MS}ms)`
        : `iteration ${iteration} FAILED: wrong error type — ` +
          `${error instanceof Error ? error.constructor.name : typeof error}: ${describe(error)}`,
      diagnostics,
      detectionLatencyMs
    });
  }

  const followerDiagnostics: ClusterDdlLockDiagnosticEvent[] = [];
  try {
    await withClusterDdlLock(bootstrapUrl, async (client) => void (await client.query("SELECT 1")), {
      livenessIntervalMs,
      onDiagnostic: suppressedSink(followerDiagnostics)
    });
    trials.push({
      ok: true,
      detail: `iteration ${iteration} follower acquired after lock-session death`,
      diagnostics: followerDiagnostics
    });
  } catch (error) {
    trials.push({
      ok: false,
      detail: `iteration ${iteration} follower-acquisition FAILED: ${describe(error)}`,
      diagnostics: followerDiagnostics
    });
  }

  return trials;
}

async function runOwnerLoss(bootstrapUrl: string): Promise<Trial[]> {
  // The admin connection targets the maintenance database, where the lock session lives.
  const admin = new Client({ connectionString: getClusterLockDatabaseUrl(bootstrapUrl) });
  await admin.connect();
  const trials: Trial[] = [];
  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      trials.push(...(await runOwnerLossIteration(bootstrapUrl, admin, iteration)));
    }
  } finally {
    await admin.end();
  }

  const latencies = trials
    .map((trial) => trial.detectionLatencyMs)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  if (latencies.length > 0) {
    console.log(
      `owner-loss detection latency: p50=${percentile(latencies, 0.5)}ms ` +
        `p99=${percentile(latencies, 0.99)}ms max=${latencies[latencies.length - 1]}ms ` +
        `(documented bound ${DETECTION_BOUND_MS}ms = 2 x ${livenessIntervalMs}ms + jitter)`
    );
  }
  return trials;
}

/**
 * A child lane: loops locked role DDL against one scratch database, printing the wall-clock
 * interval it held the locked section. Role DDL is deliberate — roles are cluster-global shared
 * catalog, so an unserialized pair of lanes on different databases collides there.
 */
async function runCrossDbLane(bootstrapUrl: string, databaseName: string): Promise<void> {
  const laneUrl = withDatabase(bootstrapUrl, databaseName);
  const roleName = `jarvis_ddlproof_${laneLabel}_${process.pid}`;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    try {
      await withClusterDdlLock(
        laneUrl,
        async (client) => {
          const enteredAt = Date.now();
          await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
          await client.query(`CREATE ROLE "${roleName}" NOLOGIN`);
          await client.query(`DROP ROLE "${roleName}"`);
          console.log(`LANE ${laneLabel} ${iteration} ${enteredAt} ${Date.now()}`);
        },
        { livenessIntervalMs }
      );
    } catch (error) {
      console.log(`LANE-ERR ${laneLabel} ${iteration} ${describe(error)}`);
      process.exitCode = 1;
    }
  }
}

interface LaneSection {
  readonly lane: string;
  readonly iteration: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

function spawnLane(
  laneName: string,
  databaseName: string
): Promise<{ readonly sections: LaneSection[]; readonly errors: string[]; readonly code: number }> {
  const selfPath = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      selfPath,
      "--mode=cross-db-lane",
      `--lane-db=${databaseName}`,
      `--lane-label=${laneName}`,
      `--iterations=${iterations}`,
      `--liveness-interval-ms=${livenessIntervalMs}`
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );

  const sections: LaneSection[] = [];
  const errors: string[] = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const section = line.match(/^LANE (\S+) (\d+) (\d+) (\d+)$/);
      if (section) {
        sections.push({
          lane: section[1] ?? laneName,
          iteration: Number(section[2]),
          startedAt: Number(section[3]),
          endedAt: Number(section[4])
        });
      } else if (line.startsWith("LANE-ERR ")) {
        errors.push(line);
      }
    }
  });

  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ sections, errors, code: code ?? 1 }));
  });
}

async function runCrossDb(bootstrapUrl: string): Promise<Trial[]> {
  // Scratch database names are derived from this harness process's own pid — never from
  // JARVIS_PGDATABASE — so a proof run can never create or drop a real database.
  const suffix = `${process.pid}`;
  const databases = [`moss_ddlproof_${suffix}_a`, `moss_ddlproof_${suffix}_b`];
  const admin = new Client({ connectionString: getClusterLockDatabaseUrl(bootstrapUrl) });
  await admin.connect();

  const trials: Trial[] = [];
  try {
    for (const databaseName of databases) {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    }

    const [laneA, laneB] = await Promise.all([
      spawnLane("a", databases[0] ?? ""),
      spawnLane("b", databases[1] ?? "")
    ]);

    const errors = [...laneA.errors, ...laneB.errors];
    trials.push({
      ok: errors.length === 0,
      detail:
        errors.length === 0
          ? `no shared-catalog errors across ${laneA.sections.length + laneB.sections.length} locked sections`
          : `shared-catalog/locking errors: ${errors.join(" | ")}`,
      diagnostics: []
    });

    const overlaps = laneA.sections.filter((a) =>
      laneB.sections.some((b) => a.startedAt < b.endedAt && b.startedAt < a.endedAt)
    );
    trials.push({
      ok: overlaps.length === 0,
      detail:
        overlaps.length === 0
          ? `zero overlap between lanes on ${databases[0]} and ${databases[1]}`
          : `FAILED: ${overlaps.length} locked sections overlapped across databases — the lock is ` +
            "not cluster-global",
      diagnostics: []
    });

    trials.push({
      ok: laneA.code === 0 && laneB.code === 0,
      detail: `lane exit codes a=${laneA.code} b=${laneB.code}`,
      diagnostics: []
    });
  } finally {
    for (const databaseName of databases) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } catch (error) {
        console.log(`  cleanup WARNING: could not drop ${databaseName}: ${describe(error)}`);
      }
    }
    await admin.end();
  }

  return trials;
}

async function main(): Promise<void> {
  const bootstrapUrl = getMossDatabaseUrls().bootstrap;

  if (mode === "cross-db-lane") {
    if (!laneDatabase) throw new Error("--mode=cross-db-lane requires --lane-db=<scratch database>");
    await runCrossDbLane(bootstrapUrl, laneDatabase);
    return;
  }

  let trials: Trial[];
  if (mode === "solo") {
    trials = await runSolo(bootstrapUrl);
  } else if (mode === "owner-loss") {
    trials = await runOwnerLoss(bootstrapUrl);
  } else if (mode === "cross-db") {
    trials = await runCrossDb(bootstrapUrl);
  } else {
    throw new Error(`--mode must be "solo", "owner-loss" or "cross-db", got "${mode}"`);
  }

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
