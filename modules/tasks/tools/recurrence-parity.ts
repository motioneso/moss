import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  computeNextOccurrenceDate,
  nextOccurrenceAtOrAfter,
  parseRecurrenceSpec
} from "../../../packages/tasks/src/recurrence.js";

const cases: { spec: unknown; today: string }[] = [];
for (const freq of ["daily", "weekly", "monthly"]) {
  for (const interval of [1, 2, 12]) {
    for (const day of ["2024-01-31", "2024-02-29", "2026-12-31", "2000-02-28"]) {
      cases.push({ spec: { freq, interval, occurrence_date: day }, today: "2027-03-01" });
    }
  }
}
for (const spec of [
  null,
  [],
  {},
  { freq: "daily", interval: 1, occurrence_date: "2026-02-30" },
  { freq: "daily", interval: 1, occurrence_date: "2026-2-03" },
  { freq: "daily", interval: 1, occurrence_date: "２０２６-01-01" },
  { freq: "daily", interval: 0, occurrence_date: "2026-01-01" },
  { freq: "daily", interval: 1.5, occurrence_date: "2026-01-01" },
  { freq: "yearly", interval: 1, occurrence_date: "2026-01-01" }
])
  cases.push({ spec, today: "2026-01-01" });
for (const today of ["2026-01-30", "2026-01-31", "2026-02-01"]) {
  cases.push({ spec: { freq: "monthly", interval: 1, occurrence_date: "2026-01-31" }, today });
}
const reference = cases.map(({ spec, today }) => {
  const parsed = parseRecurrenceSpec(spec);
  return parsed === null
    ? null
    : {
        parsed,
        next: computeNextOccurrenceDate(parsed),
        atOrAfter: nextOccurrenceAtOrAfter(parsed, today)
      };
});
const bin = process.env["JS51_DOMAIN_BIN"];
if (!bin) throw new Error("Build tasks-domain-check and set JS51_DOMAIN_BIN");
const rust = spawnSync(bin, [], { input: JSON.stringify(cases), encoding: "utf8" });
assert.equal(rust.status, 0, rust.stderr);
assert.deepEqual(JSON.parse(rust.stdout), reference);
console.log(`PASS ${cases.length} recurrence cases against the current TypeScript implementation`);
