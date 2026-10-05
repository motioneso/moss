import type { MeetingOutputArtifact, MeetingOutputEvidence } from "@moss/shared";

/** Render untrusted artifact fields as text, never active Markdown/HTML or remote images. */
function plain(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}

function citation(evidence: MeetingOutputEvidence): string {
  return evidence.kind === "transcript"
    ? `transcript:${evidence.meetingId}/${evidence.segmentId}@${evidence.segmentRevision}:${evidence.startCharacter}-${evidence.endCharacter}`
    : `personal-note:${evidence.meetingId}@${evidence.notesRevision}:${evidence.startCharacter}-${evidence.endCharacter}`;
}
/** No source excerpts: only reviewed artifact content and exact revision/range references. */
export function renderMeetingExport(artifact: MeetingOutputArtifact): string {
  const claim = (item: { text: string; evidence: readonly MeetingOutputEvidence[] }) =>
    `- ${plain(item.text)}\n  Evidence: ${item.evidence.map(citation).join("; ")}`;
  return (
    [
      `# Meeting ${plain(artifact.meetingId)}`,
      `Artifact: ${plain(artifact.id)} version ${artifact.version}`,
      `Created: ${plain(artifact.createdAt)}`,
      `Origin: ${artifact.origin}; template: ${plain(artifact.templateId)}@${artifact.templateVersion}`,
      `Inputs: transcript revision ${artifact.inputs.transcript?.transcriptRevision ?? 0}; personal notes revision ${artifact.inputs.notesRevision}`,
      "Private independent copy. Source evidence may become unavailable after meeting deletion.",
      "## Overview",
      plain(artifact.content.overview),
      "## Decisions",
      ...artifact.content.decisions.map(claim),
      "## Open questions",
      ...artifact.content.openQuestions.map((text) => `- ${plain(text)}`),
      "## Suggested actions (not accepted Tasks)",
      ...artifact.content.actions.map(
        (action) =>
          `${claim(action)}\n  Owner phrase: ${plain(action.ownerPhrase ?? "Unspecified")}; date phrase: ${plain(action.duePhrase ?? "Unspecified")}`
      ),
      "## Warnings",
      ...artifact.content.warnings.map((text) => `- ${plain(text)}`)
    ].join("\n\n") + "\n"
  );
}
