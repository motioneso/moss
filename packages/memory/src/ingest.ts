import { listVaultFilesRecursive } from "@moss/vault";
import type { DataContextDb } from "@moss/db";
import type { VaultContext } from "@moss/vault";

import type { EmbeddingProvider } from "./embedding-provider.js";
import type { MemoryRepository } from "./repository.js";

import { ingestVaultDocument } from "./ingest-document.js";
import type { VaultIndexPublicationPort } from "./vault-index-publication.js";

const SOURCE_KIND = "vault";

export type IngestStatus = "ingested" | "skipped";

export interface IngestFileResult {
  readonly status: IngestStatus;
  readonly chunkCount: number;
}

export interface IngestFileOptions {
  readonly force?: boolean;
}

export class MemoryIngestPipeline {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly repository: MemoryRepository,
    private readonly publication?: VaultIndexPublicationPort
  ) {}

  async ingestFile(
    scopedDb: DataContextDb,
    vaultCtx: VaultContext,
    relativePath: string,
    options: IngestFileOptions = {}
  ): Promise<IngestFileResult> {
    const result = await ingestVaultDocument(
      scopedDb,
      vaultCtx,
      relativePath,
      {
        sourceKind: SOURCE_KIND,
        sourcePath: relativePath,
        force: options.force
      },
      {
        repository: this.repository,
        embeddingProvider: this.embeddingProvider,
        publication: this.publication
      }
    );
    return { status: result.status, chunkCount: result.chunksProcessed };
  }

  async deleteFile(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourcePath: string
  ): Promise<void> {
    await this.repository.deleteFileChunks(scopedDb, ownerUserId, sourcePath, SOURCE_KIND);
    await this.repository.replaceFileLinks(scopedDb, ownerUserId, sourcePath, []);
    await this.repository.deleteFileIndex(scopedDb, ownerUserId, SOURCE_KIND, sourcePath);
  }

  async purgeDeletedFiles(
    scopedDb: DataContextDb,
    vaultCtx: VaultContext
  ): Promise<{ deleted: number }> {
    const ownerUserId = vaultCtx.actorUserId;
    const indexed = await this.repository.listIndexedPaths(scopedDb, ownerUserId, SOURCE_KIND);
    const present = new Set(
      (await listVaultFilesRecursive(vaultCtx)).filter((f) => f.endsWith(".md"))
    );

    let deleted = 0;
    for (const path of indexed) {
      if (!present.has(path)) {
        await this.deleteFile(scopedDb, ownerUserId, path);
        deleted += 1;
      }
    }
    return { deleted };
  }

  /** Disaster-recovery: wipe and re-ingest everything for this user. */
  async rebuildFromVault(scopedDb: DataContextDb, vaultCtx: VaultContext): Promise<void> {
    if (this.publication)
      throw new Error(
        "Managed rebuild requires IngestionService with force and one transaction per file"
      );
    await this.repository.deleteAllForUser(scopedDb, vaultCtx.actorUserId);
    const allFiles = await listVaultFilesRecursive(vaultCtx);
    for (const file of allFiles) {
      if (file.endsWith(".md")) {
        await this.ingestFile(scopedDb, vaultCtx, file, { force: true });
      }
    }
  }
}
