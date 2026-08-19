/**
 * Persistence + passive-retrieval port interfaces for ChatSessionManager, split out of
 * chat-session-manager.ts (#1157) to keep that file under the repo's 1000-line cap. All
 * names are re-exported from chat-session-manager.ts so existing import paths keep working.
 */

import type { ProviderKind } from "@moss/ai";
import type {
  AnswerProvenanceMetadataV1,
  AiProviderExecutionMode,
  ChatAttachmentDto,
  ChatSurface,
  SourceFreshnessV1
} from "@moss/shared";
import type { MemoryRecallItem } from "@moss/memory";
import type { ActionResultMetadata } from "./types.js";

export interface PrivateThreadState {
  readonly actorUserId: string;
  readonly threadId: string;
  readonly surface?: ChatSurface;
}

export interface ChatPersistencePort {
  /** The active "chat" provider+model for this user (router-selected). */
  resolveActiveProvider(
    actorUserId: string
  ): Promise<{ provider: ProviderKind; model: string; executionMode?: AiProviderExecutionMode }>;
  /** Prior stored turns split into recent verbatim turns + older rolling summary. */
  listPriorTurns(
    actorUserId: string,
    opts?: { readonly forceReplay?: boolean },
    surface?: ChatSurface
  ): Promise<{
    recent: readonly { role: "user" | "assistant"; content: string }[];
    oldSummary: string | null;
  }>;
  /** Persist a completed turn (user text + assistant reply + executing provider/model). */
  recordTurn(
    actorUserId: string,
    userText: string,
    assistantReply: string,
    executed: { provider: ProviderKind; model: string },
    opts?: {
      readonly invokedToolNames?: ReadonlySet<string>;
      readonly answerProvenance?: AnswerProvenanceMetadataV1;
      /** #1133 — display metadata for files sent with this turn (user-message tool_metadata). */
      readonly attachments?: readonly ChatAttachmentDto[];
      readonly actionResults?: readonly ActionResultMetadata[];
    },
    surface?: ChatSurface
  ): Promise<
    | {
        readonly userMessageId: string;
        readonly assistantMessageId: string;
        readonly sourceFreshness?: SourceFreshnessV1 | null;
      }
    | undefined
  >;
  /** Close the current conversation and open a fresh one (for /clear). */
  openNewConversation(
    actorUserId: string,
    options?: { incognito?: boolean },
    surface?: ChatSurface
  ): Promise<void>;
  getCurrentThreadState?(
    actorUserId: string,
    surface?: ChatSurface
  ): Promise<{ readonly id: string; readonly incognito: boolean } | undefined>;
  listIncognitoThreadStates?(): Promise<readonly PrivateThreadState[]>;
  deleteThread?(actorUserId: string, threadId: string, surface?: ChatSurface): Promise<void>;
  /** Return the current thread title and the user's persisted timezone (null if unset). */
  getThreadContext(
    actorUserId: string,
    surface?: ChatSurface
  ): Promise<{ threadTitle: string | null; localTimezone: string | null; incognito: boolean }>;
  /**
   * Make threadId the current thread for actorUserId (for resume). Returns true if
   * the thread was found and touched; false if it does not exist or belongs to another user.
   */
  touchExistingThread(
    actorUserId: string,
    threadId: string,
    surface?: ChatSurface
  ): Promise<boolean>;
}

export interface PassiveRetrievalPort {
  retrieve(input: {
    readonly actorUserId: string;
    readonly userText: string;
    readonly threadTitle: string | null;
    readonly recentTurns: readonly { role: "user" | "assistant"; content: string }[];
  }): Promise<string>;
  retrieveWithItems?(input: {
    readonly actorUserId: string;
    readonly userText: string;
    readonly threadTitle: string | null;
    readonly recentTurns: readonly { role: "user" | "assistant"; content: string }[];
  }): Promise<{ block: string; items: MemoryRecallItem[] }>;
}
