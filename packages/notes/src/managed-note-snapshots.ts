import { createHash } from "node:crypto";
import {
  assertDataContextDb,
  lockManagedActor,
  readScopedActorUserId,
  type DataContextDb
} from "@moss/db";
import {
  assertVaultContext,
  canonicalizeAsFarAsExists,
  mutateVaultFiles,
  resolveVaultPath,
  VaultMutationConflictError,
  type VaultContext
} from "@moss/vault";
import { sql } from "kysely";
import type {
  VaultIndexCapture,
  VaultIndexPublicationPort,
  VaultIndexPublicationResult,
  VaultIndexSnapshot
} from "@moss/memory";
import { noteDestinationId } from "./contribution-destinations.js";
import { RecordingContributionRepository } from "./contribution-repository.js";
import { NoteContributionConflictError } from "./contribution-state.js";
import type { ManagedSourceLifecycle } from "./managed-source-lifecycle.js";
import {
  ManagedSourceFencedError,
  ManagedSourceUnavailableError,
  type ManagedSourceSnapshot
} from "./managed-source-lifecycle.js";
import { managedNoteSnapshotKey } from "./managed-note-snapshot-key.js";
import { inspectRecordingNoteBlock } from "./recording-note-blocks.js";

interface SourceRow {
  readonly receiptId: string;
  readonly side: "personal" | "work";
  readonly sourceModuleId: string;
  readonly sourceId: string;
  readonly representedGeneration: number;
  readonly generation: number;
  readonly state: "active" | "deleting" | "sealed";
  readonly blockBytes: string;
}

/** Final comparison includes every represented receipt, including additions after initial capture. */
export class ManagedNoteSnapshotService implements VaultIndexPublicationPort {
  private readonly repository = new RecordingContributionRepository();
  private readonly published = new WeakSet<DataContextDb>();
  constructor(private readonly lifecycle: ManagedSourceLifecycle) {}

  async captureScoped(
    db: DataContextDb,
    ctx: VaultContext,
    path: string,
    content: string
  ): Promise<VaultIndexCapture> {
    if (this.published.has(db))
      throw new Error(
        "Vault indexing requires one file per DataContext; provider work cannot follow publication locks"
      );
    return this.captureCurrent(db, ctx, path, content);
  }

  private async captureCurrent(
    db: DataContextDb,
    ctx: VaultContext,
    path: string,
    content: string
  ): Promise<VaultIndexCapture> {
    assertDataContextDb(db);
    assertVaultContext(ctx);
    const owner = await readScopedActorUserId(db);
    if (!owner || owner.toLowerCase() !== ctx.actorUserId.toLowerCase())
      return { status: "blocked", reason: "unavailable" };
    const canonical = await canonicalizeAsFarAsExists(resolveVaultPath(ctx.vaultRoot, path));
    const destinationId = noteDestinationId(canonical);
    if (!(await this.repository.available(db, destinationId)))
      return { status: "blocked", reason: "unavailable" };
    const actor = (
      await sql<{
        generation: number;
        state: string;
      }>`select generation,state from app.notes_managed_actors`.execute(db.db)
    ).rows[0];
    if (actor && actor.state !== "active") return { status: "blocked", reason: "unavailable" };
    const binding = await this.repository.binding(db, destinationId);
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (!binding) {
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            "moss:unmanaged-vault-snapshot:v1",
            owner.toLowerCase(),
            destinationId,
            contentHash
          ])
        )
        .digest("hex");
      return {
        status: "ready",
        snapshot: {
          ownerUserId: owner.toLowerCase(),
          destinationId,
          contentHash,
          key,
          side: null,
          bindingRevision: null,
          actorGeneration: null,
          sources: []
        }
      };
    }
    if (!actor) return { status: "blocked", reason: "unavailable" };
    const pending = await sql<{ pending: boolean }>`select exists (
      select 1 from app.notes_contribution_operations where state in ('pending','conflict')
        and ${destinationId}=any(destination_ids)
    ) as pending`.execute(db.db);
    if (pending.rows[0]!.pending) return { status: "blocked", reason: "pending" };
    const result = await sql<SourceRow>`
      select contribution.receipt_id as "receiptId",contribution.side,contribution.source_module_id as "sourceModuleId",
        contribution.source_id as "sourceId",contribution.source_generation as "representedGeneration",
        source.generation,source.state,contribution.block_bytes as "blockBytes"
      from app.notes_recording_contributions contribution
      join app.notes_managed_sources source using (owner_user_id,source_module_id,source_id)
      where contribution.destination_id=${destinationId} and contribution.state='applied'
      order by contribution.source_module_id,contribution.source_id,contribution.receipt_id
    `.execute(db.db);
    const sources = new Map<string, SourceRow>();
    for (const row of result.rows) {
      if (
        row.side !== binding.side ||
        row.state !== "active" ||
        row.representedGeneration !== row.generation ||
        inspectRecordingNoteBlock(content, { id: row.receiptId, bytes: row.blockBytes }) !==
          "unchanged"
      )
        return { status: "blocked", reason: "source_changed" };
      sources.set(JSON.stringify([row.sourceModuleId, row.sourceId]), row);
    }
    const represented = [...sources.values()].map((row) => ({
      sourceModuleId: row.sourceModuleId,
      sourceId: row.sourceId,
      generation: row.generation
    }));
    const lifecycle: ManagedSourceSnapshot = {
      ownerUserId: owner.toLowerCase(),
      actorGeneration: actor.generation,
      sources: represented.map((entry) => ({
        source: {
          ownerUserId: owner.toLowerCase(),
          sourceModuleId: entry.sourceModuleId,
          sourceId: entry.sourceId
        },
        generation: entry.generation
      }))
    };
    const key = managedNoteSnapshotKey({
      destinationId,
      contentHash,
      bindingRevision: binding.revision,
      side: binding.side,
      lifecycle
    });
    return {
      status: "ready",
      snapshot: {
        ownerUserId: lifecycle.ownerUserId,
        destinationId,
        contentHash,
        key,
        side: binding.side,
        bindingRevision: binding.revision,
        actorGeneration: actor.generation,
        sources: represented
      }
    };
  }

  async publishScoped<T>(
    db: DataContextDb,
    ctx: VaultContext,
    path: string,
    expected: VaultIndexSnapshot,
    work: (authoritative: VaultIndexSnapshot) => Promise<T>
  ): Promise<VaultIndexPublicationResult<T>> {
    this.published.add(db);
    const publish = async (): Promise<VaultIndexPublicationResult<T>> =>
      mutateVaultFiles<VaultIndexPublicationResult<T>>(db, ctx, [path], async ([file]) => {
        if (!file || noteDestinationId(file.canonicalPath) !== expected.destinationId)
          return { changes: [], result: { status: "stale" } };
        const current = await this.captureCurrent(db, ctx, path, file.content ?? "");
        if (
          current.status !== "ready" ||
          current.snapshot.key !== expected.key ||
          current.snapshot.ownerUserId !== expected.ownerUserId ||
          current.snapshot.side !== expected.side
        )
          return { changes: [], result: { status: "stale" } };
        return {
          changes: [],
          result: { status: "published", value: await work(current.snapshot) }
        };
      });
    try {
      if (expected.side === null) {
        await lockManagedActor(db, ctx.actorUserId, "shared");
        return await publish();
      }
      if (expected.actorGeneration === null || expected.bindingRevision === null)
        return { status: "stale" };
      const lifecycle: ManagedSourceSnapshot = {
        ownerUserId: expected.ownerUserId,
        actorGeneration: expected.actorGeneration,
        sources: expected.sources.map((entry) => ({
          source: {
            ownerUserId: expected.ownerUserId,
            sourceModuleId: entry.sourceModuleId,
            sourceId: entry.sourceId
          },
          generation: entry.generation
        }))
      };
      if (
        managedNoteSnapshotKey({
          destinationId: expected.destinationId,
          contentHash: expected.contentHash,
          bindingRevision: expected.bindingRevision,
          side: expected.side,
          lifecycle
        }) !== expected.key
      )
        return { status: "stale" };
      if (!lifecycle.sources.length)
        return await this.lifecycle.withActorPublicationScoped(db, lifecycle, publish);
      return await this.lifecycle.withPublicationScoped(db, lifecycle, publish);
    } catch (error) {
      if (
        error instanceof ManagedSourceFencedError ||
        error instanceof ManagedSourceUnavailableError ||
        error instanceof NoteContributionConflictError ||
        error instanceof VaultMutationConflictError
      )
        return { status: "stale" };
      throw error;
    }
  }
}
