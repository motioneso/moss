import type { DataContextDb, DataContextRunner } from "@moss/db";
import type { NotesRecallPort, NotesRecallSnippet } from "@moss/notes";

import { ChatUserMemorySettingsRepository } from "../memory-settings-repository.js";
import type { UserMemorySettings } from "../memory-settings-repository.js";
import { renderNotesContextBlock } from "./chat-context-blocks.js";
import { isCredentialShaped } from "./notes-secret-filter.js";
import { estimateTokens } from "./recall-seed.js";
import { planPassiveRetrieval, withPassiveRetrievalTimeout } from "./passive-retrieval.js";

const NOTES_TIMEOUT_MS = 500;
const NOTES_RECALL_LIMIT = 8;
const MAX_NOTES_ITEMS = 5;
const MAX_NOTES_TOKENS = 2000;

export interface NotesContextRetrieverDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly notesRecall: NotesRecallPort;
  readonly settingsRepo?: {
    getOrCreate(scopedDb: DataContextDb, userId: string): Promise<UserMemorySettings>;
  };
}

export interface NotesContextRetrieverInput {
  readonly actorUserId: string;
  readonly userText: string;
  readonly threadTitle: string | null;
  readonly recentTurns: readonly { role: "user" | "assistant"; content: string }[];
  readonly incognito: boolean;
}

export class NotesContextRetriever {
  private readonly settingsRepo;

  constructor(private readonly deps: NotesContextRetrieverDeps) {
    this.settingsRepo = deps.settingsRepo ?? new ChatUserMemorySettingsRepository();
  }

  async retrieveWithItems(
    input: NotesContextRetrieverInput
  ): Promise<{ block: string; items: readonly NotesRecallSnippet[] }> {
    if (input.incognito) return { block: "", items: [] };

    try {
      return (
        (await withPassiveRetrievalTimeout(this.retrieveNowWithItems(input), NOTES_TIMEOUT_MS)) ?? {
          block: "",
          items: []
        }
      );
    } catch {
      console.warn(
        JSON.stringify({ event: "chat.notes.retrieval-failed", actorUserId: input.actorUserId })
      );
      return { block: "", items: [] };
    }
  }

  private async retrieveNowWithItems(
    input: NotesContextRetrieverInput
  ): Promise<{ block: string; items: readonly NotesRecallSnippet[] }> {
    const decision = planPassiveRetrieval(input);
    if (!decision.shouldRetrieve) return { block: "", items: [] };

    return this.deps.dataContext.withDataContext(
      { actorUserId: input.actorUserId, requestId: "chat:notes-context-retrieval" },
      async (scopedDb) => {
        const settings = await this.settingsRepo.getOrCreate(scopedDb, input.actorUserId);
        if (!settings.recallEnabled) return { block: "", items: [] };

        const result = await this.deps.notesRecall.recall(
          scopedDb,
          input.actorUserId,
          decision.query,
          { limit: NOTES_RECALL_LIMIT }
        );

        const safe = result.snippets.filter((snippet) => {
          if (isCredentialShaped(snippet.text) || isCredentialShaped(snippet.sourcePath)) {
            console.warn(
              JSON.stringify({
                event: "chat.notes.credential-shaped-dropped"
              })
            );
            return false;
          }
          return true;
        });

        const items = capItems([...safe].sort((a, b) => b.score - a.score));
        const block = renderNotesContextBlock(items);
        return { block, items };
      }
    );
  }
}

function capItems(sorted: readonly NotesRecallSnippet[]): readonly NotesRecallSnippet[] {
  const kept: NotesRecallSnippet[] = [];
  let usedTokens = 0;
  for (const snippet of sorted) {
    if (kept.length >= MAX_NOTES_ITEMS) break;
    const tokens = estimateTokens(snippet.text);
    if (usedTokens + tokens > MAX_NOTES_TOKENS) break;
    kept.push(snippet);
    usedTokens += tokens;
  }
  return kept;
}
