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
