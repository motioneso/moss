import { test } from "node:test";
import assert from "node:assert/strict";
import { padModel } from "./model.mjs";
import { format, continueList, shortcutMatches } from "./editor.mjs";
const note = (body = "", revision = 0) => ({ body, revision, shortcut: "mod+shift+s" });
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

test("a late save never loses newer typing and writes in revision order", async () => {
  const pending = deferred();
  const calls = [];
  const model = padModel({
    read: async () => note(),
    save: async (body, revision) => {
      calls.push([body, revision]);
      if (calls.length === 1) return pending.promise;
      return { revision: 2 };
    }
  });
  await model.read();
  model.edit("first");
  const saving = model.save();
  model.edit("second");
  pending.resolve({ revision: 1 });
  await saving;
  assert.deepEqual(calls, [
    ["first", 0],
    ["second", 1]
  ]);
  assert.equal(model.state.status, "Saved");
  assert.equal(model.state.text, "second");
  model.dispose();
});
test("conflict freezes writes, keeps draft and Reload reads fresh stored text", async () => {
  let saves = 0;
  let current = note("before", 1);
  const model = padModel({
    read: async () => current,
    save: async () => {
      saves++;
      throw { status: 409, body: note("elsewhere", 2) };
    }
  });
  await model.read();
  model.edit("my draft");
  await model.save();
  model.edit("my draft continued");
  await model.save();
  assert.equal(saves, 1);
  assert.equal(model.state.text, "my draft continued");
  assert.equal(model.state.conflict, true);
  current = note("latest", 3);
  await model.reload();
  assert.equal(model.state.text, "latest");
  assert.equal(model.state.revision, 3);
  assert.equal(model.state.conflict, false);
  model.dispose();
});
test("failed writes preserve draft and can be retried", async () => {
  let fail = true;
  const model = padModel({
    read: async () => note(),
    save: async () => {
      if (fail) throw { status: 503 };
      return { revision: 1 };
    }
  });
  await model.read();
  model.edit("kept");
  await model.save();
  assert.equal(model.state.status, "Not saved");
  assert.equal(model.state.text, "kept");
  fail = false;
  await model.save();
  assert.equal(model.state.status, "Saved");
  assert.equal(model.state.saved, "kept");
  model.dispose();
});
test("clean external append refreshes, but an external edit cannot replace a dirty draft", async () => {
  let current = note("first", 1);
  const model = padModel({ read: async () => current });
  await model.read();
  current = note("first\nadded", 2);
  await model.read();
  assert.equal(model.state.notice, "Added to your scratchpad");
  model.edit("local");
  current = note("remote", 3);
  await model.read();
  assert.equal(model.state.text, "local");
  assert.equal(model.state.conflict, true);
  model.dispose();
});
test("a read started before a successful save cannot roll its revision back", async () => {
  const pending = deferred();
  let calls = 0;
  const model = padModel({
    read: () => (++calls === 1 ? Promise.resolve(note("a", 1)) : pending.promise),
    save: async () => ({ revision: 2 })
  });
  await model.read();
  const refresh = model.read();
  model.edit("b");
  await model.save();
  pending.resolve(note("a", 1));
  await refresh;
  assert.equal(model.state.text, "b");
  assert.equal(model.state.revision, 2);
  assert.equal(model.state.conflict, false);
  model.dispose();
});
test("initial read failure keeps the editor unavailable, then retries", async () => {
  let fail = true;
  const model = padModel({
    read: async () => {
      if (fail) throw Error();
      return note();
    }
  });
  await model.read();
  model.edit("should not enter");
  assert.equal(model.state.text, "");
  assert.equal(model.state.loaded, false);
  fail = false;
  await model.read();
  assert.equal(model.state.loaded, true);
  model.dispose();
});
test("a successful unchanged refresh clears a transient read error", async () => {
  let fail = false;
  const model = padModel({
    read: async () => {
      if (fail) throw Error();
      return note("saved", 1);
    }
  });
  await model.read();
  fail = true;
  await model.read();
  assert.match(model.state.error, /check for changes/);
  fail = false;
  await model.read();
  assert.equal(model.state.error, "");
  assert.equal(model.state.text, "saved");
  assert.equal(model.state.status, "Saved");
  model.dispose();
});
test("a changed draft during Reload is preserved", async () => {
  const pending = deferred();
  let calls = 0;
  const model = padModel({
    read: () => (++calls === 1 ? Promise.resolve(note("a", 1)) : pending.promise)
  });
  await model.read();
  const reload = model.reload();
  model.edit("new typing");
  pending.resolve(note("remote", 2));
  await reload;
  assert.equal(model.state.text, "new typing");
  model.dispose();
});
test("size limit counts UTF-16 and refuses oversized drafts without sending them", async () => {
  let sent = false;
  const model = padModel({
    read: async () => note(),
    save: async () => {
      sent = true;
    }
  });
  await model.read();
  model.edit("😀".repeat(32001));
  await model.save();
  assert.equal(sent, false);
  assert.equal(model.state.status, "Not saved");
  model.dispose();
});
test("list continuation resets checkboxes, increments numbers and ends empty items", () => {
  assert.equal(continueList("- [x] done", 10, 10).text, "- [x] done\n- [ ] ");
  assert.equal(continueList("2. hello", 8, 8).text, "2. hello\n3. ");
  assert.equal(continueList("- ", 2, 2).text, "");
  assert.equal(continueList("plain", 5, 5), null);
});
test("formatting handles selected lines and wraps inline selections", () => {
  assert.equal(format("one\ntwo", 0, 7, "checkbox").text, "- [ ] one\n- [ ] two");
  assert.equal(format("two", 0, 3, "bold").text, "**two**");
  assert.equal(format("  one\n  two", 0, 11, "outdent").text, "one\ntwo");
});
test("stored shortcuts require the exact modifier combination", () => {
  const event = { key: "S", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
  assert.equal(shortcutMatches(event, "mod+shift+s"), true);
  assert.equal(shortcutMatches(event, "mod+s"), false);
});
