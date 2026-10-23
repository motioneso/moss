import { readStoredVisual, visualReplyText } from "@moss/shared";
import type { ExportRow } from "./data-export.js";

/** Portable exports retain readable facts, without requiring the visual runtime or its DSL. */
export function chatExportText(row: ExportRow): ExportRow {
  const metadata = row.toolMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return row;
  const { visualReplyV1, ...rest } = metadata;
  if (visualReplyV1 === undefined) return row;
  const visual = readStoredVisual(visualReplyV1);
  return {
    ...row,
    body: visualReplyText(
      typeof row.body === "string" ? row.body : "",
      visual.visualReply?.fallbackText ?? visual.visualFallbackText
    ),
    toolMetadata: rest
  };
}
