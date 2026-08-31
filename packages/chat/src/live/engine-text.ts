/**
 * Build the engine-bound text for one turn: folds passive-retrieval / cross-tool-reasoning
 * hidden context ahead of the raw user text. Extracted from ChatSessionManager so the
 * (already substantial) retrieval orchestration lives in its own module rather than
 * growing the manager class further.
 */
import type { AnswerSourceSupport, ChatSurface } from "@moss/shared";
import type { MemoryRecallItem } from "@moss/memory";
import type { PriorityModelPreferenceV1 } from "@moss/priority";

import {
  crossToolItemToSupport,
  memoryItemToSupport,
  notesItemToSupport
} from "./answer-provenance.js";
import type { ChatPersistencePort, PassiveRetrievalPort } from "./chat-session-manager.js";
import {
  collectCrossToolContextAndItems,
  planCrossToolReasoning,
  renderCrossToolContextBlock,
  type CrossToolReadRunner
} from "./cross-tool-reasoning.js";
import { rankChatContext, reorderByPriority } from "../priority-consumer.js";
import { combineHiddenContextBlocks } from "./chat-session-manager.js";
import type { NotesContextRetriever } from "./notes-retrieval.js";
import { renderCurrentTimeContext } from "./time-context.js";

export interface EngineTextDeps {
  readonly persistence: Pick<ChatPersistencePort, "listPriorTurns" | "getThreadContext">;
  readonly passiveRetrieval?: PassiveRetrievalPort;
  readonly notesRetrieval?: Pick<NotesContextRetriever, "retrieveWithItems">;
  readonly crossToolRead?: CrossToolReadRunner;
  readonly priorityModel?: { getModel(actorUserId: string): Promise<PriorityModelPreferenceV1> };
  /** Injectable clock (defaults to wall-clock `new Date()`); tests drive it deterministically. */
  readonly now?: () => Date;
}

export async function buildEngineText(
  deps: EngineTextDeps,
  actorUserId: string,
  text: string,
  surface?: ChatSurface
): Promise<{ text: string; pendingItems: AnswerSourceSupport[] }> {
  const instant = deps.now?.() ?? new Date();

  if (!deps.passiveRetrieval && !deps.crossToolRead && !deps.notesRetrieval) {
    let timezone: string | null = null;
    try {
      const threadCtx = await deps.persistence.getThreadContext(actorUserId, surface);
      timezone = threadCtx.localTimezone;
    } catch {
      timezone = null;
    }
    const timeBlock = renderCurrentTimeContext(instant, timezone);
    return { text: `${timeBlock}\n\n${text}`, pendingItems: [] };
  }
  try {
    const [{ recent }, threadCtx] = await Promise.all([
      deps.persistence.listPriorTurns(actorUserId, undefined, surface),
      deps.persistence.getThreadContext(actorUserId, surface)
    ]);

    const timeBlock = renderCurrentTimeContext(instant, threadCtx.localTimezone);
    const localNow = instant.toISOString();
    const plan =
      deps.crossToolRead != null
        ? planCrossToolReasoning({
            userText: text,
            threadTitle: threadCtx.threadTitle,
            recentTurns: recent,
            localNowIso: localNow,
            localTimezone: threadCtx.localTimezone ?? "UTC"
          })
        : null;
    const crossToolPlan =
      plan != null && deps.notesRetrieval != null
        ? { ...plan, sources: plan.sources.filter((source) => source !== "notes") }
        : plan;

    const [passiveResult, crossToolResult, notesResult] = await Promise.all([
      deps.passiveRetrieval != null
        ? (deps.passiveRetrieval.retrieveWithItems != null
            ? deps.passiveRetrieval.retrieveWithItems({
                actorUserId,
                userText: text,
                threadTitle: threadCtx.threadTitle,
                recentTurns: recent
              })
            : deps.passiveRetrieval
                .retrieve({
                  actorUserId,
                  userText: text,
                  threadTitle: threadCtx.threadTitle,
                  recentTurns: recent
                })
                .then((block) => ({ block, items: [] as MemoryRecallItem[] }))
          ).catch(() => ({ block: "", items: [] as MemoryRecallItem[] }))
        : Promise.resolve({ block: "", items: [] as MemoryRecallItem[] }),
      crossToolPlan != null && deps.crossToolRead != null
        ? collectCrossToolContextAndItems(
            actorUserId,
            crossToolPlan,
            deps.crossToolRead,
            localNow,
            threadCtx.localTimezone ?? "UTC"
          ).catch(() => ({ block: "", items: [] }))
        : Promise.resolve({ block: "", items: [] }),
      deps.notesRetrieval != null
        ? deps.notesRetrieval
            .retrieveWithItems({
              actorUserId,
              userText: text,
              threadTitle: threadCtx.threadTitle,
              recentTurns: recent,
              incognito: threadCtx.incognito
            })
            .catch(() => ({ block: "", items: [] }))
        : Promise.resolve({ block: "", items: [] })
    ]);

    let crossTool = crossToolResult;
    if (deps.priorityModel && crossTool.items.length > 0) {
      try {
        const model = await deps.priorityModel.getModel(actorUserId);
        const ranked = rankChatContext(
          crossTool.items.map(({ source, title, summary, dueAt, startsAt }) => ({
            source,
            title,
            summary,
            dueAt,
            startsAt,
            textForAnchorMatch: [title, summary]
          })),
          model,
          localNow,
          threadCtx.localTimezone ?? "UTC"
        );
        const reordered = reorderByPriority(crossTool.items, ranked);
        crossTool = { block: renderCrossToolContextBlock(reordered), items: reordered };
      } catch {
        crossTool = crossToolResult;
      }
    }

    let idx = 0;
    const memoryItems = passiveResult.items.map((item) => memoryItemToSupport(item, idx++));
    const crossToolItems = crossTool.items.map((item) => crossToolItemToSupport(item, idx++));
    const notesItems = notesResult.items.map((item) => notesItemToSupport(item, idx++));
    const pendingItems: AnswerSourceSupport[] = [...memoryItems, ...crossToolItems, ...notesItems];

    const combined = combineHiddenContextBlocks(
      passiveResult.block,
      crossTool.block,
      notesResult.block
    );
    const bodyText = combined ? `${combined}\n\n${text}` : text;
    return { text: `${timeBlock}\n\n${bodyText}`, pendingItems };
  } catch {
    const timeBlock = renderCurrentTimeContext(instant, null);
    return { text: `${timeBlock}\n\n${text}`, pendingItems: [] };
  }
}
