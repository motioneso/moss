// Exercise the unchanged legacy screen model with a fixed clock, including local
// midnight and DST boundaries. These are screen filters, not the drift API rules.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { deriveTaskFilters as legacy } from "../../../apps/web/src/tasks/task-view-model.ts";
import { filterTasks } from "../ui/model.mjs";

let checks = 0;
for (const now of ["2026-11-09T01:30:00Z", "2026-03-08T10:30:00Z", "2026-11-01T09:30:00Z"]) {
  mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  try {
    const lists = ["home", "work", "empty"].map((id) => ({ id, name: id }));
    const tasks = [];
    for (const status of ["todo", "done", "suggested", "archived"])
      for (const priority of [null, 1, 3, 4, 5])
        for (const offset of [null, -72, -24, -1, 0, 24, 47, 48, 49, 72]) {
          const date =
            offset === null ? null : new Date(Date.now() + offset * 3600000).toISOString();
          tasks.push({
            id: String(tasks.length),
            listId: tasks.length % 2 ? "home" : "work",
            parentTaskId: tasks.length % 7 === 0 ? "parent" : null,
            title: tasks.length % 3 ? "Alpha" : "Other",
            description: null,
            status,
            priority,
            dueAt: date,
            completedAt: date,
            tags: [{ name: tasks.length % 3 ? "red" : "blue" }]
          });
        }
    const snapshot = structuredClone(tasks);
    for (const timeZone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"])
      for (const focus of ["priorities", "atrisk", "donetoday"])
        for (const status of ["all", "todo", "done", "suggested", "archived"])
          for (const listStates of [{}, { home: "solo" }, { work: "excluded" }])
            for (const tagFilter of [[], ["red"], ["red", "blue"]])
              for (const search of ["", "alpha", "missing"]) {
                const filters = { lists, focus, status, listStates, tagFilter, search, timeZone };
                assert.deepEqual(
                  filterTasks(tasks, filters),
                  legacy({
                    tasks,
                    ...filters,
                    statusFilter: status
                  }),
                  JSON.stringify({ now, ...filters })
                );
                checks++;
              }
    assert.deepEqual(tasks, snapshot);
  } finally {
    mock.timers.reset();
  }
}
console.log(
  `PASS ${checks} exact legacy focus comparisons across account days and DST; source rows unchanged`
);
