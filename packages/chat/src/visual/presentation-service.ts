import type { ToolContext } from "@moss/module-sdk";
import {
  validateVisualCatalogReply,
  VISUAL_LIMITS,
  type VisualObject,
  tryCopyVisualSnapshot,
  snapshotVisualTemplate,
  BUILT_IN_VISUAL_CATALOG_VERSION
} from "@moss/shared";
import { presentationContext, promptVisualFields } from "./user-data.js";

import {
  VisualTurnRegistry,
  type FinalizeResult,
  type RegisterResult,
  type TrustedVisualReply,
  type VisualTurnIdentity
} from "./turn-registry.js";

export const PRESENTATION_UNAVAILABLE =
  "A visual is unavailable for this turn. Answer in ordinary text; do not retry the presentation or show its program.";

export type PresentationResult =
  | FinalizeResult
  | { ok: false; code: "unavailable" | "already_presented"; fallbackText: string };

/** One host-bound proposal, validated against the active read-only catalog. */
export class VisualPresentationTurn {
  readonly registry: VisualTurnRegistry;
  private attempted = false;
  private fallbackText = PRESENTATION_UNAVAILABLE;
  private accepted: TrustedVisualReply | undefined;
  private userDataRegistered = false;

  constructor(
    readonly identity: Readonly<VisualTurnIdentity>,
    private readonly onAccepted?: () => void
  ) {
    this.identity = Object.freeze({ ...identity });
    this.registry = new VisualTurnRegistry(this.identity);
  }

  get reply(): TrustedVisualReply | undefined {
    return this.accepted;
  }

  registerPrompt(text: string, retrievedAt: string): string {
    const fields = promptVisualFields(text);
    const registered = this.registerUserData(fields, retrievedAt);
    return registered.ok ? presentationContext(registered.ref, fields) : "";
  }

  /** Host-only path. Tool input cannot supply fields, provenance, identity or fallback. */
  registerUserData(fields: VisualObject, retrievedAt: string): RegisterResult {
    if (this.attempted || this.userDataRegistered) return { ok: false, code: "closed" };
    const registered = this.registry.register(this.identity, {
      kind: "user.data",
      origin: "user",
      source: { id: "user-supplied", label: "Your data" },
      retrievedAt,
      coverage: "Only the data supplied for this turn; not independently verified",
      fields
    });
    if (registered.ok) {
      this.userDataRegistered = true;
      const formatted = `Your data (not independently verified):\n${JSON.stringify(fields)}`;
      this.fallbackText =
        formatted.length <= VISUAL_LIMITS.fallbackTextLength
          ? formatted
          : "Your data is available, but too long for a visual text fallback. Answer in ordinary text without a program.";
    }
    return registered;
  }

  registerSource(
    snapshot: unknown
  ):
    | { ok: true; ref: string; templateKind: string; catalogVersion: string }
    | { ok: false; code: string } {
    if (this.attempted) return { ok: false, code: "closed" };
    const copied = tryCopyVisualSnapshot({ ...(snapshot as object), ref: "pending" });
    if (!copied.ok) return copied;
    const template = snapshotVisualTemplate(copied.snapshot);
    if (!template) return { ok: false, code: "unsupported_snapshot" };
    const formatted = template.format(copied.snapshot);
    if (!formatted || formatted.length > VISUAL_LIMITS.fallbackTextLength)
      return { ok: false, code: "limit_exceeded" };
    const { ref: _ref, ...input } = copied.snapshot;
    const registered = this.registry.register(this.identity, input);
    if (!registered.ok) return registered;
    this.sourceFallbacks.set(registered.ref, formatted);
    return {
      ...registered,
      templateKind: template.kind,
      catalogVersion: BUILT_IN_VISUAL_CATALOG_VERSION
    };
  }

  private readonly sourceFallbacks = new Map<string, string>();

  present(proposal: unknown): PresentationResult {
    if (this.attempted) {
      return { ok: false, code: "already_presented", fallbackText: this.fallbackText };
    }
    this.attempted = true;
    let result = this.registry.finalize(this.identity, proposal, this.fallbackText);
    if (result.ok && result.reply.catalogVersion === BUILT_IN_VISUAL_CATALOG_VERSION) {
      const fallback = result.reply.snapshots
        .map((s) => this.sourceFallbacks.get(s.ref) ?? "")
        .join("\n");
      if (!fallback || fallback.length > VISUAL_LIMITS.fallbackTextLength)
        return { ok: false, code: "invalid_program", fallbackText: this.fallbackText };
      result = this.registry.finalize(this.identity, proposal, fallback);
    }
    if (result.ok) {
      const semantic = validateVisualCatalogReply(result.reply);
      if (!semantic.ok) return { ok: false, code: semantic.code, fallbackText: this.fallbackText };
      this.accepted = result.reply;
      this.onAccepted?.();
    }
    return result;
  }

  close(): void {
    this.registry.close(this.identity);
    this.accepted = undefined;
  }

  discard(): void {
    this.registry.discard(this.identity);
    this.accepted = undefined;
  }
}

/** Shared only by an explicitly injected host lifecycle and its read-tool services. */
export class VisualPresentationService {
  private readonly turns = new Map<string, VisualPresentationTurn>();

  begin(
    sessionId: string,
    identity: VisualTurnIdentity,
    onAccepted?: () => void
  ): VisualPresentationTurn {
    this.turns.get(sessionId)?.discard();
    const turn = new VisualPresentationTurn(identity, onAccepted);
    this.turns.set(sessionId, turn);
    return turn;
  }

  private activeTurn(ctx: ToolContext): VisualPresentationTurn | undefined {
    const turn = this.turns.get(ctx.chatSessionId);
    return turn &&
      ctx.turnId &&
      ctx.actorUserId === turn.identity.actorUserId &&
      ctx.threadId === turn.identity.threadId &&
      ctx.turnId === turn.identity.turnId &&
      turn.registry.state === "open"
      ? turn
      : undefined;
  }

  registerSnapshot(ctx: ToolContext, snapshot: unknown) {
    const turn = this.activeTurn(ctx);
    return turn ? turn.registerSource(snapshot) : { ok: false as const, code: "unavailable" };
  }

  present(ctx: ToolContext, proposal: unknown): PresentationResult {
    const turn = this.activeTurn(ctx);
    return turn
      ? turn.present(proposal)
      : { ok: false, code: "unavailable", fallbackText: PRESENTATION_UNAVAILABLE };
  }

  release(sessionId: string, turn: VisualPresentationTurn): void {
    turn.discard();
    if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
  }
}
