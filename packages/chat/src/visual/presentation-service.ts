import type { ToolContext } from "@moss/module-sdk";
import { VISUAL_LIMITS, type VisualObject } from "@moss/shared";

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

/** Internal staging seam: shape/reference trust only, never permission to render a program. */
export class VisualPresentationTurn {
  readonly registry: VisualTurnRegistry;
  private attempted = false;
  private fallbackText = PRESENTATION_UNAVAILABLE;
  private accepted: TrustedVisualReply | undefined;
  private userDataRegistered = false;

  constructor(readonly identity: Readonly<VisualTurnIdentity>) {
    this.identity = Object.freeze({ ...identity });
    this.registry = new VisualTurnRegistry(this.identity);
  }

  get reply(): TrustedVisualReply | undefined {
    return this.accepted;
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

  present(proposal: unknown): PresentationResult {
    if (this.attempted) {
      return { ok: false, code: "already_presented", fallbackText: this.fallbackText };
    }
    this.attempted = true;
    const result = this.registry.finalize(this.identity, proposal, this.fallbackText);
    if (result.ok) this.accepted = result.reply;
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

  begin(sessionId: string, identity: VisualTurnIdentity): VisualPresentationTurn {
    this.turns.get(sessionId)?.discard();
    const turn = new VisualPresentationTurn(identity);
    this.turns.set(sessionId, turn);
    return turn;
  }

  present(ctx: ToolContext, proposal: unknown): PresentationResult {
    const turn = this.turns.get(ctx.chatSessionId);
    if (
      !turn ||
      !ctx.turnId ||
      ctx.actorUserId !== turn.identity.actorUserId ||
      ctx.threadId !== turn.identity.threadId ||
      ctx.turnId !== turn.identity.turnId ||
      turn.registry.state !== "open"
    ) {
      return { ok: false, code: "unavailable", fallbackText: PRESENTATION_UNAVAILABLE };
    }
    return turn.present(proposal);
  }

  release(sessionId: string, turn: VisualPresentationTurn): void {
    turn.discard();
    if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
  }
}
