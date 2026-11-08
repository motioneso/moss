/** Rebuild actual legacy-domain results; no database or server is opened. */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  renderRecordingNoteBlock as render,
  inspectRecordingNoteBlock as inspect,
  appendRecordingNoteBlock as append,
  changeRecordingNoteBlock as change
} from "../../../packages/notes/src/recording-note-blocks.js";
import { removeRecordingContributionBlocks as cleanup } from "../../../packages/notes/src/recording-note-cleanup-blocks.js";
import { reconcileRecordingNoteOperation as reconcile } from "../../../packages/notes/src/recording-note-operation.js";
import {
  recordingNoteBlockId as blockId,
  recordingFallbackReference as fallback
} from "../../../packages/notes/src/recording-note-identity.js";
import { managedNoteSnapshotKey as snapshotKey } from "../../../packages/notes/src/managed-note-snapshot-key.js";

import { noteDestinationId as destinationId } from "../../../packages/notes/src/contribution-destinations.js";

const vectors: unknown[] = [];
function record(op: string, input: unknown, run: () => unknown) {
  let expected: unknown;
  try {
    expected = { ok: run() };
  } catch (error) {
    expected = { error: (error as Error).message };
  }
  vectors.push({ op, input, expected });
}
for (const path of ["/notes/Contacts/a.md", "/notes/Contacts/b.md", "/notes/日記/😀.md"]) {
  record("destination", { path }, () => destinationId(path));
}
const id = "a".repeat(64);
const before = render(id, "Saved thought");
const after = render(id, "Updated thought");
for (const text of [
  "Hello",
  "\uFEFF",
  "\u0085",
  "  ",
  "<!-- marker -->",
  "😀 café\r\nline",
  "x".repeat(16384),
  "é".repeat(8193),
  "<!--".repeat(2500)
]) {
  record("render", { id, text }, () => render(id, text));
}
for (const invalid of ["", "A".repeat(64), "z".repeat(64), "a".repeat(63)]) {
  record("render", { id: invalid, text: "hello" }, () => render(invalid, "hello"));
}
for (const note of [
  "",
  "User prose",
  "prefix" + before.bytes + "suffix",
  before.bytes + before.bytes,
  before.bytes.replace("Saved", "User edit"),
  before.bytes.replace(":end", ":gone"),
  after.bytes
]) {
  record("inspect", { note, block: before }, () => inspect(note, before));
  record("append", { note, block: before }, () => append(note, before));
  record("change", { note, before, after }, () => change(note, before, after));
  record("change", { note, before, after: null }, () => change(note, before, null));
  record("cleanup", { note, variants: [before, after] }, () => cleanup(note, [before, after]));
  for (const pending of [
    { before: null, after },
    { before, after },
    { before, after: null },
    { before: null, after: null }
  ]) {
    record("reconcile", { note, ...pending }, () => reconcile(note, pending));
  }
}
record("cleanup", { note: "", variants: [] }, () => cleanup("", []));
const foreign = render("b".repeat(64), "other");
record("change", { note: before.bytes, before, after: foreign }, () =>
  change(before.bytes, before, foreign)
);
record("cleanup", { note: before.bytes, variants: [before, foreign] }, () =>
  cleanup(before.bytes, [before, foreign])
);
const owner = "00000000-0000-4000-8000-00000000000A";
const source = {
  sourceModuleId: "meetings" as const,
  sourceId: "00000000-0000-4000-8000-00000000000B",
  sourceVersion: 3,
  itemKey: "thought_1"
};
for (const item of [
  source,
  { ...source, sourceVersion: 1 },
  { ...source, sourceVersion: 0 },
  { ...source, sourceVersion: 2147483648 },
  { ...source, sourceId: "bad" },
  { ...source, sourceModuleId: "other" as "meetings" },
  { ...source, itemKey: "bad/key" }
]) {
  record("block_id", { owner, source: item }, () => blockId(owner, item));
  for (const side of ["personal", "work"] as const)
    record("fallback", { source: item, side }, () => fallback(item, side));
}
record("block_id", { owner: "bad", source }, () => blockId("bad", source));
record("fallback", { source, side: "invalid" }, () => fallback(source, "invalid" as "personal"));
const entry = {
  source: { ownerUserId: owner, sourceModuleId: "meetings", sourceId: source.sourceId },
  generation: 2
};
const snapshot = {
  destinationId: "b".repeat(64),
  contentHash: "c".repeat(64),
  bindingRevision: 1,
  side: "personal" as const,
  lifecycle: { ownerUserId: owner, actorGeneration: 0, sources: [entry] }
};
for (const input of [
  snapshot,
  { ...snapshot, side: "invalid" as "personal" },
  { ...snapshot, destinationId: "bad" },
  { ...snapshot, contentHash: "A".repeat(64) },
  { ...snapshot, lifecycle: { ...snapshot.lifecycle, ownerUserId: "bad" } },
  { ...snapshot, lifecycle: { ...snapshot.lifecycle, actorGeneration: -1 } },
  { ...snapshot, lifecycle: { ...snapshot.lifecycle, sources: [{ ...entry, generation: -1 }] } },
  {
    ...snapshot,
    lifecycle: {
      ...snapshot.lifecycle,
      sources: [{ ...entry, source: { ...entry.source, sourceId: "bad" } }]
    }
  },
  {
    ...snapshot,
    lifecycle: {
      ...snapshot.lifecycle,
      sources: [{ ...entry, source: { ...entry.source, sourceModuleId: "Bad" } }]
    }
  },
  { ...snapshot, lifecycle: { ...snapshot.lifecycle, sources: [entry, entry] } },
  {
    ...snapshot,
    lifecycle: { ...snapshot.lifecycle, sources: [entry, { ...entry, generation: 3 }] }
  },
  { ...snapshot, bindingRevision: -1 },
  {
    ...snapshot,
    lifecycle: {
      ...snapshot.lifecycle,
      sources: [{ ...entry, source: { ...entry.source, ownerUserId: source.sourceId } }]
    }
  }
]) {
  record("snapshot", input, () => snapshotKey(input));
}
writeFileSync(
  fileURLToPath(new URL("../src/tests/domain-vectors.jsonl", import.meta.url)),
  vectors.map((vector) => JSON.stringify(vector)).join("\n") + "\n"
);
console.log(`Recorded ${vectors.length} results from the existing TypeScript Notes functions`);
