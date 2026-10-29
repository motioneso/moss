import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  renderRecordingNoteBlock,
  NoteBlockConflictError
} from "../../packages/notes/src/recording-note-blocks.js";
import { reconcileRecordingNoteOperation } from "../../packages/notes/src/recording-note-operation.js";

import { it } from "vitest";

it("recovers pending publication without recreating applied or undone contributions", () => {
  const id = createHash("sha256").update("durable source receipt").digest("hex");
  const before = renderRecordingNoteBlock(id, "Earlier source observation");
  const after = renderRecordingNoteBlock(id, "Accepted source replacement");

  for (const original of ["", "User text", "# Heading\n\nOriginal body\n"]) {
    const applied = reconcileRecordingNoteOperation(original, { before: null, after: before });
    assert.equal(applied.content, original + before.bytes);
    assert.equal(applied.status, "changed");
    const appended = applied.content + "\nLater user edit";
    assert.deepEqual(reconcileRecordingNoteOperation(appended, { before: null, after: before }), {
      content: appended,
      status: "already_published"
    });
    const replaced = reconcileRecordingNoteOperation(appended, { before, after });
    assert.equal(replaced.content, original + after.bytes + "\nLater user edit");
    assert.equal(replaced.status, "changed");
    const later = "User prepended\n" + replaced.content;
    assert.deepEqual(reconcileRecordingNoteOperation(later, { before, after }), {
      content: later,
      status: "already_published"
    });
    const undone = reconcileRecordingNoteOperation(later, { before: after, after: null });
    assert.equal(undone.content, "User prepended\n" + original + "\nLater user edit");
    assert.equal(undone.status, "changed");
    assert.deepEqual(
      reconcileRecordingNoteOperation(undone.content, { before: after, after: null }),
      {
        content: undone.content,
        status: "already_published"
      }
    );
  }
  for (const note of [
    before.bytes.replace("Earlier", "User corrected"),
    before.bytes + before.bytes,
    before.bytes + after.bytes,
    before.bytes.replace(":end -->", ":damaged -->")
  ]) {
    for (const pending of [
      { before, after },
      { before, after: null },
      { before: null, after: before }
    ]) {
      assert.throws(() => reconcileRecordingNoteOperation(note, pending), NoteBlockConflictError);
    }
  }
  assert.throws(() => reconcileRecordingNoteOperation("", { before: null, after: null }));
  assert.throws(() =>
    reconcileRecordingNoteOperation(before.bytes, {
      before,
      after: { ...after, id: "f".repeat(64) }
    })
  );
  assert.throws(
    () => reconcileRecordingNoteOperation("User removed block", { before, after }),
    NoteBlockConflictError
  );
});
