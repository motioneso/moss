// Compare draft cleaning with the unchanged legacy task editor.
import assert from "node:assert/strict";
import { normalizeTagName, cleanSubtasks } from "../ui/capture.mjs";
import {
  normalizeTagName as legacyTag,
  cleanSubtasks as legacySubtasks
} from "../../../apps/web/src/tasks/task-details-model.ts";
const values = [
  "",
  " ",
  " # ",
  "#Tag",
  "  #MiXeD  ",
  "##double",
  "café",
  "工作",
  "\ufeff spaced\u00a0",
  "one\ntwo"
];
for (const value of values) assert.equal(normalizeTagName(value), legacyTag(value));
for (let offset = 0; offset < values.length; offset++) {
  const steps = [...values.slice(offset), "same", "same"];
  const original = [...steps];
  assert.deepEqual(cleanSubtasks(steps), legacySubtasks(steps));
  assert.deepEqual(steps, original);
}
console.log(
  "PASS 20 exact legacy new-task draft comparisons (tags, subtasks, Unicode and unchanged inputs)"
);

// Extract the existing editor's suggestion expression unchanged as the oracle.
const { readFileSync } = await import("node:fs");
const { runInNewContext } = await import("node:vm");
const { tagSuggestions } = await import("../ui/task-tags.mjs");
const legacySource = readFileSync("apps/web/src/tasks/task-details-dialog.tsx", "utf8");
const expression = legacySource.match(/const tagSuggestions = ([\s\S]*?);/)[1];
let checks = 0;
for (const names of [
  [],
  ["WORK", "home", "#literal", "工作"],
  Array.from({ length: 12 }, (_, i) => `tag${i}`)
]) {
  const available = names.map((name, i) => ({ id: String(i), name }));
  for (const selected of [
    [],
    ["work"],
    ["home", "#literal"],
    names.map((name) => name.toLowerCase())
  ]) {
    for (const isNew of [true, false]) {
      const expected = runInNewContext(`JSON.stringify(${expression})`, {
        listTagsQuery: { data: { tags: available } },
        isNew,
        newTags: selected,
        assignedNames: new Set(selected.map((name) => name.toLowerCase()))
      });
      assert.deepEqual(tagSuggestions(available, selected), JSON.parse(expected));
      checks++;
    }
  }
}
console.log(
  `PASS ${checks} exact legacy tag suggestion comparisons (new and existing task selections)`
);

// Keep the package date conversion tied to the unchanged application helpers.
const { localDay } = await import("../../../packages/shared/src/time.ts");
const { fromDateInputValue } = await import("../../../apps/web/src/tasks/task-format.ts");
const { localDay: packageDay, localNoon } = await import("../ui/local-date.mjs");
let dateChecks = 0;
for (const zone of [
  "UTC",
  "America/Los_Angeles",
  "Pacific/Kiritimati",
  "Asia/Kathmandu",
  "Australia/Lord_Howe"
])
  for (const day of [
    "2026-03-07",
    "2026-03-08",
    "2026-03-09",
    "2026-11-01",
    "2026-10-04",
    "2026-11-09",
    "2024-02-29",
    "2026-12-31"
  ]) {
    const instant = fromDateInputValue(day, zone);
    assert.equal(localNoon(day, zone), instant);
    for (const offset of [-43200000, 0, 43200000]) {
      const nearby = new Date(Date.parse(instant) + offset).toISOString();
      assert.equal(packageDay(nearby, zone), localDay(nearby, zone));
      dateChecks++;
    }
    assert.equal(packageDay(instant, zone), day);
    dateChecks += 2;
  }
console.log(
  `PASS ${dateChecks} exact legacy saved-zone date comparisons (DST, fractional offsets, UTC+14 and year/leap boundaries)`
);
