import {
  approvalBoolean,
  approvalText,
  presentApprovalFields,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";

export const scratchpadAppendPresentation: ToolApprovalPresentation = async (_db, input) => {
  const fields = presentApprovalFields(
    input,
    {
      text: { label: "Text to append", present: approvalText }
    },
    ["text"]
  );
  return fields ? { content: "user_authored", target: "Your scratchpad", fields } : null;
};

export const scratchpadAppendRoutePresentation: RouteApprovalPresentation = async (
  db,
  input,
  ctx
) => {
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) return null;
  return scratchpadAppendPresentation(db, input.body as Record<string, unknown>, ctx);
};

export const scratchpadSettingsPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  const fields = presentApprovalFields(input.body, {
    syncToNotes: {
      label: "Copy scratchpad to your connected notes folder",
      present: approvalBoolean
    },
    shortcut: { label: "Keyboard shortcut", present: approvalText }
  });
  return fields ? { content: "user_authored", target: "Your scratchpad settings", fields } : null;
};
