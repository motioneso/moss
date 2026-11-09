/* global document */
import assert from "node:assert/strict";
import test from "node:test";
import { newTaskSave, normalizeTagName, cleanSubtasks } from "./capture.mjs";

test("new task retries resume acknowledged work after a child failure", async () => {
  const calls = [];
  let fail = true;
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/tasks") return { task: { id: "parent", listId: "list" } };
    if (path.endsWith("/breakdown")) return { tasks: [] };
    if (path === "/tasks/lists/list/tags") return { tag: { id: `tag-${body.name}` } };
    if (path === "/tasks/parent/tags" && body.tagId === "tag-second" && fail) {
      fail = false;
      throw new Error("assignment failed");
    }
    return { task: { id: "parent", listId: "list" } };
  };
  const save = newTaskSave(api);
  const draft = { steps: [" first ", "", "second"], tags: ["#FIRST", "second", "first"] };
  await assert.rejects(save.save({ title: "Parent", listId: "list" }, draft));
  assert.equal(save.started(), true);
  const result = await save.save({ title: "Edited parent", listId: "list" }, draft);
  assert.equal(result.task.id, "parent");
  assert.equal(calls.filter((c) => c.path === "/tasks").length, 1);
  assert.equal(calls.filter((c) => c.path.endsWith("/breakdown")).length, 1);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/breakdown")).body.steps, [
    "first",
    "second"
  ]);
  assert.equal(
    calls.filter((c) => c.path === "/tasks/parent/tags" && c.body.tagId === "tag-first").length,
    1
  );
  assert.equal(calls.filter((c) => c.path === "/tasks/lists/list/tags").length, 2);
  assert(calls.some((c) => c.method === "PATCH" && c.body.title === "Edited parent"));
});

test("a failed parent creation can be retried, and reset starts a separate task", async () => {
  let attempts = 0;
  const save = newTaskSave(async () => {
    if (++attempts === 1) throw new Error("creation refused");
    return { task: { id: String(attempts), listId: "list" } };
  });
  await assert.rejects(save.save({}, { steps: [], tags: [] }));
  assert.equal(save.started(), false);
  assert.equal((await save.save({}, { steps: [], tags: [] })).task.id, "2");
  save.reset();
  assert.equal(save.started(), false);
  assert.equal((await save.save({}, { steps: [], tags: [] })).task.id, "3");
});

test("draft cleaning keeps legacy tag and subtask rules", () => {
  assert.equal(normalizeTagName("  #MiXeD  "), "mixed");
  assert.equal(normalizeTagName(" # "), "");
  assert.deepEqual(cleanSubtasks([" first ", "", "\t", "same", "same"]), ["first", "same", "same"]);
});

test("a rejected breakdown resumes before tags without another parent", async () => {
  let parents = 0;
  let breakdowns = 0;
  let tagWrites = 0;
  const save = newTaskSave(async (_method, path) => {
    if (path === "/tasks") {
      parents++;
      return { task: { id: "p", listId: "l" } };
    }
    if (path.endsWith("/breakdown") && ++breakdowns === 1) throw new Error("breakdown refused");
    if (path.endsWith("/tags")) {
      tagWrites++;
      return { tag: { id: "tag" } };
    }
    return { task: { id: "p", listId: "l" } };
  });
  await assert.rejects(save.save({}, { steps: ["Step"], tags: ["tag"] }));
  assert.equal(tagWrites, 0);
  await save.save({}, { steps: ["Ignored changed draft"], tags: [] });
  assert.equal(parents, 1);
  assert.equal(breakdowns, 2);
  assert.equal(tagWrites, 2);
});

test("draft controls retain edits, remove items, defer writes and lock a partial save", async () => {
  const { JSDOM } = await import("jsdom");
  const { captureDraft } = await import("./capture.mjs");
  const dom = new JSDOM(`<select id="task-list"><option>list</option></select>
    <section id="new-task-extras"><p id="capture-progress" hidden></p>
      <div id="new-subtasks"></div><span id="add-new-subtask"><button>Add</button></span>
      <div id="new-tags"></div><input id="new-tag-name"><span id="add-new-tag"><button>Add</button></span>
    </section>`);
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const $ = (id) => document.getElementById(id);
    const text = (tag, value) => {
      const node = document.createElement(tag);
      node.textContent = value;
      return node;
    };
    const button = (label, action) => {
      const node = text("button", label);
      node.addEventListener("click", action);
      return node;
    };
    const calls = [];
    let fail = true;
    const draft = captureDraft({
      text,
      button,
      run: (action) => action(),
      focus: (node) => node.focus(),
      api: async (method, path, body) => {
        calls.push({ method, path, body });
        if (path === "/tasks") return { task: { id: "p", listId: "list" } };
        if (path.endsWith("/breakdown") && fail) {
          fail = false;
          throw new Error("refused");
        }
        if (path === "/tasks/lists/list/tags") return { tag: { id: "tag" } };
        return { task: { id: "p", listId: "list" } };
      }
    });
    draft.reset();
    $("add-new-subtask").querySelector("button").click();
    let input = $("new-subtasks").querySelector("input");
    input.value = " First step ";
    input.dispatchEvent(new dom.window.Event("input"));
    $("add-new-subtask").querySelector("button").click();
    $("new-subtasks").lastElementChild.querySelector("button").click();
    assert.equal($("new-subtasks").querySelector("input").value, " First step ");
    assert.equal(document.activeElement, $("add-new-subtask").querySelector("button"));
    $("new-tag-name").value = "#Home";
    $("new-tag-name").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    assert.equal($("new-tags").textContent, "Remove #home");
    $("new-tags").querySelector("button").click();
    assert.equal($("new-tags").textContent, "");
    assert.equal(document.activeElement, $("new-tag-name"));
    $("new-tag-name").value = "#Kept"; // Save also includes an uncommitted tag.
    assert.equal(calls.length, 0);
    await assert.rejects(draft.save({ title: "Parent", listId: "list" }));
    assert.equal($("task-list").disabled, true);
    assert.equal($("capture-progress").hidden, false);
    assert(
      [...$("new-task-extras").querySelectorAll("input, button")].every((node) => node.disabled)
    );
    await draft.save({ title: "Parent", listId: "list" });
    assert.deepEqual(calls.find((c) => c.path.endsWith("/breakdown")).body.steps, ["First step"]);
    assert.equal(calls.find((c) => c.path === "/tasks/lists/list/tags").body.name, "kept");
    draft.reset();
    assert.equal($("task-list").disabled, false);
    assert.equal($("new-subtasks").children.length, 0);
    assert.equal($("new-tags").children.length, 0);
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
});
