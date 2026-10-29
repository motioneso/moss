import type { HeartbeatEvidenceItem, HeartbeatSource } from "@moss/shared";

export interface HeartbeatMuteRule {
  readonly scope: "item" | "topic";
  readonly source: string | null;
  readonly entityKey: string | null;
  readonly topic: string | null;
}

export interface HeartbeatCandidate {
  readonly findingId: string;
  readonly source: HeartbeatSource;
  readonly item: HeartbeatEvidenceItem;
}

export function isMuted(
  rules: readonly HeartbeatMuteRule[],
  source: HeartbeatSource,
  item: HeartbeatEvidenceItem
): boolean {
  const title = item.title.toLowerCase();
  return rules.some((rule) =>
    rule.scope === "item"
      ? rule.source === source && rule.entityKey === item.entityKey
      : rule.topic !== null && rule.topic.trim() !== "" && title.includes(rule.topic.toLowerCase())
  );
}

/** Findings the owner already saw or dismissed, keyed by source, entity and episode. */
export function findingKey(source: string, entityKey: string, episodeKey: string): string {
  return JSON.stringify([source, entityKey, episodeKey]);
}

/** Drops muted items and items already published or settled before the model sees anything. */
export function filterCandidates(
  candidates: readonly HeartbeatCandidate[],
  mutes: readonly HeartbeatMuteRule[],
  settled: ReadonlySet<string>
): HeartbeatCandidate[] {
  return candidates.filter(
    (candidate) =>
      !isMuted(mutes, candidate.source, candidate.item) &&
      !settled.has(
        findingKey(candidate.source, candidate.item.entityKey, candidate.item.episodeKey)
      )
  );
}
