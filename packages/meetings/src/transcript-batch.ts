import type { IngestMeetingTranscriptInput, MeetingTranscriptLedger } from "@moss/shared";
import {
  applyMeetingTranscriptEvent,
  createMeetingTranscriptLedger,
  extendMeetingTranscriptSources
} from "./transcript.js";

export const MEETING_TRANSCRIPT_MAX_BATCHES = 4096;
export const MEETING_TRANSCRIPT_MAX_REVISIONS = 20000;
export const MEETING_TRANSCRIPT_MAX_STORAGE_BYTES = 32 * 1024 * 1024;
export class MeetingTranscriptInputError extends Error {}
export class MeetingTranscriptLimitError extends Error {}
export class MeetingTranscriptRequestConflictError extends Error {}

function exactKeys(value: object, keys: readonly string[]): void {
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new MeetingTranscriptInputError();
}
function boundedText(value: string, limit = 256): void {
  if (typeof value !== "string" || value.includes("\0") || !value.trim() || value.length > limit)
    throw new MeetingTranscriptInputError();
}

/** Canonical receipt input, independent of object-key order. Rejects unrecognized metadata. */
export function encodeMeetingTranscriptBatch(input: IngestMeetingTranscriptInput): string {
  try {
    exactKeys(input, [
      "meetingId",
      "requestKey",
      "expectedVersion",
      "sources",
      "events",
      "stopCutoffMs"
    ]);
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !Array.isArray(input.sources) ||
      input.sources.length < 1 ||
      !Array.isArray(input.events) ||
      (input.stopCutoffMs !== null &&
        (!Number.isSafeInteger(input.stopCutoffMs) || input.stopCutoffMs < 0))
    )
      throw new MeetingTranscriptInputError();
    if (
      input.expectedVersion >= MEETING_TRANSCRIPT_MAX_BATCHES ||
      input.sources.length > 128 ||
      input.events.length > 100
    )
      throw new MeetingTranscriptLimitError();
    const sources = input.sources
      .map((source) => {
        exactKeys(source, ["sourceId", "epoch", "kind", "label", "startMs", "endMs"]);
        if (![source.epoch, source.startMs, source.endMs].every(Number.isSafeInteger))
          throw new MeetingTranscriptInputError();
        boundedText(source.sourceId);
        boundedText(source.label);
        return {
          sourceId: source.sourceId,
          epoch: source.epoch,
          kind: source.kind,
          label: source.label,
          startMs: source.startMs,
          endMs: source.endMs
        };
      })
      .sort(
        (a, b) =>
          a.epoch - b.epoch || (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)
      );
    const events = input.events.map((event) => {
      exactKeys(event, ["cursor", "segment"]);
      const segment = event.segment;
      if (
        ![event.cursor, segment.epoch, segment.startMs, segment.endMs, segment.revision].every(
          Number.isSafeInteger
        )
      )
        throw new MeetingTranscriptInputError();
      exactKeys(segment, [
        "meetingId",
        "segmentId",
        "sourceId",
        "epoch",
        "startMs",
        "endMs",
        "revision",
        "text",
        "finality",
        "provenance",
        "speakerId"
      ]);
      boundedText(segment.meetingId);
      boundedText(segment.segmentId);
      boundedText(segment.sourceId);
      if (segment.speakerId !== null) boundedText(segment.speakerId);
      if (typeof segment.text !== "string" || segment.text.includes("\0"))
        throw new MeetingTranscriptInputError();
      return {
        cursor: event.cursor,
        segment: {
          meetingId: segment.meetingId.toLowerCase(),
          segmentId: segment.segmentId,
          sourceId: segment.sourceId,
          epoch: segment.epoch,
          startMs: segment.startMs,
          endMs: segment.endMs,
          revision: segment.revision,
          text: segment.text,
          finality: segment.finality,
          provenance: segment.provenance,
          speakerId: segment.speakerId
        }
      };
    });
    const encoded = JSON.stringify({
      meetingId: input.meetingId.toLowerCase(),
      requestKey: input.requestKey.toLowerCase(),
      expectedVersion: input.expectedVersion,
      sources,
      events,
      stopCutoffMs: input.stopCutoffMs
    });
    if (Buffer.byteLength(encoded) > 524288) throw new MeetingTranscriptLimitError();
    return encoded;
  } catch (error) {
    if (error instanceof MeetingTranscriptLimitError) throw error;
    throw new MeetingTranscriptInputError();
  }
}

export function applyMeetingTranscriptBatch(
  previous: MeetingTranscriptLedger | null,
  ownerUserId: string,
  previousStopCutoffMs: number | null,
  input: IngestMeetingTranscriptInput
): MeetingTranscriptLedger {
  try {
    if (previousStopCutoffMs !== null && input.stopCutoffMs !== previousStopCutoffMs)
      throw new MeetingTranscriptInputError();
    if (
      input.stopCutoffMs !== null &&
      input.sources.some((source) => source.endMs > input.stopCutoffMs!)
    )
      throw new MeetingTranscriptInputError();
    let ledger = previous
      ? extendMeetingTranscriptSources(previous, input.sources)
      : createMeetingTranscriptLedger(input.meetingId, ownerUserId, input.sources);
    for (const event of input.events) {
      const result = applyMeetingTranscriptEvent(ledger, event);
      if (result.status === "rejected") throw new MeetingTranscriptInputError();
      ledger = result.ledger;
    }
    if (ledger.transcriptRevision > MEETING_TRANSCRIPT_MAX_REVISIONS)
      throw new MeetingTranscriptLimitError();
    return ledger;
  } catch (error) {
    if (error instanceof MeetingTranscriptLimitError) throw error;
    throw new MeetingTranscriptInputError();
  }
}
