import { assertDataContextDb, type DataContextDb } from "@moss/db";
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
  recall(
    scopedDb: DataContextDb,
    ownerUserId: string,
    query: string,
    options: { readonly limit?: number }
  ): Promise<{ readonly snippets: readonly NotesRecallSnippet[] }>;
}

let retrieverCache: { key: string; retriever: MemoryRetriever } | undefined;

function embeddingConfigCacheKey(config: EmbeddingProviderConfig): string {
  return `${config.kind}:${config.modelId ?? ""}`;
}

async function getRetriever(scopedDb: DataContextDb): Promise<MemoryRetriever> {
  const config = await getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb));
  const key = embeddingConfigCacheKey(config);
  if (retrieverCache?.key !== key) {
    retrieverCache = {
      key,
      retriever: new MemoryRetriever(createEmbeddingProvider(config), new MemoryRepository())
    };
  }
  return retrieverCache.retriever;
}

export function createNotesRecallPort(): NotesRecallPort {
  return {
    async recall(scopedDb, _ownerUserId, query, options) {
      assertDataContextDb(scopedDb);
      const parsedLimit = Number(options.limit);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(Math.trunc(parsedLimit), 1), MAX_LIMIT)
        : DEFAULT_LIMIT;

      const retriever = await getRetriever(scopedDb);
      const chunks = await retriever.retrieve(scopedDb, query, limit, NOTES_SOURCE_KIND);
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
