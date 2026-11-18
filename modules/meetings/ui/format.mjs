/** Pure text helpers for the Meetings screen. No DOM access, so node can test them. */

export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function transcriptTime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A real recorded duration only; unknown length is a dash. */
export function meetingLength(durationMs) {
  if (durationMs == null) return "—";
  const minutes = Math.round(durationMs / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function meetingDate(
  value,
  options = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, options).format(date);
}

export function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

export function titleProblem(raw) {
  const title = raw.trim();
  return !title || title.includes("\0") || utf8Length(title) > 240
    ? "Use a title of up to 240 bytes."
    : null;
}

export function notesProblem(text) {
  return text.includes("\0") || utf8Length(text) > 64000;
}

export function randomKey() {
  return globalThis.crypto.randomUUID();
}

const SPEAKER = /\{\{speaker:([^{}\s]{1,100})\}\}/g;

export function speakerText(text, speakers) {
  if (!text.includes("{{speaker:")) return text;
  return text.replace(SPEAKER, (_m, id) => {
    const guess = (speakers ?? []).find((entry) => entry.speakerId === id);
    if (guess?.name) return `${guess.name} (guess)`;
    const digits = /(\d+)$/.exec(id)?.[1];
    return digits ? `Speaker ${Number(digits)}` : `Speaker (${id})`;
  });
}

export function resolveSummary(content) {
  const r = (t) => speakerText(t, content.speakers);
  return {
    ...content,
    overview: r(content.overview),
    decisions: content.decisions.map((c) => ({ ...c, text: r(c.text) })),
    openQuestions: content.openQuestions.map(r),
    actions: content.actions.map((a) => ({ ...a, text: r(a.text) })),
    warnings: content.warnings.map(r)
  };
}

export function lineLabel(segment, sources) {
  const source = (sources ?? []).find(
    (s) => s.sourceId === segment.sourceId && s.epoch === segment.epoch
  );
  if (source?.kind === "microphone") return "You";
  if (source?.kind === "output") return "Call audio";
  return source?.label || "Audio";
}

const FAILURES = {
  meeting_output_queue_unavailable: ["Recording stopped, but the summary couldn’t be queued."],
  meeting_output_interrupted: [
    "The automatic summary was interrupted. Your transcript and notes are kept."
  ],
  meeting_output_subscription_unsupported: [
    "Summaries on this subscription aren’t supported yet. No other model was used."
  ],
  meeting_output_subscription_isolation_unavailable: [
    "Subscription summaries aren’t available on this server setup. No other model was used."
  ],
  meeting_output_claude_subscription_unsupported: [
    "Summaries on this Claude subscription aren’t supported yet. No other model was used."
  ],
  meeting_output_isolation_failed: [
    "Moss couldn’t write this summary because Claude didn’t accept the settings that keep your meeting private. Your transcript and notes are kept; try Rewrite summary later.",
    "ai-settings"
  ],
  meeting_output_runner_offline: [
    "Moss couldn’t write this summary because it couldn’t reach Claude. Your transcript and notes are kept; try Rewrite summary once it’s back.",
    "ai-settings"
  ],
  meeting_output_route_unavailable: [
    "Moss couldn’t write this summary because no AI is chosen for summaries yet. Your transcript and notes are kept; try Rewrite summary after one is chosen.",
    "ai-settings"
  ],
  meeting_output_provider_failed: [
    "Your model couldn’t complete the summary. Check its connection and try again. No other model was used.",
    "ai-providers"
  ],
  meeting_output_timed_out: [
    "The summary took too long and was stopped. Try again when you’re ready."
  ],
  meeting_output_route_changed: [
    "The summary model configuration changed during generation. Review it before generating again.",
    "ai-providers"
  ]
};
export const SELF_CONTAINED = new Set([
  "meeting_output_isolation_failed",
  "meeting_output_runner_offline",
  "meeting_output_route_unavailable"
]);

export function summaryFailure(code) {
  const [message, remediation] = FAILURES[code] ?? [
    "The summary could not be generated. Try again when you’re ready. No other model was used."
  ];
  return { status: "failed", message, remediation };
}

export function accessDenied(error) {
  return error?.status === 401 || error?.status === 403 || error?.status === 404;
}

/** Message and state for a failed write. */
export function operationError(error) {
  if (accessDenied(error))
    return {
      status: "denied",
      message: "Access is unavailable. Return to history or sign in again."
    };
  if (error?.code === "meeting_output_busy")
    return {
      status: "failed",
      message: "A summary is already being generated. Refresh to check its result."
    };
  if (error?.status === 409)
    return {
      status: "failed",
      message:
        "The saved version changed or needs review. Refresh before trying a new request. Your edits are kept."
    };
  if (error?.status === 400 || error?.status === 422)
    return {
      status: "failed",
      message: "This request could not be completed. Review the inputs and try a new request."
    };
  return {
    status: "retry",
    message: "The result could not be confirmed. Retry this same request."
  };
}

export function exportStatus(receipt) {
  if (receipt.writeStatus === "conflict" || receipt.errorCode === "meeting_vault_conflict")
    return "The saved note was changed or removed. It has not been overwritten. Save a new summary version instead.";
  if (receipt.writeStatus === "failed") return "The private note could not be saved.";
  if (receipt.writeStatus === "pending") return "The private note write is pending.";
  if (receipt.indexStatus === "queued")
    return "Saved to Moss private vault. Search indexing queued.";
  if (receipt.indexStatus === "delayed")
    return "Saved to Moss private vault. Search indexing delayed; retry to request indexing again.";
  if (receipt.indexStatus === "conflict")
    return "Saved to Moss private vault. Search indexing needs review.";
  return "Saved to Moss private vault. Search indexing not requested.";
}

export function markdownBody(meeting, artifact, transcript) {
  const summary = artifact ? resolveSummary(artifact.content) : undefined;
  return [
    `# ${meeting.title}`,
    `## Notes\n\n${meeting.personalNotes}`,
    ...(summary
      ? [
          `## Summary\n\n${summary.overview}`,
          ...summary.decisions.map((c) => `- ${c.text}`),
          ...summary.actions.map((a) => `- [ ] ${a.text}`)
        ]
      : []),
    ...(transcript
      ? [
          "## Transcript",
          ...transcript.snapshot.segments.map((l) => `[${transcriptTime(l.startMs)}] ${l.text}`)
        ]
      : [])
  ].join("\n\n");
}

/** Reads the four evidence fields from a query string, or null when they are not a valid range. */
export function parseEvidence(params) {
  const segmentId = params.get("segmentId");
  const n = ["segmentRevision", "startCharacter", "endCharacter"].map((k) => {
    const v = params.get(k);
    return v !== null && /^\d+$/.test(v) ? Number(v) : NaN;
  });
  const [segmentRevision, startCharacter, endCharacter] = n;
  if (
    !segmentId?.trim() ||
    segmentId.length > 256 ||
    n.some((x) => !Number.isSafeInteger(x)) ||
    segmentRevision < 1 ||
    startCharacter < 0 ||
    endCharacter <= startCharacter
  )
    return null;
  return { segmentId, segmentRevision, startCharacter, endCharacter };
}
