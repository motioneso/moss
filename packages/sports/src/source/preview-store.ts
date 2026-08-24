// #1572 Custom public news sources — in-memory preview store for the discover -> confirm flow.
// Mirrors packages/news/src/discovery/preview-store.ts (not part of News' public seam, so
// reimplemented locally rather than reaching into another module's internals).
import { randomUUID } from "node:crypto";

import type { VerifiedSportsSourceCandidate } from "./discovery.js";

export interface PendingSportsSourcePreview {
  readonly kind: "new-source";
  readonly ownerUserId: string;
  readonly submittedUrl: string;
  readonly candidate: VerifiedSportsSourceCandidate;
  readonly duplicateOfSourceId: string | null;
  readonly authorizationAcknowledgement: string;
  readonly createdAt: number;
}

export function createSportsPreviewStore(
  opts: { ttlMs?: number; maxPerOwner?: number; now?: () => number } = {}
): {
  put(preview: PendingSportsSourcePreview): string;
  take(ownerUserId: string, confirmationId: string): PendingSportsSourcePreview | null;
} {
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1_000;
  const maxPerOwner = opts.maxPerOwner ?? 10;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, PendingSportsSourcePreview>();

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
