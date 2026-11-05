import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  DIAGNOSTIC_LOG_PURGE_CRON,
  DIAGNOSTIC_LOG_PURGE_QUEUE,
  reconcileDiagnosticLogPurgeSchedule
} from "@moss/settings";
import { LOG_COMPONENTS, LOG_CONNECTION_KINDS, LOG_EVENT_CODES } from "@moss/shared";

describe("diagnostic log purge schedule", () => {
  it("schedules hourly with a metadata-only payload", async () => {
    const schedule = vi.fn(async () => undefined);
    await reconcileDiagnosticLogPurgeSchedule({ schedule } as never);
    expect(schedule).toHaveBeenCalledWith(
      DIAGNOSTIC_LOG_PURGE_QUEUE,
      DIAGNOSTIC_LOG_PURGE_CRON,
      { kind: "diagnostics.log_purge" },
      expect.objectContaining({ tz: "UTC" })
    );
    expect(DIAGNOSTIC_LOG_PURGE_CRON).toBe("43 * * * *");
  });
});

describe("log label lists", () => {
  const migration = readFileSync("packages/settings/sql/0357_diagnostic_log_records.sql", "utf8");
  const listFor = (column: string): string[] => {
    const match = new RegExp(`${column}\\s+IN \\(([^)]*)\\)`).exec(migration);
    return (match?.[1] ?? "").split(",").map((v) => v.trim().replace(/'/g, ""));
  };

  it("match the table constraints exactly", () => {
    expect(listFor("component")).toEqual([...LOG_COMPONENTS]);
    expect(listFor("connection_kind")).toEqual([...LOG_CONNECTION_KINDS]);
    expect(listFor("event_code")).toEqual([...LOG_EVENT_CODES]);
  });
});
