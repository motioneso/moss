import assert from "node:assert/strict";
import {
  recordingNoteBlockId,
  recordingFallbackReference,
  type RecordingNoteSource
} from "../../packages/notes/src/recording-note-identity.js";

import { it } from "vitest";

it("keys note blocks by owner, source version and item while separating fallback sides", () => {
  const owner = "ABCDEFAB-1234-4000-8000-123456789012";
  const source: RecordingNoteSource = {
    sourceModuleId: "meetings",
    sourceId: "12345678-1234-4000-8000-123456789012",
    sourceVersion: 1,
    itemKey: "note-1"
  };
  const id = recordingNoteBlockId(owner, source);
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(
    recordingNoteBlockId(owner.toLowerCase(), {
      ...source,
      sourceId: source.sourceId.toUpperCase()
    }),
    id
  );
  for (const variant of [
    { ...source, sourceVersion: 2 },
    { ...source, itemKey: "note-2" },
    { ...source, sourceId: "22345678-1234-4000-8000-123456789012" }
  ])
    assert.notEqual(recordingNoteBlockId(owner, variant), id);
  assert.notEqual(recordingNoteBlockId(source.sourceId, source), id);
  assert.equal(
    recordingFallbackReference(source, "personal"),
    `notes/recordings/personal/${source.sourceId}/v1.md`
  );
  assert.notEqual(
    recordingFallbackReference(source, "personal"),
    recordingFallbackReference(source, "work")
  );

  for (const sourceVersion of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => recordingNoteBlockId(owner, { ...source, sourceVersion }));
  }
  for (const itemKey of [
    "",
    "../outside",
    "/absolute",
    "key\u0000tail",
    "a".repeat(81),
    "x/y",
    "key\n"
  ]) {
    assert.throws(() => recordingNoteBlockId(owner, { ...source, itemKey }));
  }
  assert.throws(() => recordingNoteBlockId("not-an-owner", source));
  assert.throws(() => recordingNoteBlockId(owner, { ...source, sourceId: "not-a-source" }));
  assert.throws(() =>
    // @ts-expect-error Deliberately invalid module at the runtime boundary.
    recordingNoteBlockId(owner, { ...source, sourceModuleId: "other" })
  );
  // @ts-expect-error Deliberately invalid side at the runtime boundary.
  assert.throws(() => recordingFallbackReference(source, "other"));
});
