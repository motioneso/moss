import type { ComponentType, ReactNode } from "react";

import type { ChatRecordKind, TranscriptRecord } from "../use-chat-stream";

export type ReactNodeLike = ReactNode;
export type AssistantRecordV1 = TranscriptRecord;

export interface LocalRow {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly content: ReactNodeLike;
}

export interface AssistantSurfaceViewProps {
  /** #1232 — host-bound surface name; absent means the drawer. */
  readonly surface?: string;
  readonly localRows?: readonly LocalRow[];
  readonly activeControl?: ReactNodeLike;
  readonly recordKinds?: readonly ChatRecordKind[];
  readonly composer?: {
    readonly placeholder?: string;
    readonly attachmentLabel?: string;
    readonly uploadAttachment?: (
      file: File
    ) => Promise<{ id: string; fileName: string; sizeBytes: number }>;
    readonly onSubmitText?: (text: string, attachmentIds?: readonly string[]) => "handled" | "send";
  };
  readonly typing?: boolean;
}

export interface AssistantSurfaceHandleV1 {
  readonly Surface: ComponentType<AssistantSurfaceViewProps>;
  seedComposer(draft: string): void;
  submitTurn(input: {
    readonly text: string;
    readonly controlContext?: Record<string, unknown>;
    readonly attachmentIds?: readonly string[];
  }): Promise<void>;
  uploadAttachment(file: File): Promise<{ id: string; fileName: string; sizeBytes: number }>;
  subscribeRecords(
    listener: (records: readonly AssistantRecordV1[]) => void,
    surface?: string
  ): () => void;
  /**
   * #1284 — switch which thread this module owns right now (e.g. the user picked a different
   * profile). `null` releases the claim and returns the handle to the unclaimed state (NOT the
   * drawer — see #1495 below). Call this BEFORE any seedContext/submitTurn on the new key: the
   * shell derives "the active surface" from the most recent setSurfaceKey call, so seeding first
   * would frame the surface the module hasn't claimed yet (H4 — ordering is the consent boundary
   * here, not just a nicety).
   *
   * #1495 — this ordering is enforced, not just documented, on module-bound handles: calling
   * seedContext/submitTurn/subscribeRecords before the first setSurfaceKey call (or after a
   * setSurfaceKey(null) release) no longer falls through to the user's drawer thread.
   * seedContext/submitTurn reject with an error naming the module and the missing claim;
   * subscribeRecords returns a no-op subscription and logs a console.error. Drawer-bound handles
   * (no moduleId) are unaffected — the drawer is their correct surface.
   */
  setSurfaceKey(key: string | null): void;
  /**
   * #1284 — frame this module's thread BEFORE the user's first turn, with no visible user message
   * (contrast submitTurn, which posts one, and seedComposer/hostActions.openAssistant, which insert
   * an editable draft the user can still change or delete). `idempotencyKey` makes a re-seed a
   * no-op (backed by the server's per-session seededContextKeys), so a component remount can never
   * re-frame a conversation already in progress. The surface is curried by the handle exactly as
   * submitTurn already is — the module never names one directly.
   *
   * Trust boundary: this seed text enters the model's context with exactly the authority of a user
   * turn, no more. It must never be treated as, or described as, a system prompt — a module able to
   * rewrite the assistant's own instructions would be a privilege escalation.
   */
  seedContext(seed: string, idempotencyKey: string): Promise<void>;
}
