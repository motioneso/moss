import { useState } from "react";
import { DisclosureToggle, Note } from "@moss/ui";
import type { MeetingCaptureState } from "@moss/shared";
import { transcriptTime } from "./meeting-transcript.js";

const GAP_REASONS = {
  paused: "Paused",
  expired: "Buffered audio expired",
  "buffer-full": "Audio buffer full",
  "source-unavailable": "Source unavailable",
  "processing-failed": "Transcription failed",
  interrupted: "Capture interrupted",
  discarded: "Audio discarded"
} as const;
export function CaptureGaps({ capture }: { readonly capture: MeetingCaptureState }) {
  const [expanded, setExpanded] = useState(false);
  if (!capture.gaps.length && !capture.gapLimitReached) return null;
  return (
    <Note variant="practical">
      <div className="meetings-section">
        <p>
          {capture.gapLimitReached
            ? "The capture gap limit was reached. Additional missing ranges may not be listed."
            : "Some audio is missing from this capture."}
        </p>
        {capture.gaps.length ? (
          <>
            <DisclosureToggle
              expanded={expanded}
              controls="meeting-capture-gaps"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Hide" : "Show"} {capture.gaps.length} capture{" "}
              {capture.gaps.length === 1 ? "gap" : "gaps"}
            </DisclosureToggle>
            {expanded ? (
              <ul id="meeting-capture-gaps" className="meetings-section">
                {capture.gaps.map((gap) => (
                  <li key={gap.id}>
                    <span className="jds-label">
                      {transcriptTime(gap.startMs)}–{transcriptTime(gap.endMs)}
                    </span>{" "}
                    <span className="jds-hint">{GAP_REASONS[gap.reason]}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
    </Note>
  );
}
