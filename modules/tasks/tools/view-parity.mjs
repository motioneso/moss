// Compare package display groups with the unchanged legacy screen contracts.
import assert from "node:assert/strict";
import { groupByPriority, QUADRANTS } from "../../../packages/shared/src/tasks-view.ts";
import { groupTasksByQuadrant } from "../../../apps/web/src/tasks/task-view-model.ts";
import { taskGroups } from "../ui/model.mjs";

const now = Date.parse("2026-11-08T12:00:00.000Z");
const realNow = Date.now;
Date.now = () => now;
try {
  const tasks = [];
  for (const priority of [null, 1, 2, 3, 4, 5]) {
    for (const dueAt of [
      null,
      "2026-11-07T00:00:00.000Z",
      "2026-11-10T12:00:00.000Z",
      "2026-11-10T12:00:00.001Z"
    ]) {
      for (const title of ["Zulu", "Alpha", "éclair", "alpha"]) {
        tasks.push({
          id: String(tasks.length),
          priority,
          dueAt,
          title,
          listId: tasks.length % 2 ? "work" : "home"
        });
      }
    }
  }
  const snapshot = structuredClone(tasks);
  let checks = 0;
  for (const input of [
    [],
    tasks,
    [...tasks].reverse(),
    tasks.filter((t) => t.priority === 4),
    tasks.filter((t) => t.dueAt === null)
  ]) {
    assert.deepEqual(
      taskGroups(input, "priority"),
      groupByPriority(input)
        .filter((g) => g.tasks.length)
        .map((g) => ({ key: g.value, title: g.label, subtitle: "", tasks: g.tasks }))
    );
    const matrix = groupTasksByQuadrant(input);
    assert.deepEqual(
      taskGroups(input, "matrix"),
      QUADRANTS.map((q) => ({
        key: q.key,
        title: q.title,
        subtitle: q.subtitle,
        tasks: matrix[q.key]
      }))
    );
    checks += 2;
  }
  assert.deepEqual(tasks, snapshot, "Grouping must not mutate saved task order or content");
  console.log(
    `PASS ${checks} exact legacy view comparisons over ${tasks.length} synthetic tasks; source rows unchanged`
  );
} finally {
  Date.now = realNow;
}
