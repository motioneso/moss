import { storedVisualText } from "@moss/shared";
import type { ExportRow } from "./data-export.js";

/** Portable exports retain readable facts, without requiring the visual runtime or its DSL. */
export function chatExportText(row: ExportRow): ExportRow {
  const metadata = row.toolMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return row;
  const { visualReplyV1, ...rest } = metadata;
  if (visualReplyV1 === undefined) return row;
  return {
    ...row,
    body: storedVisualText(typeof row.body === "string" ? row.body : "", visualReplyV1),
    toolMetadata: rest
  };
}
