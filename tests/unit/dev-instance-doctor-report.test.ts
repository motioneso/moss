import { describe, expect, it } from "vitest";

import { DOCTOR_CHECKS } from "../../scripts/dev-instance/doctor-checks.js";
import {
  formatDoctorReport,
  type DoctorCheckId,
  type DoctorReport
} from "../../scripts/dev-instance/doctor.js";

const ALL_CHECK_IDS: readonly DoctorCheckId[] = [
  "database-reachable",
  "migrations-current",
  "active-instance-admin",
  "single-instance-default-provider",
  "chat-model-resolves",
  "provider-credential-decrypts",
  "no-uat-fixture-rows",
  "cli-runner-reachable"
];

describe("DOCTOR_CHECKS registry", () => {
  it("has a non-empty constant repair for every check", () => {
    for (const check of DOCTOR_CHECKS) {
      expect(check.repair.length).toBeGreaterThan(0);
    }
  });

  it("registers every DoctorCheckId exactly once", () => {
    const registeredIds = DOCTOR_CHECKS.map((check) => check.id);
    expect(registeredIds.sort()).toEqual([...ALL_CHECK_IDS].sort());
    expect(new Set(registeredIds).size).toBe(registeredIds.length);
  });
});

describe("formatDoctorReport", () => {
  it("renders one line per check, with a repair line for failures and none for passes", () => {
    const report: DoctorReport = {
      ok: false,
      checks: [
        { id: "database-reachable", ok: true, detail: "select 1 succeeded", repair: null },
        {
          id: "migrations-current",
          ok: false,
          detail: "1 migration pending",
          repair: "pnpm db:migrate"
        }
      ]
    };

    const output = formatDoctorReport(report);

    expect(output).toContain("PASS database-reachable: select 1 succeeded");
    expect(output).not.toContain("PASS database-reachable: select 1 succeeded\n  repair:");
    expect(output).toContain("FAIL migrations-current: 1 migration pending");
    expect(output).toContain("repair: pnpm db:migrate");
  });

  it("has ok:false whenever any check fails", () => {
    const report: DoctorReport = {
      ok: false,
      checks: [{ id: "database-reachable", ok: false, detail: "down", repair: "pnpm db:up" }]
    };
    expect(report.ok).toBe(false);
  });
});
