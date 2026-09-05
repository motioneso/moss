import { randomUUID } from "node:crypto";

export interface VerifiedSourceCandidate {
  readonly candidateId: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | null;
  readonly retrievalMethod: "feed" | "scrape";
  readonly sampleCount: number;
  readonly validationFingerprint: string;
  readonly redirectNote: string | null;
}

export interface PendingSourcePreview {
  readonly ownerUserId: string;
  readonly candidates: readonly VerifiedSourceCandidate[];
  readonly replaceSourceId: string | null;
  readonly createdAt: number;
}

export function createPreviewStore(
  opts: { ttlMs?: number; maxPerOwner?: number; now?: () => number } = {}
): {
  put(preview: PendingSourcePreview): string;
  take(ownerUserId: string, confirmationId: string): PendingSourcePreview | null;
} {
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1_000;
  const maxPerOwner = opts.maxPerOwner ?? 10;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, PendingSourcePreview>();

  return {
    put(preview) {
      const nowTs = now();
      for (const [id, value] of entries) {
        if (nowTs - value.createdAt > ttlMs) entries.delete(id);
      }
      const ownerEntries = [...entries].filter(
        ([, value]) => value.ownerUserId === preview.ownerUserId
      );
      if (ownerEntries.length >= maxPerOwner) {
        ownerEntries.sort((left, right) => left[1].createdAt - right[1].createdAt);
        entries.delete(ownerEntries[0]![0]);
      }
      const id = randomUUID();
      entries.set(id, preview);
      return id;
    },
    take(ownerUserId, confirmationId) {
      const preview = entries.get(confirmationId);
      if (!preview || preview.ownerUserId !== ownerUserId) return null;
      entries.delete(confirmationId);
      return now() - preview.createdAt <= ttlMs ? preview : null;
    }
  };
}
