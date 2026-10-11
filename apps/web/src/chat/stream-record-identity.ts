import type { TranscriptRecord } from "@moss/shared";

// #3195: two message identities share one live transcript. An ordinary reply carries the
// server turn that produced it, so its stored version replaces only that turn's unsaved
// reply. A background message (a delivered reminder) is committed before it is sent and
// carries its stored message id from the start, so it never replaces anything.

export function isBackgroundRecord(record: TranscriptRecord): boolean {
  return record.background === true && record.messageId !== undefined;
}

/** Applies one live stream record to the transcript. */
export function applyStreamRecord(
  current: readonly TranscriptRecord[],
  record: TranscriptRecord
): readonly TranscriptRecord[] {
  if (record.messageId) {
    const stored = current.findIndex(
      (item) => item.kind === record.kind && item.messageId === record.messageId
    );
    if (stored !== -1) return current.map((item, index) => (index === stored ? record : item));
  }
  if (record.kind === "reply" && record.messageId && record.turnId && !record.background) {
    const unsaved = findLastIndex(
      current,
      (item) => item.kind === "reply" && !item.messageId && item.turnId === record.turnId
    );
    if (unsaved !== -1) return current.map((item, index) => (index === unsaved ? record : item));
  }
  return upsertTranscriptRecord(current, record);
}

/**
 * Merges a history read into records that arrived on the stream first. Correlated action
 * outcomes and background messages alone are not a new turn, so history is kept and they are
 * added only when history lacks them. Ordinary live activity still wins outright.
 */
export function mergeHydratedRecords(
  current: readonly TranscriptRecord[],
  history: readonly TranscriptRecord[]
): readonly TranscriptRecord[] {
  const onlyOutOfTurn = current.every(
    (record) =>
      isBackgroundRecord(record) ||
      (record.actionRequestId &&
        ["action_result", "approved", "not_approved", "refusal", "refused"].includes(record.kind))
  );
  if (!onlyOutOfTurn) return current;
  const merged = [...history];
  for (const record of current) {
    const present = isBackgroundRecord(record)
      ? merged.some((item) => item.messageId === record.messageId)
      : merged.some(
          (item) => item.kind === record.kind && item.actionRequestId === record.actionRequestId
        );
    if (!present) merged.push(record);
  }
  return merged;
}

/** Adds background messages from a history read that the transcript does not show yet. */
export function mergeBackgroundRecords(
  current: readonly TranscriptRecord[],
  history: readonly TranscriptRecord[]
): readonly TranscriptRecord[] {
  const missing = history.filter(
    (record) =>
      isBackgroundRecord(record) && !current.some((item) => item.messageId === record.messageId)
  );
  return missing.length === 0 ? current : [...current, ...missing];
}

export function upsertTranscriptRecord(
  records: readonly TranscriptRecord[],
  record: TranscriptRecord
): TranscriptRecord[] {
  // Approval notifications may be replayed after reconnect. Their server request identity
  // outlives the engine's per-turn sequence numbers, so do not append another card/outcome.
  if (record.actionRequestId) {
    const existing = records.findIndex(
      (item) => item.kind === record.kind && item.actionRequestId === record.actionRequestId
    );
    if (existing >= 0) return records.map((item, index) => (index === existing ? record : item));
  }
  // ACP sequence numbers restart for each user turn. Stable ids and ordering therefore
  // only apply inside the current turn; scanning older turns lets a later `sequence: 1`
  // activity record jump in front of the first turn's `sequence: 2` record.
  let turnStart = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index]?.kind === "user") {
      turnStart = index + 1;
      break;
    }
  }
  const currentTurn = records.slice(turnStart);
  if (record.id) {
    const existingInTurn = currentTurn.findIndex((item) => item.id === record.id);
    const existing = existingInTurn === -1 ? -1 : turnStart + existingInTurn;
    if (existing >= 0) return records.map((item, index) => (index === existing ? record : item));
  }
  const insertionInTurn = currentTurn.findIndex(
    (item) =>
      record.sequence !== undefined &&
      item.sequence !== undefined &&
      item.sequence > record.sequence
  );
  const insertion = insertionInTurn === -1 ? -1 : turnStart + insertionInTurn;
  if (insertion >= 0) {
    return [...records.slice(0, insertion), record, ...records.slice(insertion)];
  }
  return [...records, record];
}

function findLastIndex(
  records: readonly TranscriptRecord[],
  match: (record: TranscriptRecord) => boolean
): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (match(records[index]!)) return index;
  }
  return -1;
}
