import type { MeetingHistoryFilter, MeetingHistoryItem } from "@moss/shared";
import { transcriptTime } from "./meeting-transcript.js";

export const historyFilters: readonly { value: MeetingHistoryFilter; label: string }[] = [
  { value: "all", label: "All states" },
  { value: "transcript", label: "With a transcript" },
  { value: "needs-review", label: "Needs review" },
  { value: "exported", label: "With a saved version" },
  { value: "notes-only", label: "Notes without a transcript" }
];

export function historyFilter(value: string | null): MeetingHistoryFilter {
  return historyFilters.find((filter) => filter.value === value)?.value ?? "all";
}

export function transcriptSpan(meeting: MeetingHistoryItem): string | null {
  const span = meeting.transcript.span;
  return span ? `${transcriptTime(span.startMs)}–${transcriptTime(span.endMs)}` : null;
}

export function processingStatus(meeting: MeetingHistoryItem): string {
  const generation = meeting.summary.generation?.status;
  if (generation === "pending") return "Generating";
  if (generation === "failed") return "Generation failed";
  if (generation === "interrupted") return "Generation interrupted";
  if (meeting.summary.status === "stale") return "Summary needs review";
  if (meeting.transcript.provisionalSegmentCount) return "Provisional transcript";
  if (meeting.summary.status === "available") return "Summary available";
  if (meeting.transcript.status === "retained") return "Transcript available";
  return "Not generated";
}

export function vaultStatus(meeting: MeetingHistoryItem): string {
  const receipt = meeting.vault.latest;
  if (!receipt) return "Not saved";
  return {
    pending: "Save pending",
    saved: `Version ${receipt.artifactVersion} saved`,
    failed: "Save failed",
    conflict: "Save needs review"
  }[receipt.writeStatus];
}

export function indexingStatus(meeting: MeetingHistoryItem): string | null {
  const receipt = meeting.vault.latest;
  if (!receipt || receipt.writeStatus !== "saved") return null;
  return {
    "not-requested": "Search indexing not requested",
    queued: "Search indexing queued",
    delayed: "Search indexing delayed",
    conflict: "Search indexing needs review"
  }[receipt.indexStatus];
}
