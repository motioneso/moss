import assert from "node:assert/strict";
import test from "node:test";
import { taskFields, visibleTasks, quadrant } from "./model.mjs";

test("editing a title preserves saved instants, suggested state and exceptional recurrence", () => {
  const previous = {
    status: "suggested",
    dueAt: "2026-11-08T23:15:34.123Z",
    doAt: "2026-11-07T22:01:00.000Z",
    recurrence: { freq: "weekly", interval: 3, occurrence_date: "2026-11-01", byweekday: [1, 4] }
  };
  const fields = taskFields(
    {
      title: "Edited",
      description: "",
      listId: "list",
      status: "suggested",
      dueAt: "2026-11-08",
      doAt: "2026-11-07",
      priority: "",
      effort: "",
      repeat: "weekly"
    },
    previous
  );
  assert.equal(fields.title, "Edited");
  for (const name of ["dueAt", "doAt", "status", "recurrence"])
    assert(!Object.hasOwn(fields, name));
});
test("clearing a saved date and repeat sends explicit nulls", () => {
  const fields = taskFields(
    {
      title: "Task",
      description: "",
      listId: "list",
      status: "todo",
      dueAt: "",
      doAt: "",
      priority: "4",
      effort: "quick",
      repeat: "never"
    },
    {
      status: "todo",
      dueAt: "2026-11-08T22:00:00.000Z",
      doAt: null,
      recurrence: { freq: "daily" }
    }
  );
  assert.equal(fields.dueAt, null);
  assert.equal(fields.recurrence, null);
  assert.equal(fields.priority, 4);
  assert(!Object.hasOwn(fields, "doAt"));
});
test("filters omit subtasks and match tags and description without reading HTML", () => {
  const parent = {
    id: "parent",
    parentTaskId: null,
    title: "<script>Task</script>",
    description: "Find me",
    listId: "a",
    status: "todo",
    tags: [{ name: "home" }]
  };
  const child = { ...parent, id: "child", parentTaskId: "parent" };
  assert.deepEqual(visibleTasks([parent, child], { search: "find", tag: "home", listId: "a" }), [
    parent
  ]);
  assert.deepEqual(visibleTasks([parent, child], { listId: "foreign" }), []);
});
test("priority three stays outside important quadrants and urgency includes its boundary", () => {
  const now = Date.parse("2026-11-08T00:00:00Z");
  assert.equal(quadrant({ priority: 3, dueAt: "2026-11-10T00:00:00Z" }, now), "delegate");
  assert.equal(quadrant({ priority: 4, dueAt: "2026-11-10T00:00:00.001Z" }, now), "schedule");
});
