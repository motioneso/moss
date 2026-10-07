import { assertDataContextDb } from "@moss/db";
import {
  approvalBoolean,
  approvalText,
  presentApprovalFields,
  type ApprovalFieldMap,
  type ToolApprovalPresentation
} from "@moss/module-sdk";

import { resolveNoteApprovalTarget } from "./write-tools.js";

function notePresentation(
  declarations: ApprovalFieldMap,
  required: readonly string[],
  allowNew: boolean
): ToolApprovalPresentation {
  return async (db, input) => {
    assertDataContextDb(db);
    const { path, ...changes } = input;
    const fields = presentApprovalFields(changes, declarations, required);
    if (!fields || typeof path !== "string") return null;
    const target = await resolveNoteApprovalTarget(db, path, allowNew);
    const segments = target.relative.split("/");
    const name = segments.pop()!;
    return {
      ...(allowNew ? { title: changes.overwrite === true ? "Overwrite note" : "Create note" } : {}),
      target: name,
      // Each component stays exact, even if a folder name itself contains a breadcrumb glyph.
      fields: [
        ...segments.map((value, index) => ({ label: `Folder ${index + 1}`, value })),
        ...fields
      ],
      version: target.version
    };
  };
}

export const notesCreatePresentation = notePresentation(
  {
    content: { label: "Content", present: approvalText },
    overwrite: { label: "Replace existing content", present: approvalBoolean }
  },
  ["content"],
  true
);

export const notesEditPresentation = notePresentation(
  {
    oldText: { label: "Replace", present: approvalText },
    newText: { label: "With", present: approvalText }
  },
  ["oldText", "newText"],
  false
);

export const notesDeletePresentation = notePresentation({}, [], false);
