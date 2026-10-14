import { expect, it } from "vitest";
import { readerSchedule } from "../uat/briefing-reader-schedule.js";

it.each([
  ["2026-10-13T06:59:45Z", "23:58"],
  ["2026-10-13T07:00:15Z", "00:00"],
  ["2026-10-13T08:00:00Z", "00:59"]
])("keeps the evening reader eligible at %s", (now, targetTime) => {
  expect(readerSchedule(new Date(now))).toEqual({
    targetTime,
    timezone: "America/Los_Angeles"
  });
});
