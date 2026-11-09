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
