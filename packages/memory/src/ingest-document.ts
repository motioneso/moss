import { createHash } from "node:crypto";
import type { DataContextDb } from "@moss/db";
import { readVaultFile, type VaultContext } from "@moss/vault";
import { embedChunks } from "./embed-chunks.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { parseDocument } from "./parser.js";
import type { MemoryRepository } from "./repository.js";
import type { VaultIndexPublicationPort } from "./vault-index-publication.js";

export interface VaultDocumentIngestOptions {
  readonly sourceKind: "vault" | "notes";
  readonly sourcePath: string;
  readonly force?: boolean;
  readonly chunkOffset?: number;
  readonly chunkLimit?: number;
  readonly expectedFileHash?: string;
  readonly expectedSnapshotKey?: string;
}
export interface VaultDocumentIngestResult {
  readonly status: "ingested" | "skipped";
  readonly chunksProcessed: number;
  readonly continuation?: {
    readonly chunkOffset: number;
    readonly fileHash: string;
    readonly snapshotKey?: string;
  };
}

/** One file per scoped transaction. Embedding precedes final actor/source/destination admission. */
export async function ingestVaultDocument(
  db: DataContextDb,
  ctx: VaultContext,
  path: string,
  options: VaultDocumentIngestOptions,
  dependencies: {
    readonly repository: MemoryRepository;
    readonly embeddingProvider: EmbeddingProvider;
    readonly publication?: VaultIndexPublicationPort;
  }
): Promise<VaultDocumentIngestResult> {
  const { repository, embeddingProvider, publication } = dependencies;
  const content = await readVaultFile(ctx, path);
  const captured = publication ? await publication.captureScoped(db, ctx, path, content) : null;
  if (captured?.status === "blocked") return { status: "skipped", chunksProcessed: 0 };
  const snapshot = captured?.status === "ready" ? captured.snapshot : null;
  const fileHash = createHash("sha256").update(content).digest("hex");
  let offset =
    options.expectedFileHash === fileHash &&
    (options.expectedSnapshotKey ?? null) === (snapshot?.key ?? null)
      ? (options.chunkOffset ?? 0)
      : 0;
  const limit = options.chunkLimit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Invalid document ingest checkpoint");
  const existing = await repository.getFileIndex(
    db,
    ctx.actorUserId,
    options.sourceKind,
    options.sourcePath
  );
  if (
    !options.force &&
    offset === 0 &&
    existing?.fileHash === fileHash &&
    existing.embedModelName === embeddingProvider.modelName &&
    (existing.managedSnapshot?.key ?? null) === (snapshot?.key ?? null)
  )
    return { status: "skipped", chunksProcessed: 0 };
  const { chunks, wikilinks } = parseDocument(content);
  const progress = () =>
    repository.fileChunkCheckpoint(
      db,
      ctx.actorUserId,
      options.sourceKind,
      options.sourcePath,
      snapshot!.key,
      embeddingProvider.modelName,
      embeddingProvider.modelVersion
    );
  if (snapshot && !options.force) {
    // Persisted labelled chunks are the checkpoint authority, including a retried first page.
    const current = await progress();
    offset = current !== null && current <= chunks.length ? current : 0;
  }
  const end = Math.min(offset + limit, chunks.length);
  if (offset > chunks.length)
    throw new Error("Document ingest checkpoint exceeds current document");
  const embedded = await embedChunks(
    embeddingProvider,
    chunks.slice(offset, end),
    options.sourcePath
  );
  const publish = async (): Promise<VaultDocumentIngestResult> => {
    if (snapshot && !options.force) {
      const current = await progress();
      if ((current ?? 0) !== offset) {
        if (current === chunks.length) return { status: "skipped", chunksProcessed: 0 };
        return {
          status: "ingested",
          chunksProcessed: 0,
          continuation: { chunkOffset: current ?? 0, fileHash, snapshotKey: snapshot.key }
        };
      }
    }
    await repository.upsertFileChunks(
      db,
      ctx.actorUserId,
      options.sourcePath,
      embedded,
      embeddingProvider.modelName,
      embeddingProvider.modelVersion,
      options.sourceKind,
      offset === 0,
      snapshot
    );
    if (offset === 0)
      await repository.deleteFileIndex(db, ctx.actorUserId, options.sourceKind, options.sourcePath);
    if (end < chunks.length)
      return {
        status: "ingested",
        chunksProcessed: embedded.length,
        continuation: {
          chunkOffset: end,
          fileHash,
          ...(snapshot ? { snapshotKey: snapshot.key } : {})
        }
      };
    await repository.replaceFileLinks(db, ctx.actorUserId, options.sourcePath, wikilinks);
    await repository.upsertFileIndex(
      db,
      ctx.actorUserId,
      options.sourceKind,
      options.sourcePath,
      fileHash,
      chunks.length,
      embeddingProvider.modelName,
      embeddingProvider.modelVersion,
      snapshot
    );
    return { status: "ingested", chunksProcessed: embedded.length };
  };
  if (publication && snapshot) {
    const result = await publication.publishScoped(db, ctx, path, snapshot, publish);
    return result.status === "published" ? result.value : { status: "skipped", chunksProcessed: 0 };
  }
  return publish();
}
