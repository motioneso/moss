// Compare list/tag navigation with the unchanged legacy screen model.
import assert from "node:assert/strict";
import { deriveTaskFilters as legacy } from "../../../apps/web/src/tasks/task-view-model.ts";
import { filterTasks, visibleTasks } from "../ui/model.mjs";

const lists = ["home", "work", "empty"].map((id) => ({ id, name: id }));
const tasks = Array.from({ length: 48 }, (_, i) => ({
  id: String(i),
  listId: i % 2 ? "home" : "work",
  parentTaskId: i % 7 === 0 ? "parent" : null,
  title: i % 3 ? "Alpha" : "Other",
  description: i % 4 ? null : "Needle in description",
  status: ["todo", "done", "suggested", "archived"][i % 4],
  tags: (i % 3 ? ["red"] : ["red", "blue"]).map((name) => ({ name }))
}));
const snapshot = structuredClone(tasks);
let checks = 0;
for (const status of ["all", "todo", "done", "suggested", "archived"])
  for (const listStates of [
    {},
    { home: "solo" },
    { home: "excluded" },
    { home: "solo", work: "solo" },
    { home: "solo", work: "excluded" },
    { home: "excluded", work: "excluded" },
    { empty: "solo" },
    { stale: "solo" }
  ])
    for (const tagFilter of [[], ["red"], ["blue"], ["red", "blue"], ["missing"]])
      for (const search of ["", "ALPHA", "needle", "missing"]) {
        const input = {
          tasks,
          lists,
          statusFilter: status,
          focus: null,
          listStates,
          tagFilter,
          search
        };
        const filters = { lists, status, listStates, tagFilter, search };
        assert.deepEqual(filterTasks(tasks, filters), legacy(input));
        assert.deepEqual(
          visibleTasks(tasks, filters),
          legacy(input).visibleTasks,
          JSON.stringify({ status, listStates, tagFilter, search })
        );
        checks++;
      }
assert.deepEqual(tasks, snapshot);
console.log(
  `PASS ${checks} exact legacy list/tag/search filter comparisons; source rows unchanged`
);
