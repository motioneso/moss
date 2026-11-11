/** Compares grant resolution and connection health with the old code on generated cases. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dataContextBrand } from "@moss/db";
import { resolveEffectiveGrants } from "../../../packages/connectors/src/feature-grants.js";
import { readConnectionDiagnostics } from "../../../packages/connectors/src/connection-diagnostics.js";

const binary = process.env.CONNECTORS_ORACLE;
assert(binary, "Build the connectors oracle first");

const scopeSets = [
  [],
  ["https://www.googleapis.com/auth/gmail.modify"],
  ["https://www.googleapis.com/auth/gmail.readonly"],
  ["https://mail.google.com/"],
  ["gmail"],
  ["gmail.readonly"],
  ["email.read"],
  ["https://www.googleapis.com/auth/calendar"],
  ["https://www.googleapis.com/auth/calendar.readonly"],
  ["calendar"],
  ["calendar.readonly"],
  ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar"],
  ["unrelated"]
];
const stores = [
  null,
  [],
  "x",
  5,
  {},
  { email: true },
  { email: false },
  { calendar: true },
  { calendar: false },
  { email: true, calendar: true },
  { email: false, calendar: false },
  { email: "true", calendar: 1 }
];
const grantCases = scopeSets.flatMap((scopes) =>
  stores.map((stored) => ({ op: "grants", scopes, stored }))
);

const T = (n: number) => `2026-02-0${n}T10:00:00.000Z`;
type Row = Record<string, unknown>;
const base = {
  id: "acct",
  providerId: "google",
  status: "active",
  revokedAt: null,
  lastSyncStartedAt: T(1),
  lastSyncFinishedAt: T(2),
  lastSyncStatus: null,
  errorLabel: null,
  previousStatus: null,
  previousFinishedAt: null
};
const rows: Row[] = [
  base,
  { ...base, lastSyncStatus: "success" },
  { ...base, lastSyncStatus: "partial", previousStatus: "success", previousFinishedAt: T(3) },
  { ...base, lastSyncStatus: "partial", previousStatus: "failed", previousFinishedAt: T(3) },
  { ...base, lastSyncStatus: "failed", errorLabel: "auth-error" },
  { ...base, lastSyncStatus: "failed" },
  { ...base, lastSyncStatus: "failed", previousStatus: "success", previousFinishedAt: T(4) },
  { ...base, status: "error" },
  { ...base, status: "error", errorLabel: "network-error", lastSyncStatus: "success" },
  { ...base, lastSyncStartedAt: null },
  { ...base, lastSyncStartedAt: null, lastSyncFinishedAt: null, lastSyncStatus: "success" },
  { ...base, status: "revoked", revokedAt: T(5) },
  { ...base, status: "active", revokedAt: T(5) },
  { ...base, id: "x".repeat(200), providerId: "p".repeat(200) }
];
const outlookRow = { ...base, providerId: "outlook-browser-calendar" };
const outlookStates: unknown[] = [
  undefined,
  "bad",
  [],
  { state: "nonsense" },
  { state: "collecting" },
  { state: "current", lastCompleteAt: T(2), attemptedAt: T(3) },
  { state: "current" },
  { state: "partial" },
  { state: "partial", failures: 2, attemptedAt: T(3) },
  { state: "stale", lastCompleteAt: T(1), failures: 1 },
  { state: "sign-in-needed" },
  { state: "source-changed" },
  { state: "settings-not-found" },
  { state: "disconnected", attemptedAt: "not a date" },
  { state: "current", attemptedAt: "2026-02-03T10:00:00+02:00" }
];
const healthCases: unknown[] = [];
for (const limit of [1, 2, 3, 50, 0, -4])
  healthCases.push({ op: "health", rows, outlook: {}, limit });
for (const state of outlookStates)
  for (const status of ["active", "error"])
    healthCases.push({
      op: "health",
      rows: [{ ...outlookRow, id: "o", status }],
      outlook: state === undefined ? {} : { o: state },
      limit: 5
    });

const toOld = (r: Row) => ({
  id: r.id,
  provider_id: r.providerId,
  status: r.status,
  revoked_at: r.revokedAt ? new Date(r.revokedAt as string) : null,
  last_sync_started_at: r.lastSyncStartedAt ? new Date(r.lastSyncStartedAt as string) : null,
  last_sync_finished_at: r.lastSyncFinishedAt ? new Date(r.lastSyncFinishedAt as string) : null,
  last_sync_status: r.lastSyncStatus,
  error_label: r.errorLabel,
  previous_status: r.previousStatus,
  previous_finished_at: r.previousFinishedAt
});

const expected: unknown[] = grantCases.map((c) => resolveEffectiveGrants(c.scopes, c.stored));
const scoped = { db: {}, [dataContextBrand]: true } as never;
for (const c of healthCases as { rows: Row[]; outlook: Record<string, unknown>; limit: number }[]) {
  const limit = Math.max(1, Math.min(10, Math.floor(c.limit)));
  expected.push(
    await readConnectionDiagnostics(
      scoped,
      { limit: c.limit },
      {
        repository: {
          listDiagnosticAccounts: async (_db, n) => c.rows.slice(0, n).map(toOld)
        } as never,
        preferences: {
          get: async (_db: unknown, key: string) => c.outlook[key.split(".")[1]]
        } as never
      }
    )
  );
  void limit;
}
const result = spawnSync(binary, {
  input: JSON.stringify([...grantCases, ...healthCases]),
  encoding: "utf8"
});
assert.equal(result.status, 0, result.stderr);
const actual: unknown[] = JSON.parse(result.stdout);
assert.equal(actual.length, expected.length);
const all = [...grantCases, ...healthCases];
for (const [i, value] of actual.entries())
  assert.deepEqual(value, JSON.parse(JSON.stringify(expected[i])), JSON.stringify(all[i]));
console.log(`PASS ${actual.length} grant and health comparisons against the old code`);
