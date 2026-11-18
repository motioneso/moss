import assert from "node:assert/strict";
import test from "node:test";
import { CATEGORIES, exportRangeDays, addDays, defaultRange } from "./export.mjs";
import { noteDate } from "./notes.mjs";

test("export range counts days inclusively and rejects bad or backwards ranges", () => {
  assert.equal(exportRangeDays("2026-11-17", "2026-11-17"), 1);
  assert.equal(exportRangeDays("2026-01-01", "2026-12-31"), 365);
  assert.equal(exportRangeDays("2024-01-01", "2024-12-31"), 366);
  assert.equal(exportRangeDays("2026-11-18", "2026-11-17"), null);
  assert.equal(exportRangeDays("2026-02-30", "2026-03-01"), null);
  assert.equal(exportRangeDays("", "2026-03-01"), null);
});

test("the default range is the 90 days up to today and crosses month ends", () => {
  assert.deepEqual(defaultRange("2026-11-17"), { from: "2026-08-19", to: "2026-11-17" });
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2024-03-01", -1), "2024-02-29");
});

test("only categories the Rust export route accepts are offered", () => {
  assert.deepEqual(CATEGORIES.map(([key]) => key), ["checkins", "therapyNotes"]);
});

test("note dates fall back to Today and survive a bad timezone", () => {
  assert.equal(noteDate(null), "Today");
  assert.equal(noteDate("nonsense"), "Today");
  assert.match(noteDate("2026-11-17T10:00:00Z", { locale: "en-US", timezone: "UTC" }), /Nov 17/);
  assert.match(noteDate("2026-11-17T10:00:00Z", { locale: "en-US", timezone: "Not/AZone" }), /Nov/);
});
