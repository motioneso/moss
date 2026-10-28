import { createHash } from "node:crypto";
import { assertUuid } from "@moss/db";
import type { ManagedSourceSnapshot } from "./managed-source-lifecycle.js";

export interface ManagedNoteSnapshotIdentity {
  readonly destinationId: string;
  readonly contentHash: string;
  readonly bindingRevision: number;
  readonly side: "personal" | "work";
  readonly lifecycle: ManagedSourceSnapshot;
}

function generation(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    throw new Error("Invalid managed snapshot revision");
}

/** Metadata-only fingerprint. A label or represented-source change invalidates unchanged text. */
export function managedNoteSnapshotKey(input: ManagedNoteSnapshotIdentity): string {
  if (!/^[a-f0-9]{64}$/.test(input.destinationId) || !/^[a-f0-9]{64}$/.test(input.contentHash))
    throw new Error("Invalid managed snapshot identity");
  if (input.side !== "personal" && input.side !== "work")
    throw new Error("Invalid managed snapshot side");
  generation(input.bindingRevision);
  generation(input.lifecycle.actorGeneration);
  assertUuid(input.lifecycle.ownerUserId, "Managed snapshot owner");
  const owner = input.lifecycle.ownerUserId.toLowerCase();
  if (input.lifecycle.sources.length > 2048)
    throw new Error("A managed snapshot permits at most 2048 represented sources");
  const sources = new Map<string, number>();
  for (const entry of input.lifecycle.sources) {
    if (entry.source.ownerUserId.toLowerCase() !== owner)
      throw new Error("Managed snapshot sources require the same owner");
    assertUuid(entry.source.sourceId, "Managed snapshot source");
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entry.source.sourceModuleId))
      throw new Error("Invalid managed snapshot module");
    generation(entry.generation);
    const key = JSON.stringify([entry.source.sourceModuleId, entry.source.sourceId.toLowerCase()]);
    const existing = sources.get(key);
    if (existing !== undefined && existing !== entry.generation)
      throw new Error("A managed source cannot have conflicting generations");
    sources.set(key, entry.generation);
  }
  return createHash("sha256")
    .update("moss:managed-note-snapshot:v1\0")
    .update(
      JSON.stringify([
        owner,
        input.destinationId,
        input.contentHash,
        input.bindingRevision,
        input.side,
        input.lifecycle.actorGeneration,
        [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      ])
    )
    .digest("hex");
}
