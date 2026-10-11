import type { DataContextRunner, PreferencesPort } from "@moss/db";
import {
  ChatMemoryFactsRepository,
  MemoryRepository,
  type EmbeddingProvider,
  type RetrievedChunk
} from "@moss/memory";
import { localDay } from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { ChatUserMemorySettingsRepository } from "./memory-settings-repository.js";
import { readPersonLocale } from "./person-locale.js";
import { ChatRepository } from "./repository.js";
import {
  applyRecencyDecay,
  hybridScore,
  type EpisodicChunk,
  type FactSummary
} from "./live/recall-seed.js";

export interface RecallResult {
  readonly episodicChunks: readonly EpisodicChunk[];
  readonly facts: readonly FactSummary[];
}

/** Port consumed by ChatSessionManager.launchSession. */
export interface RecallPort {
  recall(actorUserId: string): Promise<RecallResult>;
}

const TOP_K_CANDIDATES = 20;
const TOP_K_INJECT = 7;
const MAX_CHARS = 4000;

export class RecallService implements RecallPort {
  constructor(
    private readonly dataContext: DataContextRunner,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly memoryRepo: MemoryRepository = new MemoryRepository(),
    private readonly factsRepo: ChatMemoryFactsRepository = new ChatMemoryFactsRepository(),
    private readonly settingsRepo: ChatUserMemorySettingsRepository = new ChatUserMemorySettingsRepository(),
    private readonly chatRepo: ChatRepository = new ChatRepository(),
    private readonly localePreferences: Pick<PreferencesPort, "get"> = new PreferencesRepository()
  ) {}

  async recall(actorUserId: string): Promise<RecallResult> {
    const accessCtx = { actorUserId, requestId: "recall" };

    const settings = await this.dataContext.withDataContext(accessCtx, (db) =>
      this.settingsRepo.getOrCreate(db, actorUserId)
    );

    if (!settings.recallEnabled) {
      return { episodicChunks: [], facts: [] };
    }

    const [episodicChunks, facts] = await Promise.all([
      this.recallEpisodic(actorUserId, accessCtx),
      settings.factsEnabled
        ? this.dataContext.withDataContext(accessCtx, (db) =>
            this.factsRepo.listActiveFacts(db, actorUserId)
          )
        : Promise.resolve([])
    ]);

    return {
      episodicChunks,
      facts: facts.map((f) => ({ category: f.category, content: f.content }))
    };
  }

  private async recallEpisodic(
    actorUserId: string,
    accessCtx: { actorUserId: string; requestId: string }
  ): Promise<EpisodicChunk[]> {
    const query = "past conversations";
    const queryEmbedding = await this.embeddingProvider.embedQuery(query);

    const candidates: RetrievedChunk[] = await this.dataContext.withDataContext(accessCtx, (db) =>
      this.memoryRepo.vectorSearch(db, queryEmbedding, TOP_K_CANDIDATES, "chat")
    );

    if (candidates.length === 0) return [];

    const threadIds = [...new Set(candidates.map((c) => c.sourcePath))];
    const { threadDates, timeZone } = await this.dataContext.withDataContext(
      accessCtx,
      async (db) => {
        const map = new Map<string, Date>();
        for (const threadId of threadIds) {
          const thread = await this.chatRepo.getThreadById(db, threadId);
          if (thread) map.set(threadId, new Date(thread.last_active_at ?? thread.updated_at));
        }
        const locale = await readPersonLocale(db, this.localePreferences);
        return { threadDates: map, timeZone: locale.timezone };
      }
    );

    const now = Date.now();
    const scored = candidates
      .map((chunk) => {
        const threadDate = threadDates.get(chunk.sourcePath);
        const daysAgo = threadDate ? (now - threadDate.getTime()) / (1000 * 60 * 60 * 24) : 365;
        const score = hybridScore(chunk.similarity, applyRecencyDecay(daysAgo));
        const date = threadDate ? localDay(threadDate, timeZone) : "unknown";
        return { chunk, score, date };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K_INJECT);

    const injected: EpisodicChunk[] = [];
    let charCount = 0;
    for (const { chunk, date, score } of scored) {
      if (charCount + chunk.text.length > MAX_CHARS) break;
      injected.push({ text: chunk.text, date, threadId: chunk.sourcePath, hybridScore: score });
      charCount += chunk.text.length;
    }

    return injected;
  }
}
