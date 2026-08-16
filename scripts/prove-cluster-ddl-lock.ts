// #1632 liveness proof harness, extended by #1013 with error attribution.
//
// DB-touching. #1632's implementation review cleared and merged (389e96488), which released the
// proof gate this file used to carry; it is now runnable. It still creates nothing outside
// pid-derived scratch databases, and it never reads `JARVIS_PGDATABASE` to pick what to drop.
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
// #1013 adds attribution to `--mode=cross-db`. "Zero errors" is only evidence if you can say who
// was on the cluster when an error happened: on a shared box another agent's gate is a real
// possibility, and an unattributed error is indistinguishable from a lock defect. An observer
// samples `pg_stat_activity` throughout the run — UNFILTERED, because filtering to our own
// `application_name` is exactly what makes an outside writer invisible — and classifies each
// backend as `participant` (labelled `moss-ddlproof:<lane>`) or `external`. Every lane error is
// then attributed to the backends captured around its instant. An error nothing was captured for
// is `unattributable` and fails the run on its own, per #1013's acceptance criterion.
//
//   --external-writer-demo      Negative control for that classifier (`--mode=cross-db` only).
//                               Runs an UNLOCKED writer looping role DDL alongside the lanes and
//                               requires that it actually be captured and classified `external`.
//                               Without it, "no external writers were seen" could just as well
//                               mean the observer sees nothing at all, and the attribution above
//                               would be decoration. Under this flag a lane error attributed to
//                               that writer is the expected result rather than a failure.
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
const externalWriterDemo = process.argv.includes("--external-writer-demo");

/** Detection is bounded by two heartbeat intervals; the slack absorbs scheduler jitter. */
const DETECTION_BOUND_MS = 2 * livenessIntervalMs + 500;

/** Lanes label themselves so the observer can classify without filtering anything out. */
const PARTICIPANT_APPLICATION_PREFIX = "moss-ddlproof:";
/** Deliberately not a prefix of the above, so the demo writer cannot pass itself off as a lane. */
const EXTERNAL_APPLICATION_PREFIX = "moss-ddlproof-external:";
const SAMPLE_INTERVAL_MS = 25;
/** How far from an error's instant a sample may sit and still describe the cluster at that moment. */
const ATTRIBUTION_WINDOW_MS = 250;

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

function withDatabase(
  connectionString: string,
  databaseName: string,
  applicationName?: string
): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  // Set on the URL rather than with `SET application_name` inside the callback, so the primitive's
  // LOCK session inherits it too — that session lives on the maintenance database and would
  // otherwise be captured as an unknown external backend.
  if (applicationName) url.searchParams.set("application_name", applicationName);
  return url.toString();
}

interface BackendSnapshot {
  readonly capturedAtMs: number;
  readonly backendPid: number;
  readonly database: string | null;
  readonly applicationName: string;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly classification: "participant" | "external";
}

/**
 * One unfiltered sweep of the cluster's backends.
 *
 * Two deliberate omissions. There is no `application_name LIKE 'moss-ddlproof:%'` predicate: the
 * whole point is to see writers that are NOT ours, and a filter would report an empty cluster right
 * when an outside writer is the explanation. There is no `datname` predicate either — the lanes sit
 * on two scratch databases and the lock sessions on a third, so a single-database view could not
 * cover one run, let alone a second worktree's.
 *
 * `query` is not selected. Other backends on a shared cluster belong to other people's sessions and
 * their statement text can carry private content; pid, database, application name and wait state
 * are enough to attribute a collision.
 */
async function captureBackendSnapshot(observer: pg.Client): Promise<BackendSnapshot[]> {
  const capturedAtMs = Date.now();
  const { rows } = await observer.query<{
    pid: number;
    datname: string | null;
    application_name: string | null;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
  }>(
    `SELECT pid, datname, application_name, state, wait_event_type, wait_event
       FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
      ORDER BY application_name, pid
      LIMIT 64`
  );
  return rows.map((row) => {
    const applicationName = row.application_name ?? "";
    return {
      capturedAtMs,
      backendPid: row.pid,
      database: row.datname,
      applicationName,
      state: row.state,
      waitEventType: row.wait_event_type,
      waitEvent: row.wait_event,
      classification: applicationName.startsWith(PARTICIPANT_APPLICATION_PREFIX)
        ? "participant"
        : "external"
    };
  });
}

/** Sample the cluster for as long as `running` is in flight, then hand back its result. */
async function sampleBackendsDuringRun<T>(
  observer: pg.Client,
  samples: BackendSnapshot[],
  running: Promise<T>
): Promise<T> {
  let sampling = true;
  const sweep = (async () => {
    while (sampling) {
      try {
        samples.push(...(await captureBackendSnapshot(observer)));
      } catch (error) {
        // A failed sweep costs attribution coverage, never the run — a lane error with no samples
        // around it is reported as unattributable, which is a failure in its own right.
        console.log(`  observer WARNING: sweep failed: ${describe(error)}`);
      }
      await delay(SAMPLE_INTERVAL_MS);
    }
  })();
  try {
    return await running;
  } finally {
    sampling = false;
    await sweep;
  }
}

/** The backends captured around an instant — the evidence for who a collision belongs to. */
function attributionFor(samples: BackendSnapshot[], atMs: number): BackendSnapshot[] {
  return samples.filter((row) => Math.abs(row.capturedAtMs - atMs) <= ATTRIBUTION_WINDOW_MS);
}

function verdictFor(
  attribution: readonly BackendSnapshot[]
): "unattributable" | "participant-only" | "external-present" {
  if (attribution.length === 0) return "unattributable";
  return attribution.some((row) => row.classification === "external")
    ? "external-present"
    : "participant-only";
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
    await withClusterDdlLock(
      bootstrapUrl,
      async (client) => void (await client.query("SELECT 1")),
      {
        livenessIntervalMs,
        onDiagnostic: suppressedSink(followerDiagnostics)
      }
    );
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
  const laneUrl = withDatabase(
    bootstrapUrl,
    databaseName,
    `${PARTICIPANT_APPLICATION_PREFIX}${laneLabel}`
  );
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
      // The instant and the SQLSTATE are what the parent attributes against; the message is
      // collapsed to one line because the parent reads this stream line by line.
      const code = (error as { code?: string }).code ?? "-";
      const message = describe(error).replace(/\s+/g, " ");
      console.log(`LANE-ERR ${laneLabel} ${iteration} ${Date.now()} ${code} ${message}`);
      process.exitCode = 1;
    }
  }
}

/**
 * An unlocked writer racing the lanes on the same cluster-global catalog: the negative control for
 * the observer's classifier. It holds no lock on purpose — its collisions are the thing the lock
 * cannot prevent and the attribution must therefore be able to name.
 */
function startExternalWriter(
  bootstrapUrl: string,
  databaseName: string
): { readonly stop: () => void; readonly finished: Promise<void> } {
  let running = true;
  const finished = (async () => {
    const roleName = `jarvis_ddlproof_external_${process.pid}`;
    const client = new Client({
      connectionString: withDatabase(
        bootstrapUrl,
        databaseName,
        `${EXTERNAL_APPLICATION_PREFIX}${databaseName}`
      )
    });
    await client.connect();
    try {
      while (running) {
        try {
          await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
          await client.query(`CREATE ROLE "${roleName}" NOLOGIN`);
        } catch (error) {
          // Expected: it is unserialized by design. Reported, never fatal.
          console.log(`  external writer error (holds no lock): ${describe(error)}`);
        }
        await delay(5);
      }
    } finally {
      try {
        await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
      } catch (error) {
        console.log(`  cleanup WARNING: could not drop ${roleName}: ${describe(error)}`);
      }
      await client.end();
    }
  })();
  return { stop: () => void (running = false), finished };
}

interface LaneSection {
  readonly lane: string;
  readonly iteration: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

interface LaneError {
  readonly lane: string;
  readonly iteration: number;
  readonly atMs: number;
  readonly code: string;
  readonly message: string;
}

function spawnLane(
  laneName: string,
  databaseName: string
): Promise<{
  readonly sections: LaneSection[];
  readonly errors: LaneError[];
  readonly code: number;
}> {
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
  const errors: LaneError[] = [];
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
        continue;
      }
      const failure = line.match(/^LANE-ERR (\S+) (\d+) (\d+) (\S+) (.*)$/);
      if (failure) {
        errors.push({
          lane: failure[1] ?? laneName,
          iteration: Number(failure[2]),
          atMs: Number(failure[3]),
          code: failure[4] ?? "-",
          message: failure[5] ?? ""
        });
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
  // The observer sits on the maintenance database, but pg_stat_activity is a cluster-wide view, so
  // one connection sees every lane, every lock session, and anything else running on the box.
  const observer = new Client({ connectionString: getClusterLockDatabaseUrl(bootstrapUrl) });
  await observer.connect();
  const samples: BackendSnapshot[] = [];

  const trials: Trial[] = [];
  try {
    for (const databaseName of databases) {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    }

    const external = externalWriterDemo
      ? startExternalWriter(bootstrapUrl, databases[0] ?? "")
      : undefined;
    let laneA: Awaited<ReturnType<typeof spawnLane>>;
    let laneB: Awaited<ReturnType<typeof spawnLane>>;
    try {
      [laneA, laneB] = await sampleBackendsDuringRun(
        observer,
        samples,
        Promise.all([spawnLane("a", databases[0] ?? ""), spawnLane("b", databases[1] ?? "")])
      );
    } finally {
      external?.stop();
      await external?.finished;
    }

    const errors = [...laneA.errors, ...laneB.errors];
    const attributed = errors.map((error) => {
      const attribution = attributionFor(samples, error.atMs);
      return { error, attribution, verdict: verdictFor(attribution) };
    });
    const describeError = (entry: (typeof attributed)[number]): string =>
      `lane ${entry.error.lane} iteration ${entry.error.iteration} [${entry.error.code}] ` +
      `${entry.verdict} across ${entry.attribution.length} captured backends: ${entry.error.message}`;

    // #1013's acceptance criterion, on its own line: an error nobody was captured for cannot be
    // ruled a lock defect OR ruled out as one, so it fails the run regardless of what caused it.
    const unattributable = attributed.filter((entry) => entry.verdict === "unattributable");
    trials.push({
      ok: unattributable.length === 0,
      detail:
        unattributable.length === 0
          ? `zero unattributable errors (${errors.length} lane errors, ${samples.length} backend ` +
            `samples, ${new Set(samples.map((row) => row.backendPid)).size} distinct backends)`
          : `FAILED: ${unattributable.length} unattributable lane errors — ` +
            unattributable.map(describeError).join(" | "),
      diagnostics: []
    });

    // Under the demo an error attributed to the unlocked writer is the point of the exercise; a
    // participant-only error still means the lock failed to exclude our own lanes.
    const unexplained = attributed.filter(
      (entry) => !(externalWriterDemo && entry.verdict === "external-present")
    );
    trials.push({
      ok: unexplained.length === 0,
      detail:
        unexplained.length === 0
          ? externalWriterDemo
            ? `all ${errors.length} lane errors attributed to the unlocked external writer across ` +
              `${laneA.sections.length + laneB.sections.length} locked sections`
            : `no shared-catalog errors across ${laneA.sections.length + laneB.sections.length} locked sections`
          : `shared-catalog/locking errors: ${unexplained.map(describeError).join(" | ")}`,
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
      // A demo lane exits non-zero precisely because the external writer collided with it, which
      // the trial above has already accounted for; judging it twice would report one event as two.
      ok: externalWriterDemo ? unexplained.length === 0 : laneA.code === 0 && laneB.code === 0,
      detail: `lane exit codes a=${laneA.code} b=${laneB.code}`,
      diagnostics: []
    });

    if (externalWriterDemo) {
      const captured = samples.filter((row) =>
        row.applicationName.startsWith(EXTERNAL_APPLICATION_PREFIX)
      );
      trials.push({
        ok: captured.length > 0 && captured.every((row) => row.classification === "external"),
        detail:
          captured.length === 0
            ? "FAILED: external writer was not captured — the observer is blind, so every " +
              "attribution above proves nothing"
            : `external writer captured in ${captured.length} samples, ` +
              `${captured.filter((row) => row.classification === "external").length} classified external`,
        diagnostics: []
      });
    }
  } finally {
    await observer.end();
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

  // Silently ignoring the flag would report a plain cross-db run as a negative control that ran,
  // which is the exact false green the negative control exists to rule out.
  if (externalWriterDemo && mode !== "cross-db") {
    throw new Error(`--external-writer-demo requires --mode=cross-db, got "${mode}"`);
  }

  if (mode === "cross-db-lane") {
    if (!laneDatabase)
      throw new Error("--mode=cross-db-lane requires --lane-db=<scratch database>");
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
