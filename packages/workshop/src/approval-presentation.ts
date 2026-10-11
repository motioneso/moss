import { isUuid } from "@moss/db";
import {
  approvalText,
  presentApprovalFields,
  type RouteApprovalPresentation,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import { workshopProjectTarget } from "./chat-targets.js";

export const workshopCreatePresentation: ToolApprovalPresentation = async (_db, input) => {
  // This is an explicitly declared retry token, not a user-selected resource or hidden write.
  // The gateway freezes it; it is included in the server-only identity on every recheck.
  const fields = presentApprovalFields(
    input,
    {
      description: { label: "Project request", present: approvalText },
      requestKey: {
        label: "Retry handling",
        present: (value) =>
          typeof value === "string" && isUuid(value) ? "Save this request only once" : null
      }
    },
    ["description", "requestKey"]
  );
  return fields
    ? {
        content: "user_authored",
        target: "Your private Workshop projects",
        fields,
        version: String(input.requestKey)
      }
    : null;
};

export function workshopProjectPresentation(remove: boolean): RouteApprovalPresentation {
  return async (db, input) => {
    if (Object.keys(input.params).length !== 1 || (input.query && Object.keys(input.query).length))
      return null;
    const fields = presentApprovalFields(
      input.body,
      remove ? {} : { title: { label: "New project name", present: approvalText } },
      remove ? [] : ["title"]
    );
    if (!fields) return null;
    const target = await workshopProjectTarget(db, input.params);
    if (!target) return null;
    return {
      target: typeof target === "string" ? target : target.label,
      fields,
      version: JSON.stringify([input.params.projectId, target])
    };
  };
}
