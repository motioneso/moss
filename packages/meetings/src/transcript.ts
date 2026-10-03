import type {
  MeetingTranscriptApplyResult,
  MeetingTranscriptEvent,
  MeetingTranscriptEvidence,
  MeetingTranscriptLedger,
  MeetingTranscriptSegment,
  MeetingTranscriptSelection,
  MeetingTranscriptSnapshot,
  MeetingTranscriptSource
} from "@moss/shared";

export const MEETING_TRANSCRIPT_MAX_SEGMENTS = 500;
export const MEETING_TRANSCRIPT_MAX_CHARACTERS = 100_000;

function integer(value: number, minimum = 0): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function identifier(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Sources describe captured intervals, not permissions or native capture proof. */
export function createMeetingTranscriptLedger(
  meetingId: string,
  ownerUserId: string,
  sources: readonly MeetingTranscriptSource[]
): MeetingTranscriptLedger {
  if (!identifier(meetingId) || !identifier(ownerUserId) || sources.length === 0) {
    throw new Error("Invalid transcript identity or sources");
  }
  const keys = new Set<string>();
  for (const source of sources) {
    const key = JSON.stringify([source.sourceId, source.epoch]);
    if (
      !identifier(source.sourceId) ||
      !identifier(source.label) ||
      !integer(source.epoch, 1) ||
      !integer(source.startMs) ||
      !integer(source.endMs) ||
      source.endMs <= source.startMs ||
      (source.kind !== "microphone" && source.kind !== "output") ||
      keys.has(key)
    ) {
      throw new Error("Invalid transcript source interval");
    }
    keys.add(key);
  }
  for (const source of sources) {
    const prior = sources.filter((item) => item.epoch < source.epoch);
    if (
      prior.some(
        (item) =>
          item.endMs > source.startMs ||
          (item.sourceId === source.sourceId && item.kind !== source.kind)
      )
    ) {
      throw new Error("Inconsistent transcript source epochs");
    }
  }
  return Object.freeze({
    meetingId,
    ownerUserId,
    sources: Object.freeze(sources.map((source) => Object.freeze({ ...source }))),
    transcriptRevision: 0,
    cursor: 0,
    revisions: Object.freeze([])
  });
}

/**
 * Replace confirmed captured bounds with a monotonic extension. This does not
 * authorize capture or alter transcript revisions, event cursors or old evidence.
 */
export function extendMeetingTranscriptSources(
  ledger: MeetingTranscriptLedger,
  sources: readonly MeetingTranscriptSource[]
): MeetingTranscriptLedger {
  const validated = createMeetingTranscriptLedger(ledger.meetingId, ledger.ownerUserId, sources);
  for (const previous of ledger.sources) {
    const next = validated.sources.find(
      (source) => source.sourceId === previous.sourceId && source.epoch === previous.epoch
    );
    if (
      !next ||
      next.startMs !== previous.startMs ||
      next.kind !== previous.kind ||
      next.label !== previous.label ||
      next.endMs < previous.endMs
    ) {
      throw new Error(
        "Existing transcript source identity and captured bounds cannot be rewritten"
      );
    }
  }
  const latestEpoch = ledger.sources.reduce(
    (maximum, source) => Math.max(maximum, source.epoch),
    0
  );
  for (const source of validated.sources) {
    const existing = ledger.sources.some(
      (previous) => previous.sourceId === source.sourceId && previous.epoch === source.epoch
    );
    if (!existing && source.epoch < latestEpoch) {
      throw new Error("New transcript sources cannot be added to an older epoch");
    }
  }
  return Object.freeze({ ...ledger, sources: validated.sources });
}

function validSegment(segment: MeetingTranscriptSegment): boolean {
  return (
    identifier(segment.meetingId) &&
    identifier(segment.segmentId) &&
    identifier(segment.sourceId) &&
    integer(segment.epoch, 1) &&
    integer(segment.revision, 1) &&
    integer(segment.startMs) &&
    integer(segment.endMs) &&
    segment.endMs > segment.startMs &&
    typeof segment.text === "string" &&
    segment.text.length <= MEETING_TRANSCRIPT_MAX_CHARACTERS &&
    (segment.finality === "provisional" || segment.finality === "final") &&
    (segment.provenance === "transcription" || segment.provenance === "correction") &&
    (segment.provenance !== "correction" || segment.finality === "final") &&
    (segment.speakerId === null || identifier(segment.speakerId))
  );
}

function sameSegment(a: MeetingTranscriptSegment, b: MeetingTranscriptSegment): boolean {
  return (
    a.meetingId === b.meetingId &&
    a.segmentId === b.segmentId &&
    a.sourceId === b.sourceId &&
    a.epoch === b.epoch &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs &&
    a.revision === b.revision &&
    a.text === b.text &&
    a.finality === b.finality &&
    a.provenance === b.provenance &&
    a.speakerId === b.speakerId
  );
}

/** Pure acceptance; no provider, persistence, access-control or tool-execution path. */
export function applyMeetingTranscriptEvent(
  ledger: MeetingTranscriptLedger,
  event: MeetingTranscriptEvent
): MeetingTranscriptApplyResult {
  const reject = (
    reason: Extract<MeetingTranscriptApplyResult, { status: "rejected" }>["reason"]
  ): MeetingTranscriptApplyResult => ({ status: "rejected", reason, ledger });
  const segment = event.segment;
  if (!integer(event.cursor, 1) || !validSegment(segment)) return reject("invalid-event");
  if (segment.meetingId !== ledger.meetingId) return reject("meeting-mismatch");
  const source = ledger.sources.find(
    (item) => item.sourceId === segment.sourceId && item.epoch === segment.epoch
  );
  if (!source || segment.startMs < source.startMs || segment.endMs > source.endMs) {
    return reject("source-mismatch");
  }
  const history = ledger.revisions.filter((item) => item.segment.segmentId === segment.segmentId);
  const existing = history.find((item) => item.segment.revision === segment.revision);
  if (existing) {
    return existing.cursor === event.cursor && sameSegment(existing.segment, segment)
      ? { status: "replay", ledger }
      : reject("revision-conflict");
  }
  const previous = history.at(-1)?.segment;
  if (previous && segment.revision < previous.revision) return reject("stale-revision");
  if (event.cursor <= ledger.cursor) return reject("out-of-order-event");
  if (previous && (previous.sourceId !== segment.sourceId || previous.epoch !== segment.epoch)) {
    return reject("source-mismatch");
  }
  if (
    previous?.finality === "final" &&
    (segment.finality !== "final" || segment.provenance !== "correction")
  ) {
    return reject("finality-regression");
  }
  if (!integer(ledger.transcriptRevision + 1, 1)) return reject("invalid-event");
  const revision = Object.freeze({
    cursor: event.cursor,
    segment: Object.freeze({ ...segment }),
    transcriptRevision: ledger.transcriptRevision + 1
  });
  return {
    status: "accepted",
    ledger: Object.freeze({
      ...ledger,
      cursor: event.cursor,
      transcriptRevision: revision.transcriptRevision,
      revisions: Object.freeze([...ledger.revisions, revision])
    })
  };
}

/** Select whole segments ending at/before cutoff; never silently truncate quoted text. */
export function selectMeetingTranscriptSnapshot(
  ledger: MeetingTranscriptLedger,
  selection: MeetingTranscriptSelection
): MeetingTranscriptSnapshot {
  if (
    selection.meetingId !== ledger.meetingId ||
    selection.ownerUserId !== ledger.ownerUserId ||
    !integer(selection.transcriptRevision) ||
    selection.transcriptRevision > ledger.transcriptRevision ||
    !integer(selection.cutoffMs) ||
    !integer(selection.maxSegments, 1) ||
    selection.maxSegments > MEETING_TRANSCRIPT_MAX_SEGMENTS ||
    !integer(selection.maxCharacters, 1) ||
    selection.maxCharacters > MEETING_TRANSCRIPT_MAX_CHARACTERS
  ) {
    throw new Error("Invalid transcript selection binding or bounds");
  }
  const latest = new Map<string, MeetingTranscriptSegment>();
  let cursor = 0;
  for (const revision of ledger.revisions) {
    if (revision.transcriptRevision > selection.transcriptRevision) break;
    latest.set(revision.segment.segmentId, revision.segment);
    cursor = revision.cursor;
  }
  const eligible = [...latest.values()]
    .filter((segment) => segment.endMs <= selection.cutoffMs)
    .sort(
      (a, b) =>
        a.startMs - b.startMs ||
        a.endMs - b.endMs ||
        (a.segmentId < b.segmentId ? -1 : a.segmentId > b.segmentId ? 1 : 0)
    );
  const segments: MeetingTranscriptSegment[] = [];
  let characters = 0;
  for (const segment of eligible) {
    if (
      segments.length === selection.maxSegments ||
      characters + segment.text.length > selection.maxCharacters
    ) {
      break;
    }
    segments.push(segment);
    characters += segment.text.length;
  }
  return Object.freeze({
    ...selection,
    cursor,
    segments: Object.freeze(segments),
    throughMs: segments.length === 0 ? null : Math.max(...segments.map((segment) => segment.endMs)),
    omittedSegments: eligible.length - segments.length,
    containsProvisional: segments.some((segment) => segment.finality === "provisional")
  });
}

/** Resolve only the pinned revision; a later correction cannot redirect old evidence. */
export function resolveMeetingTranscriptEvidence(
  ledger: MeetingTranscriptLedger,
  evidence: MeetingTranscriptEvidence
): { readonly segment: MeetingTranscriptSegment; readonly excerpt: string } | null {
  if (
    evidence.meetingId !== ledger.meetingId ||
    !integer(evidence.segmentRevision, 1) ||
    !integer(evidence.startCharacter) ||
    !integer(evidence.endCharacter) ||
    evidence.endCharacter <= evidence.startCharacter
  ) {
    return null;
  }
  const segment = ledger.revisions.find(
    (revision) =>
      revision.segment.segmentId === evidence.segmentId &&
      revision.segment.revision === evidence.segmentRevision
  )?.segment;
  if (!segment || evidence.endCharacter > segment.text.length) return null;
  return Object.freeze({
    segment,
    excerpt: segment.text.slice(evidence.startCharacter, evidence.endCharacter)
  });
}
