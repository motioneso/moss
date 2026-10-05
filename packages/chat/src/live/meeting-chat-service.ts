import type { AccessContext } from "@moss/db";
import type { ProviderKind } from "@moss/ai";
import {
  meetingChatSurface,
  type AnswerSourceSupportCard,
  type ChatSurface,
  type MeetingChatSelection,
  type MeetingChatTurnResponse,
  type StoredMeetingChatContext
} from "@moss/shared";
import { parseAnswerMarkers } from "./answer-provenance.js";
import type { MeetingContextService } from "./meeting-context.js";

export class MeetingChatError extends Error {
  constructor(
    readonly code: "meeting_chat_unsupported" | "meeting_chat_changed" | "meeting_chat_failed",
    message: string
  ) {
    super(message);
    this.name = "MeetingChatError";
  }
}

export interface MeetingChatGeneration {
  readonly provider: ProviderKind;
  readonly model: string;
  /** Re-resolve the selected route and credential status; fail closed if it changed. */
  assertCurrent(): Promise<void>;
  run(question: string, evidence: string, signal: AbortSignal): Promise<string>;
}

export interface MeetingChatServiceDeps {
  readonly context: MeetingContextService;
  prepareGeneration(access: AccessContext): Promise<MeetingChatGeneration>;
  captureThread(access: AccessContext, surface: ChatSurface): Promise<string>;
  save(
    access: AccessContext,
    threadId: string,
    surface: ChatSurface,
    question: string,
    answer: string,
    execution: { readonly provider: ProviderKind; readonly model: string },
    context: StoredMeetingChatContext
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string }>;
}

export function meetingSourceCards(context: StoredMeetingChatContext): AnswerSourceSupportCard[] {
  return context.citations.map((citation) => ({
    supportId: citation.supportId,
    sourceKind: "meeting",
    sourceLabel: `${Math.floor(citation.startMs / 60_000)}:${String(Math.floor(citation.startMs / 1000) % 60).padStart(2, "0")}${citation.finality === "provisional" ? " (provisional)" : ""}`,
    title: `Transcript revision ${citation.segmentRevision}`,
    state: "unverified_context",
    canDereference: true
  }));
}

/** Uses the shared chat's persistence/DTOs, but never launches or seeds a tool-capable engine. */
export class MeetingChatService {
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly deps: MeetingChatServiceDeps) {}

  cancel(actorUserId: string, surface: ChatSurface): void {
    this.running.get(`${actorUserId}:${surface}`)?.abort();
  }

  async submit(
    access: AccessContext,
    surface: ChatSurface,
    selection: MeetingChatSelection,
    question: string
  ): Promise<MeetingChatTurnResponse> {
    if (surface !== meetingChatSurface(selection.meetingId))
      throw new MeetingChatError("meeting_chat_changed", "The selected meeting changed.");
    const key = `${access.actorUserId}:${surface}`;
    if (this.running.has(key))
      throw new MeetingChatError("meeting_chat_changed", "A meeting question is already running.");
    const controller = new AbortController();
    this.running.set(key, controller);
    const assertNotCancelled = () => {
      if (controller.signal.aborted)
        throw new MeetingChatError("meeting_chat_changed", "The meeting question was stopped.");
    };
    try {
      const context = await this.deps.context.bind(access, selection, question);
      if (!context.citations.length)
        throw new MeetingChatError(
          "meeting_chat_failed",
          "No usable transcript evidence fits this question’s size limit."
        );
      const generation = await this.deps.prepareGeneration(access);
      const threadId = await this.deps.captureThread(access, surface);
      await this.deps.context.assertAvailable(access, context);
      await generation.assertCurrent();
      assertNotCancelled();
      const answer = await generation.run(question, context.evidenceBlock, controller.signal);
      assertNotCancelled();
      await this.deps.context.assertAvailable(access, context);
      await generation.assertCurrent();
      assertNotCancelled();
      const stored: StoredMeetingChatContext = {
        ownerUserId: context.ownerUserId,
        coverage: context.coverage,
        citations: context.citations
      };
      const ids = await this.deps.save(
        access,
        threadId,
        surface,
        question,
        answer,
        generation,
        stored
      );
      // No partial output is emitted. A late revocation or cancellation suppresses the HTTP result.
      await this.deps.context.assertAvailable(access, context);
      await generation.assertCurrent();
      assertNotCancelled();
      const cards = meetingSourceCards(stored);
      const valid = new Set(cards.map((card) => card.supportId));
      return {
        ...ids,
        reply: answer,
        meetingContext: context.coverage,
        answerProvenance: cards,
        answerProvenanceCitedIds: parseAnswerMarkers(answer).filter((id) => valid.has(id))
      };
    } finally {
      if (this.running.get(key) === controller) this.running.delete(key);
    }
  }
}
