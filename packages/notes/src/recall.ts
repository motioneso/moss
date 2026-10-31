import { assertDataContextDb, type DataContextRunner } from "@moss/db";
import { RuntimeConfigResolver } from "@moss/settings";
import {
  createEmbeddingProvider,
  getEmbeddingProviderConfig,
  type EmbeddingProviderConfig,
  MemoryRepository,
  MemoryRetriever
} from "@moss/memory";

const NOTES_SOURCE_KIND = "notes";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export interface NotesRecallSnippet {
  readonly sourcePath: string;
  readonly updatedAt: Date;
  readonly score: number;
  readonly text: string;
}

export interface NotesRecallPort {
  /**
   * Opens its own short transactions. The query embedding runs between them, so no
   * connection or row lock is held while the embedding provider is slow.
   */
  recall(
    dataContext: Pick<DataContextRunner, "withDataContext">,
    ownerUserId: string,
    query: string,
    options: { readonly limit?: number }
  ): Promise<{ readonly snippets: readonly NotesRecallSnippet[] }>;
}

let retrieverCache: { key: string; retriever: MemoryRetriever } | undefined;

function embeddingConfigCacheKey(config: EmbeddingProviderConfig): string {
  return `${config.kind}:${config.modelId ?? ""}`;
}

function getRetriever(config: EmbeddingProviderConfig): MemoryRetriever {
  const key = embeddingConfigCacheKey(config);
  if (retrieverCache?.key !== key) {
    retrieverCache = {
      key,
      // #2956: the retriever is shared across actors, so no owner is baked in —
      // baking the first caller's would misattribute every later actor's rows.
      retriever: new MemoryRetriever(
        createEmbeddingProvider(config, process.env, undefined, { source: "notes" }),
        new MemoryRepository()
      )
    };
  }
  return retrieverCache.retriever;
}

export function createNotesRecallPort(): NotesRecallPort {
  return {
    async recall(dataContext, ownerUserId, query, options) {
      const parsedLimit = Number(options.limit);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(Math.trunc(parsedLimit), 1), MAX_LIMIT)
        : DEFAULT_LIMIT;
      const ctx = { actorUserId: ownerUserId, requestId: "notes:recall" };

      const config = await dataContext.withDataContext(ctx, (scopedDb) => {
        assertDataContextDb(scopedDb);
        return getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb));
      });
      const retriever = getRetriever(config);
      const queryEmbedding = await retriever.embedQuery(query);
      const chunks = await dataContext.withDataContext(ctx, (scopedDb) => {
        assertDataContextDb(scopedDb);
        return retriever.searchByEmbedding(scopedDb, queryEmbedding, limit, NOTES_SOURCE_KIND);
      });
      return {
        snippets: chunks.map((c) => ({
          sourcePath: c.sourcePath,
          updatedAt: c.updatedAt,
          score: c.similarity,
          text: c.text
        }))
      };
    }
  };
}
