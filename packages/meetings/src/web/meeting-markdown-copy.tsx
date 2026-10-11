import { useState } from "react";
import { Button, Field, FormLabel } from "@moss/ui";
import type { MeetingOutputArtifact, MeetingRecord } from "@moss/shared";
import { useMeetingTranscript } from "./meeting-transcript.js";
import { isMeetingAccessDenied } from "./client.js";
import { transcriptTime } from "./transcript-time.js";
export function MeetingMarkdownCopy({
  meeting,
  artifact
}: {
  readonly meeting: MeetingRecord;
  readonly artifact?: MeetingOutputArtifact;
}) {
  const transcript = useMeetingTranscript(meeting.id);
  const visibleTranscript = isMeetingAccessDenied(transcript.error) ? undefined : transcript.data;
  const [status, setStatus] = useState("");
  const body = [
    `# ${meeting.title}`,
    `## Notes\n\n${meeting.personalNotes}`,
    ...(artifact
      ? [
          `## Summary\n\n${artifact.content.overview}`,
          ...artifact.content.decisions.map((claim) => `- ${claim.text}`),
          ...artifact.content.actions.map((action) => `- [ ] ${action.text}`)
        ]
      : []),
    ...(visibleTranscript
      ? [
          `## Transcript`,
          ...visibleTranscript.snapshot.segments.map(
            (line) => `[${transcriptTime(line.startMs)}] ${line.text}`
          )
        ]
      : [])
  ].join("\n\n");
  return (
    <div className="meetings-section">
      <Field>
        <FormLabel htmlFor="meeting-markdown">Meeting Markdown</FormLabel>
        <textarea
          id="meeting-markdown"
          className="jds-textarea meetings-input"
          readOnly
          rows={8}
          value={body}
          onFocus={(event) => event.currentTarget.select()}
        />
      </Field>
      {visibleTranscript?.snapshot.omittedSegments ? (
        <p className="jds-hint">
          This copy includes only the displayed transcript; some lines are outside its size limit.
        </p>
      ) : null}
      <Button
        onClick={() =>
          void (
            navigator.clipboard
              ? navigator.clipboard.writeText(body)
              : Promise.reject(new Error("Clipboard unavailable"))
          ).then(
            () => setStatus("Copied"),
            () => setStatus("Couldn’t copy automatically. Select and copy the text above.")
          )
        }
      >
        Copy Markdown
      </Button>
      {status ? (
        <p role="status" className="jds-hint">
          {status}
        </p>
      ) : null}
    </div>
  );
}
