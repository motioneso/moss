import { assertDataContextDb } from "@moss/db";
import {
  approvalChoice,
  presentApprovalFields,
  type ToolApprovalPresentation
} from "@moss/module-sdk";
import { resolveOwnedDefinition } from "./tools.js";

export const briefingRerunPresentation: ToolApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  if (Object.keys(input).length !== 1) return null;
  if (!Object.hasOwn(input, "definitionId") && !Object.hasOwn(input, "briefingType")) return null;
  const definition = await resolveOwnedDefinition(db, input, ctx.actorUserId);
  if (!definition || definition.owner_user_id !== ctx.actorUserId) return null;
  const fields = presentApprovalFields(input, {
    definitionId: {
      label: "Briefing",
      present: (value) => (value === definition.id ? definition.title : null)
    },
    briefingType: {
      label: "Briefing type",
      present: approvalChoice({
        morning: "Morning",
        evening: "Evening",
        weekly_review: "Weekly review"
      })
    }
  });
  return fields
    ? {
        target: definition.title,
        fields,
        version: JSON.stringify([
          definition.id,
          definition.updated_at,
          definition.selected_tool_names
        ])
      }
    : null;
};
