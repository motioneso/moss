// #1572 Custom public news sources — in-memory preview store for the discover -> confirm flow.
// Mirrors packages/news/src/discovery/preview-store.ts (not part of News' public seam, so
// reimplemented locally rather than reaching into another module's internals).
import { randomUUID } from "node:crypto";

import type { PreviewSportsSourceCandidate } from "@moss/shared";

import type { VerifiedSportsSourceCandidate, VerifiedSportsSourceTarget } from "./discovery.js";
import type { SportsSourceBaseline } from "./repository.js";

interface PendingSportsPreviewBase {
  readonly ownerUserId: string;
  readonly authorizationAcknowledgement: string;
  readonly createdAt: number;
}

export interface PendingSportsNewSourcePreview extends PendingSportsPreviewBase {
  readonly kind: "new-source";
  readonly candidate: VerifiedSportsSourceCandidate;
  readonly submittedUrl: string;
  readonly duplicateOfSourceId: string | null;
}

export interface PendingSportsAssignmentPreview extends PendingSportsPreviewBase {
  readonly kind: "assignment-replacement";
  readonly candidate: PreviewSportsSourceCandidate;
  readonly sourceId: string;
  readonly baseline: SportsSourceBaseline;
  readonly reusedAssignmentIds: readonly string[];
  readonly verifiedTargets: readonly VerifiedSportsSourceTarget[];
}

export interface PendingSportsRecipeRebuildPreview extends PendingSportsPreviewBase {
  readonly kind: "recipe-rebuild";
  readonly candidate: VerifiedSportsSourceCandidate;
  readonly sourceId: string;
  readonly baseline: SportsSourceBaseline;
}

export type PendingSportsSourcePreview =
  | PendingSportsNewSourcePreview
  | PendingSportsAssignmentPreview
  | PendingSportsRecipeRebuildPreview;

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
