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
      // A real relative folder path keeps names recognizable without exposing the host root.
      fields: [
        ...(segments.length ? [{ label: "Folder", value: segments.join("/") }] : []),
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

const deleteNoteTarget = notePresentation({}, [], false);
export const notesDeletePresentation: ToolApprovalPresentation = async (
  db,
  input,
  ctx,
  services
) => {
  const details = await deleteNoteTarget(db, input, ctx, services);
  return details
    ? {
        ...details,
        approvalKind: "note_delete",
        fields: [
          ...details.fields,
          { label: "Deletion", value: "Permanently delete this note. There is no trash or undo." }
        ]
      }
    : null;
};
