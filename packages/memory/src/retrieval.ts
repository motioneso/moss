import type { DataContextDb } from "@moss/db";

import type { EmbeddingProvider } from "./embedding-provider.js";
import type { MemoryRepository, RetrievedChunk } from "./repository.js";

export class MemoryRetriever {
  constructor(
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly repository: MemoryRepository
  ) {}

  async retrieve(
    scopedDb: DataContextDb,
    query: string,
    limit: number = 10,
    sourceKind: string = "vault"
  ): Promise<RetrievedChunk[]> {
    const queryEmbedding = await this.embedQuery(query);
    return this.searchByEmbedding(scopedDb, queryEmbedding, limit, sourceKind);
  }

  /** Embeds without a database handle, so callers can embed outside any transaction. */
  embedQuery(query: string): Promise<number[]> {
    return this.embeddingProvider.embedQuery(query);
  }

  searchByEmbedding(
    scopedDb: DataContextDb,
    queryEmbedding: number[],
    limit: number = 10,
    sourceKind: string = "vault"
  ): Promise<RetrievedChunk[]> {
    return this.repository.vectorSearch(scopedDb, queryEmbedding, limit, sourceKind);
  }

  /**
   * Recency-ordered retrieval (no query embedding). Used by the briefing's hybrid
   * vault grounding (semantic ∪ recency) so the most recently ingested notes are
   * surfaced even when no query matches them semantically.
   */
  async retrieveRecent(
    scopedDb: DataContextDb,
    limit: number = 10,
    sourceKind: string = "vault"
  ): Promise<RetrievedChunk[]> {
    return this.repository.listRecentChunks(scopedDb, limit, sourceKind);
  }
}
