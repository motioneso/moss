import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendRecordingNoteBlock,
  changeRecordingNoteBlock,
  inspectRecordingNoteBlock,
  NoteBlockConflictError,
  renderRecordingNoteBlock
} from "../../packages/notes/src/recording-note-blocks.js";

import { it } from "vitest";

it("escapes managed blocks and rejects changed, missing or duplicate markers", () => {
  const id = createHash("sha256").update("synthetic source item").digest("hex");
  const block = renderRecordingNoteBlock(id, "A durable recording observation.");

  for (const original of [
    "",
    "Existing user prose",
    "Existing user prose\n",
    "# Heading\n\nBody\n"
  ]) {
    const applied = appendRecordingNoteBlock(original, block);
    assert.equal(inspectRecordingNoteBlock(applied, block), "unchanged");
    assert.equal(appendRecordingNoteBlock(applied, block), applied);
    assert.equal(changeRecordingNoteBlock(applied, block, null), original);
    const withLaterEdit = "User prepended\n" + applied + "\nUser appended";
    const undone = changeRecordingNoteBlock(withLaterEdit, block, null);
    assert.equal(undone, "User prepended\n" + original + "\nUser appended");
    const changed = renderRecordingNoteBlock(id, "Accepted replacement observation.");
    assert.equal(changeRecordingNoteBlock(applied, block, changed), original + changed.bytes);
  }
  for (const corrupted of [
    block.bytes + block.bytes,
    block.bytes.replace("durable", "externally changed"),
    block.bytes.replace(":end -->", ":invalid -->"),
    block.bytes.replace(":begin -->", ":end -->"),
    block.bytes.slice(1)
  ]) {
    assert.equal(inspectRecordingNoteBlock(corrupted, block), "conflict");
    assert.throws(() => appendRecordingNoteBlock(corrupted, block), NoteBlockConflictError);
    assert.throws(() => changeRecordingNoteBlock(corrupted, block, null), NoteBlockConflictError);
  }
  assert.throws(
    () => changeRecordingNoteBlock("externally removed", block, null),
    NoteBlockConflictError
  );
  const malicious = renderRecordingNoteBlock(id, `Mention ${block.bytes} as quoted evidence.`);
  assert.equal(malicious.bytes.split(`<!-- moss-recording:v1:${id}:`).length - 1, 2);
  assert.equal(inspectRecordingNoteBlock(malicious.bytes, malicious), "unchanged");
  assert.throws(() => renderRecordingNoteBlock(id, "界".repeat(5462)));
  assert.throws(() => renderRecordingNoteBlock(id, "<!--".repeat(4096)));
  assert.throws(() => renderRecordingNoteBlock(id, "  \n"));
  assert.throws(() => renderRecordingNoteBlock("not-an-id", "text"));
  assert.throws(
    () => renderRecordingNoteBlock(id, "unpaired \ud800 surrogate"),
    /well-formed Unicode/
  );
  assert.throws(
    () => renderRecordingNoteBlock(id, "unpaired \udc00 surrogate"),
    /well-formed Unicode/
  );
  assert.equal(
    changeRecordingNoteBlock("Before" + block.bytes + "After", block, null),
    "Before\nAfter"
  );
});
