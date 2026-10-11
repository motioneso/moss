import { assertDataContextDb, isUuid } from "@moss/db";
import {
  approvalChoice,
  approvalNumber,
  approvalText,
  presentApprovalFields,
  type ApprovalFieldMap,
  type ApprovalFieldPresenter,
  type RouteApprovalPresentation
} from "@moss/module-sdk";

const nullable =
  (present: ApprovalFieldPresenter): ApprovalFieldPresenter =>
  (value) =>
    value === null ? "None" : present(value);
const checkinFields: ApprovalFieldMap = {
  feelingCore: {
    label: "Feeling",
    present: approvalChoice({
      happy: "Happy",
      sad: "Sad",
      fear: "Fear",
      anger: "Anger",
      disgust: "Disgust",
      surprise: "Surprise"
    })
  },
  feelingSecondary: { label: "Secondary feeling", present: nullable(approvalText) },
  feelingTertiary: { label: "More specific feeling", present: nullable(approvalText) },
  sensations: {
    label: "Sensations",
    present: (value) =>
      Array.isArray(value) && value.every((item) => typeof item === "string")
        ? value.length
          ? value.map((item, index) => ({ label: `Sensation ${index + 1}`, value: item as string }))
          : "None"
        : null
  },
  intensity: { label: "Intensity", present: nullable(approvalNumber) },
  energy: { label: "Energy", present: nullable(approvalNumber) },
  note: { label: "Note", present: nullable(approvalText) }
};

export function checkinPresentation(update: boolean): RouteApprovalPresentation {
  return async (db, input) => {
    assertDataContextDb(db);
    if (input.query && Object.keys(input.query).length) return null;
    if (Object.keys(input.params).length !== (update ? 1 : 0)) return null;
    const fields = presentApprovalFields(
      input.body,
      update
        ? checkinFields
        : {
            ...checkinFields,
            identifiedVia: {
              label: "Identified using",
              present: approvalChoice({ wheel: "Emotion wheel", assisted: "Assisted check-in" })
            }
          },
      ["feelingCore"]
    );
    if (!fields) return null;
    if (!update) return { content: "user_authored", target: "Your mood check-ins", fields };
    const id = input.params.id;
    if (!id || !isUuid(id)) return null;
    const row = await db.db
      .selectFrom("app.wellness_checkins")
      .select(["id", "checked_in_at", "created_at"])
      .where("id", "=", id)
      .executeTakeFirst();
    return row
      ? {
          target: `Mood check-in from ${row.checked_in_at.toISOString()}`,
          fields,
          version: JSON.stringify(row)
        }
      : null;
  };
}

export const therapyNoteRemovalPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (
    Object.keys(input.params).length !== 1 ||
    !input.params.id ||
    !isUuid(input.params.id) ||
    !input.target ||
    (input.query && Object.keys(input.query).length)
  )
    return null;
  const fields = presentApprovalFields(input.body, {});
  return fields ? { target: input.target, fields, version: input.params.id } : null;
};
