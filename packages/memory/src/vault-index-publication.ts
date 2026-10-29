import type { DataContextDb } from "@moss/db";
import type { VaultContext } from "@moss/vault";

/** Public structural seam; Memory never imports or queries the module owning source receipts. */
export interface VaultIndexSourceRevision {
  readonly sourceModuleId: string;
  readonly sourceId: string;
  readonly generation: number;
}
export interface VaultIndexSnapshot {
  readonly ownerUserId: string;
  readonly destinationId: string;
  readonly contentHash: string;
  readonly key: string;
  readonly side: "personal" | "work" | null;
  readonly bindingRevision: number | null;
  readonly actorGeneration: number | null;
  readonly sources: readonly VaultIndexSourceRevision[];
}
export type VaultIndexCapture =
  | { readonly status: "ready"; readonly snapshot: VaultIndexSnapshot }
  | { readonly status: "blocked"; readonly reason: "unavailable" | "pending" | "source_changed" };
export type VaultIndexPublicationResult<T> =
  | { readonly status: "published"; readonly value: T }
  | { readonly status: "stale" };

export interface VaultIndexPublicationPort {
  captureScoped(
    db: DataContextDb,
    ctx: VaultContext,
    path: string,
    content: string
  ): Promise<VaultIndexCapture>;
  /** Provider work precedes this call. The callback may only publish local scoped index rows. */
  publishScoped<T>(
    db: DataContextDb,
    ctx: VaultContext,
    path: string,
    expected: VaultIndexSnapshot,
    work: (authoritative: VaultIndexSnapshot) => Promise<T>
  ): Promise<VaultIndexPublicationResult<T>>;
}
