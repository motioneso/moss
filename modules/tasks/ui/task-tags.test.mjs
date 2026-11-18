import assert from "node:assert/strict";
import test from "node:test";
import { findOrCreateTag, tagSuggestions } from "./task-tags.mjs";

test("suggestions exclude selected names without mutating order or stored hashes", () => {
  const available = ["WORK", "#literal", ...Array.from({ length: 10 }, (_, i) => `tag${i}`)].map(
    (name, i) => ({ id: String(i), name })
  );
  const before = structuredClone(available);
  assert.deepEqual(tagSuggestions(available, ["work"]), available.slice(1, 9));
  assert.deepEqual(available, before);
});

test("typed names reuse a case-insensitive list tag before attempting creation", async () => {
  const calls = [];
  const existing = { id: "existing", name: "Work" };
  const tag = await findOrCreateTag(
    async (...args) => {
      calls.push(args);
      return { tags: [existing] };
    },
    "list",
    "work"
  );
  assert.equal(tag, existing);
  assert.deepEqual(calls, [["GET", "/tasks/lists/list/tags"]]);
});

test("a failed create rechecks concurrent tags, but a real failure is kept", async () => {
  for (const concurrent of [true, false]) {
    let reads = 0;
    const failure = new Error("creation rejected");
    const api = async (method) => {
      if (method === "POST") throw failure;
      return { tags: ++reads > 1 && concurrent ? [{ id: "won", name: "WORK" }] : [] };
    };
    if (concurrent) assert.equal((await findOrCreateTag(api, "list", "work")).id, "won");
    else await assert.rejects(findOrCreateTag(api, "list", "work"), (error) => error === failure);
    assert.equal(reads, 2);
  }
});

test("a failed conflict recheck preserves the original creation error", async () => {
  let reads = 0;
  const original = new Error("create rejected");
  await assert.rejects(
    findOrCreateTag(
      async (method) => {
        if (method === "POST") throw original;
        if (++reads > 1) throw new Error("recheck unavailable");
        return { tags: [] };
      },
      "list",
      "work"
    ),
    (error) => error === original
  );
});
