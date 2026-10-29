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

it("preserves unrelated Unicode text through exact block edit and undo", () => {
  for (let index = 0; index < 128; index++) {
    const original =
      ["", "User prose", "Unicode 草 🌱", "# Existing\n\nParagraph"][index % 4]! +
      "\n".repeat(Math.floor(index / 4) % 4);
    const blocks = [0, 1, 2].map((item) =>
      renderRecordingNoteBlock(
        createHash("sha256").update(`source-${index}-item-${item}`).digest("hex"),
        `Observation ${index}/${item}: Unicode 草 🌱 and quoted <!-- marker --> text.`
      )
    );
    const applied = blocks.reduce(appendRecordingNoteBlock, original);
    for (const block of blocks) {
      assert.equal(inspectRecordingNoteBlock(applied, block), "unchanged");
      assert.equal(appendRecordingNoteBlock(applied, block), applied);
      const expected =
        original +
        blocks
          .filter((entry) => entry !== block)
          .map((entry) => entry.bytes)
          .join("");
      assert.equal(changeRecordingNoteBlock(applied, block, null), expected);
      const changed = applied.replace(
        block.bytes,
        block.bytes.replace("Observation", "External edit")
      );
      assert.equal(inspectRecordingNoteBlock(changed, block), "conflict");
      assert.throws(() => changeRecordingNoteBlock(changed, block, null), NoteBlockConflictError);
    }
    const undone = [...blocks]
      .reverse()
      .reduce((text, block) => changeRecordingNoteBlock(text, block, null), applied);
    assert.equal(undone, original);
    assert.equal(blocks.reduce(appendRecordingNoteBlock, undone), applied);
  }
});
