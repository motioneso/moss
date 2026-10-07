import {
  approvalText,
  presentApprovalFields,
  type RouteApprovalPresentation
} from "@moss/module-sdk";
import { parseDeleteRange } from "./deletion-range.js";

export const backtrackDeletionPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (Object.keys(input.params).length || (input.query && Object.keys(input.query).length))
    return null;
  const range = parseDeleteRange(input.body);
  if (range.kind === "invalid") return null;
  if (range.kind === "everything")
    return {
      content: "user_authored",
      target: "All your stored Backtrack history",
      fields: [
        { label: "Time range", value: "Everything stored up to the time this action runs" },
        {
          label: "Effect",
          value:
            "Permanently delete this screen history and its searchable copies. This cannot be undone."
        }
      ]
    };
  const fields = presentApprovalFields(
    input.body,
    {
      from: { label: "From", present: approvalText },
      to: { label: "To", present: approvalText }
    },
    ["from", "to"]
  );
  return fields
    ? {
        content: "user_authored",
        target: "Your Backtrack history in this time range",
        fields: [
          ...fields,
          {
            label: "Effect",
            value:
              "Permanently delete this screen history and its searchable copies, up to the earlier of the selected end or the time this action runs. This cannot be undone."
          }
        ]
      }
    : null;
};
