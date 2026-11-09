// Exercise the package against the unchanged legacy screen, not a second test model.
import assert from "node:assert/strict";
import { deriveTaskFilters as legacy } from "../../../apps/web/src/tasks/task-view-model.ts";
import { filterTasks } from "../ui/model.mjs";

const lists = ["home", "work", "empty"].map((id) => ({ id, name: id }));
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const tasks = Array.from({ length: 96 }, (_, i) => ({
  id: String(i),
  listId: i % 2 ? "home" : "work",
  parentTaskId: i % 11 ? null : "parent",
  title: i % 3 ? "Alpha" : "Other",
  description: i % 4 ? null : "Needle in description",
  status: ["todo", "done", "suggested", "archived"][i % 4],
  priority: i % 6 || null,
  effort: [null, "quick", "medium", "large"][i % 4],
  dueAt: i % 7 ? `${day((i % 13) - 3)}T23:30:00.000Z` : null,
  tags: (i % 3 ? ["red"] : ["red", "blue"]).map((name) => ({ name }))
}));
const empty = {
  text: null,
  status: null,
  effort: null,
  priority: null,
  quadrant: null,
  listIds: [],
  tagNames: [],
  due: null
};
const intents = [
  null,
  empty,
  ...[
    { text: "needle" },
    { status: "done" },
    { effort: "quick" },
    { priority: 4 },
    ...["do", "schedule", "delegate", "eliminate"].map((quadrant) => ({ quadrant })),
    { listIds: ["home"] },
    { listIds: ["work", "home"] },
    { listIds: ["stale"] },
    { tagNames: ["RED", "blue"] },
    { tagNames: ["missing"] },
    ...["none", "overdue", "today", "this_week"].map((kind) => ({ due: { kind } })),
    { due: { kind: "range", dueAfter: day(-1), dueBefore: day(2) } },
    { due: { kind: "range", dueAfter: null, dueBefore: day(0) } },
    { due: { kind: "range", dueAfter: day(0), dueBefore: null } },
    { priority: 4, listIds: ["home"], tagNames: ["red"], due: { kind: "this_week" } }
  ].map((part) => ({ ...empty, ...part }))
];
const before = structuredClone(tasks);
let checks = 0;
for (const searchIntent of intents)
  for (const status of ["all", "todo", "done", "suggested", "archived"])
    for (const listStates of [{}, { home: "solo" }, { work: "excluded" }])
      for (const tagFilter of [[], ["red", "blue"]])
        for (const search of ["", "missing literal query"]) {
          const input = {
            tasks,
            lists,
            statusFilter: status,
            focus: null,
            listStates,
            tagFilter,
            search,
            searchIntent,
            timeZone: "UTC"
          };
          assert.deepEqual(
            filterTasks(tasks, { lists, status, listStates, tagFilter, search, searchIntent }),
            legacy(input),
            JSON.stringify(input.searchIntent)
          );
          checks++;
        }
assert.deepEqual(tasks, before);
console.log(
  `PASS ${checks} exact legacy interpreted-filter comparisons (UTC); source rows unchanged`
);
