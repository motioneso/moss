import { hasSpokenText, type ChatVoiceRequestStatus, type TranscriptRecord } from "@moss/shared";

/**
 * Where an unsaved receipt belongs by time: before the first saved message created after it, or
 * the first live user turn that is not saved yet. Activity rows carry no time and never anchor.
 */
function indexByTime(
  records: readonly TranscriptRecord[],
  createdAt: string,
  receiptTurns: ReadonlySet<string>
): number {
  return records.findIndex((record) =>
    record.createdAt
      ? record.createdAt > createdAt
      : record.kind === "user" && !receiptTurns.has(record.turnId ?? "")
  );
}

/** Reconcile receipt placeholders with canonical turns without comparing message text. */
export function mergeVoiceInputRecords(
  current: readonly TranscriptRecord[],
  requests: readonly ChatVoiceRequestStatus[],
  recovered: ReadonlyMap<string, readonly TranscriptRecord[]>,
  history: readonly TranscriptRecord[] = []
): readonly TranscriptRecord[] {
  let records = [...current];
  const ordered = [...requests].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
  const receiptTurns = new Set(ordered.map((request) => request.turnId));
  const positions = new Map(ordered.map((request, index) => [request.turnId, index]));
  for (const request of ordered) {
    const saved = recovered.get(request.turnId) ?? [];
    const replacements = saved.filter((record) => record.messageId);
    // Keep live tool/approval activity. Replace transient message rows with their saved identity.
    for (const replacement of replacements) {
      const index = records.findIndex(
        (record) => record.turnId === request.turnId && record.kind === replacement.kind
      );
      if (index >= 0) records[index] = replacement;
    }
    const hasUser = records.some(
      (record) => record.kind === "user" && record.turnId === request.turnId
    );
    if (!hasUser) {
      const nextVoiceIndex = records.findIndex(
        (record) =>
          record.turnId && (positions.get(record.turnId) ?? -1) > positions.get(request.turnId)!
      );
      if (saved.length) {
        const lastSaved = history
          .map((record) => record.messageId)
          .lastIndexOf(saved.at(-1)?.messageId);
        const nextSaved = history
          .slice(lastSaved + 1)
          .find(
            (record) =>
              record.messageId && records.some((item) => item.messageId === record.messageId)
          );
        const historyIndex = nextSaved
          ? records.findIndex((record) => record.messageId === nextSaved.messageId)
          : -1;
        const anchors = [nextVoiceIndex, historyIndex].filter((index) => index >= 0);
        const nextIndex = anchors.length
          ? Math.min(...anchors)
          : records.findIndex(
              (record) =>
                record.kind === "user" &&
                !record.messageId &&
                !requests.some((request) => request.turnId === record.turnId)
            );
        records.splice(nextIndex < 0 ? records.length : nextIndex, 0, ...saved);
      } else {
        // A legacy waiting receipt keeps its bubble so Send stays reachable. Otherwise text
        // without speech is never a bubble, and a finished one has nothing left to show.
        const spoken = hasSpokenText(request.transcript) || request.state === "ready-to-send";
        if (!spoken && request.state === "interrupted") continue;
        const placeholder: TranscriptRecord = spoken
          ? {
              kind: "user",
              text: request.transcript,
              turnId: request.turnId
            }
          : { kind: "status", text: request.statusMessage, turnId: request.turnId };
        const anchors = [
          nextVoiceIndex,
          indexByTime(records, request.createdAt, receiptTurns)
        ].filter((index) => index >= 0);
        records.splice(anchors.length ? Math.min(...anchors) : records.length, 0, placeholder);
      }
    } else {
      for (const record of saved) {
        if (record.messageId && !records.some((item) => item.messageId === record.messageId)) {
          // A missed saved reply belongs beside its user, before the next turn.
          const userIndex = records.findIndex(
            (item) => item.kind === "user" && item.turnId === request.turnId
          );
          const next = records.findIndex((item, i) => i > userIndex && item.kind === "user");
          records.splice(next < 0 ? records.length : next, 0, record);
        }
      }
    }
    const seen = new Set<string>();
    records = records.filter((record) => {
      if (record.turnId !== request.turnId) return true;
      if (request.state === "replied" && record.visualState === "preparing") return false;
      if (!["user", "reply", "error"].includes(record.kind)) return true;
      if (seen.has(record.kind)) return false;
      seen.add(record.kind);
      return true;
    });
  }
  return records;
}
