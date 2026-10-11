/**
 * Build the engine-bound text for one turn: folds passive-retrieval / cross-tool-reasoning
 * hidden context ahead of the raw user text. Extracted from ChatSessionManager so the
 * (already substantial) retrieval orchestration lives in its own module rather than
 * growing the manager class further.
 */
import type { ConversationProvenancePort } from "@moss/ai";
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
  type CrossToolReadRunner,
  type CrossToolTurnBinding
} from "./cross-tool-reasoning.js";
import { rankChatContext, reorderByPriority } from "../priority-consumer.js";
import {
  admissionForActor,
  admitToContext,
  prepareTurnText,
  type AdmittedContext,
  type PreparedTurn
} from "./context-admission.js";
import type { NotesContextRetriever } from "./notes-retrieval.js";
import { renderCurrentTimeContext } from "./time-context.js";

export interface EngineTextDeps {
  readonly persistence: Pick<ChatPersistencePort, "listPriorTurns" | "getThreadContext">;
  readonly conversationProvenance?: Pick<ConversationProvenancePort, "recordAdmission">;
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
  surface?: ChatSurface,
  binding?: CrossToolTurnBinding,
  extra?: {
    readonly attachmentManifest?: string;
    readonly moduleControl?: AdmittedContext | null;
    readonly mainReminders?: AdmittedContext | null;
  }
): Promise<PreparedTurn & { pendingItems: AnswerSourceSupport[] }> {
  const turnBinding = binding
    ? Object.freeze({ threadId: binding.threadId, chatSessionId: binding.chatSessionId })
    : undefined;
  const context = await retrieveTurnContext(deps, actorUserId, text, surface, turnBinding);
  const admission = admissionForActor(deps.conversationProvenance, actorUserId);
  // Retrieval can degrade to no context. Admission failures cannot degrade to exposing the block.
  const [passive, crossTool, notes] = await Promise.all([
    admitToContext(admission, turnBinding?.threadId ?? null, "recall_memory_turn", context.passive),
    admitToContext(
      admission,
      turnBinding?.threadId ?? null,
      "recall_cross_tool",
      context.crossTool
    ),
    admitToContext(admission, turnBinding?.threadId ?? null, "recall_notes", context.notes)
  ]);
  return {
    ...prepareTurnText({
      userText: text,
      timeContext: context.timeContext,
      passive,
      crossTool,
      notes,
      ...extra
    }),
    pendingItems: context.pendingItems
  };
}

async function retrieveTurnContext(
  deps: EngineTextDeps,
  actorUserId: string,
  text: string,
  surface: ChatSurface | undefined,
  binding: CrossToolTurnBinding | undefined
): Promise<{
  timeContext: string;
  passive: string;
  crossTool: string;
  notes: string;
  pendingItems: AnswerSourceSupport[];
}> {
  const empty = { passive: "", crossTool: "", notes: "", pendingItems: [] };
  const instant = deps.now?.() ?? new Date();
  let timezone: string | null = null;

  if (!deps.passiveRetrieval && !deps.crossToolRead && !deps.notesRetrieval) {
    try {
      const threadCtx = await deps.persistence.getThreadContext(
        actorUserId,
        surface,
        binding?.threadId ?? null
      );
      timezone = threadCtx.localTimezone;
    } catch {
      // keep the null default — no timezone context available
    }
    const timeBlock = renderCurrentTimeContext(instant, timezone);
    return { ...empty, timeContext: timeBlock };
  }
  try {
    const [{ recent }, threadCtx] = await Promise.all([
      deps.persistence.listPriorTurns(
        actorUserId,
        { threadId: binding?.threadId ?? null },
        surface
      ),
      deps.persistence
        .getThreadContext(actorUserId, surface, binding?.threadId ?? null)
        .then((context) => {
          timezone = context.localTimezone;
          return context;
        })
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
            threadCtx.localTimezone ?? "UTC",
            binding
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

    return {
      timeContext: timeBlock,
      passive: passiveResult.block,
      crossTool: crossTool.block,
      notes: notesResult.block,
      pendingItems
    };
  } catch {
    const timeBlock = renderCurrentTimeContext(instant, timezone);
    return { ...empty, timeContext: timeBlock };
  }
}
