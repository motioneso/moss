import { createHash } from "node:crypto";
import type { RecordingMetadata } from "@moss/shared";

/** Title/type edits do not change the side interpretation awaiting review. */
export function recordingSideReviewVersion(metadata: RecordingMetadata): string | undefined {
  if (
    metadata.side === null ||
    metadata.outputVersion === null ||
    metadata.confidence === null ||
    metadata.confidence >= 0.8
  )
    return undefined;
  const interpretation = createHash("sha256")
    .update(JSON.stringify([metadata.side, metadata.confidence, metadata.reason]))
    .digest("hex");
  return `${metadata.outputVersion}:${interpretation}`;
}
