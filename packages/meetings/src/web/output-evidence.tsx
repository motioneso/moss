import { Link } from "react-router";
import type { MeetingOutputArtifact, MeetingOutputEvidence } from "@moss/shared";
import { transcriptTime } from "./transcript-time.js";

export function OutputEvidence({
  evidence,
  artifact
}: {
  readonly evidence: readonly MeetingOutputEvidence[];
  readonly artifact: MeetingOutputArtifact;
}) {
  return (
    <div className="meetings-section">
      {evidence.map((reference, index) => {
        if (reference.kind === "personal-note")
          return (
            <details key={index}>
              <summary>My notes · View source</summary>
              <p className="meetings-transcript-text">
                {artifact.inputs.personalNotes.slice(
                  reference.startCharacter,
                  reference.endCharacter
                )}
              </p>
            </details>
          );
        const segment = artifact.inputs.transcript?.segments.find(
          (item) =>
            item.segmentId === reference.segmentId && item.revision === reference.segmentRevision
        );
        const params = new URLSearchParams({
          id: reference.meetingId,
          segmentId: reference.segmentId,
          segmentRevision: String(reference.segmentRevision),
          startCharacter: String(reference.startCharacter),
          endCharacter: String(reference.endCharacter)
        });
        return (
          <div key={index} className="meetings-transcript-turn">
            <Link to={`?${params}`}>
              Transcript
              {segment
                ? ` · ${transcriptTime(segment.startMs)}–${transcriptTime(segment.endMs)}`
                : ""}
            </Link>
            {segment ? (
              <p className="meetings-transcript-text">
                {segment.text.slice(reference.startCharacter, reference.endCharacter)}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
