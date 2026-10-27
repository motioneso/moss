import { createHash } from "node:crypto";
import { assertDataContextDb } from "@moss/db";
import type { ApprovalField, RouteApprovalPresentation } from "@moss/module-sdk";
import type { RecordingType } from "@moss/shared";
import { RecordingTypesRepository } from "./recording-types.js";
import {
  validateRecordingTypeConfiguration,
  prepareRecordingTypeConfiguration
} from "./recording-type-config.js";
import { RecordingIdentityError } from "./recording-identity-error.js";
import { getMeetingOutputTemplate } from "./output-validation.js";

function details(type: RecordingType | undefined): string {
  return type
    ? `Name: ${type.name}\nDescription: ${type.description}\nSummary style: ${getMeetingOutputTemplate(type.templateId, 1)!.name}\nStatus: ${type.retired ? "Retired" : "Active"}`
    : "Not present";
}
export const recordingTypeConfigurationPresentation: RouteApprovalPresentation = async (
  db,
  input
) => {
  assertDataContextDb(db);
  if (Object.keys(input.params).length || Object.keys(input.query ?? {}).length) return null;
  try {
    const proposed = validateRecordingTypeConfiguration(input.body);
    const current = await new RecordingTypesRepository().get(db);
    const next = prepareRecordingTypeConfiguration(current, proposed);
    const fields: ApprovalField[] = [];
    for (const type of next.types) {
      const previous = current.types.find((entry) => entry.id === type.id);
      if (JSON.stringify(previous) === JSON.stringify(type)) continue;
      const change = !previous
        ? "Add"
        : !previous.retired && type.retired
          ? "Retire"
          : previous.retired && !type.retired
            ? "Restore"
            : "Change";
      fields.push(
        { label: `${change} ${type.name} · Before`, value: details(previous) },
        { label: `${change} ${type.name} · After`, value: details(type) }
      );
    }
    if (
      JSON.stringify(current.types.map((type) => type.id)) !==
      JSON.stringify(next.types.map((type) => type.id))
    ) {
      fields.push(
        { label: "Type order · Before", value: current.types.map((type) => type.name).join(" → ") },
        { label: "Type order · After", value: next.types.map((type) => type.name).join(" → ") }
      );
    }
    if (!fields.length) fields.push({ label: "Recording types", value: "No changes" });
    return {
      target: "Recording types",
      fields,
      version: createHash("sha256")
        .update(JSON.stringify([current, next]))
        .digest("hex")
    };
  } catch (error) {
    if (error instanceof RecordingIdentityError) return null;
    throw error;
  }
};
