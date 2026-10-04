import { randomUUID } from "node:crypto";

import {
  ClassifierGate,
  type ClassifierGatePorts,
  type GateMode,
  type GateOutcome,
  type GateRequest
} from "./classifier-gate.js";

/**
 * Task 4.1 (#2901) — the lifecycle seam between one chat turn and the already-merged decision
 * engine. It owns exactly two things the manager must not know about: reading the admin gate mode,
 * and the short-lived gate token.
 *
 * The token is minted through the composition root's real session-token registry (same one every
 * model session uses), scoped to the acting user and a fresh per-attempt correlation id, and is
 * revoked in `finally` on every path. It is passed only to the gateway call, never logged, and never
 * placed in a job payload, prompt, response or persisted record.
 *
 * Runtime wiring is deliberately narrow in this task (activation is hard-blocked): the composition
 * root attaches the runner with the real token callbacks and the admin settings read, but leaves the
 * ports factory unset because assembling the tool list and classifier calls belongs to the later
 * live-wiring step. Until it lands, every gated message declines to the default model.
 */

/**
 * Real composition-root inputs for the gate runner: the admin settings read, the process-wide
 * session-token registry, and the clock. Both `registerChatRoutes` and the tests call this, so the
 * session-id shape, the empty allowlist and the short token lifetime have exactly one definition.
 */
export interface ClassifierGateWiringDeps {
  /** Reads the admin `chat.classifier_gate_mode` setting through the caller's data access. */
  readonly readMode: (actorUserId: string) => Promise<GateMode>;
  /** The same `SessionTokenRegistry` every model session uses. */
  readonly tokens: {
    mint(
      identity: {
        actorUserId: string;
        chatSessionId: string;
        allowedToolNames: Set<string> | null;
      },
      options?: GateTokenMintOptions
    ): string;
    revokeBySessionId(chatSessionId: string): void;
    /** #2956: file a gate session's tool rows under its chat turn. */
    setCurrentTurnId(chatSessionId: string, turnId: string): void;
    clearCurrentTurnId(chatSessionId: string): void;
  };
  /**
   * #2907 (plan 3.5) — the production attempt ports: the actor's tool menu, the classifier calls,
   * candidate hooks and the gateway call (already bound to `token`). Absent ⇒ every attempt declines
   * without ports. `on` runs only while the current classifier selection has a shadow review.
   */
  readonly createPorts?: ClassifierGateRunnerDeps["createPorts"];
  now?(): number;
}

/**
 * Mint options for a gate token. `fixedExpiry` is REQUIRED to be true by the production wiring: a
 * gate token must go stale on its own after `ttlMs`, even if something keeps using it, so a skipped
 * revoke cannot keep it alive.
 */
export interface GateTokenMintOptions {
  readonly ttlMs?: number;
  readonly fixedExpiry?: boolean;
}

/**
 * The gate token's own short lifetime (one minute), paired with `fixedExpiry: true` so use never
 * slides it out. The registry's `verify` would otherwise push the expiry out to its 60-minute
 * default on every use (see `SessionTokenRegistry.verify`), which is exactly the leak this cap is
 * meant to close.
 */
export const GATE_TOKEN_TTL_MS = 60_000;

/** The session id a gate attempt mints and revokes. ONE definition, so mint and revoke cannot drift. */
export function classifierGateSessionId(correlationId: string): string {
  return `classifier-gate:${correlationId}`;
}

/**
 * Task 4.1 (#2901) — the real gate runner wiring. Mints one short-lived token per attempt through
 * the composition root's registry, scoped to a fresh correlation id, with an empty allowlist (never
 * unrestricted) and a one-minute FIXED expiry (use never extends it), and revokes it by the exact
 * same session id. The ports factory is left unset (that is 3.5), so every attempt declines.
 */
export function buildClassifierGateRunner(deps: ClassifierGateWiringDeps): ClassifierGateRunner {
  return createClassifierGateRunner({
    readMode: deps.readMode,
    ...(deps.createPorts ? { createPorts: deps.createPorts } : {}),
    tokens: {
      mint: (actorUserId, correlationId, options) =>
        deps.tokens.mint(
          {
            actorUserId,
            chatSessionId: classifierGateSessionId(correlationId),
            // Tool limit: the gate token always carries an allowlist, never unrestricted. It is empty
            // until the 3.5 ports factory supplies the turn's menu — every tool this token may call
            // must be in the release-approved menu, and no release writer exists yet.
            allowedToolNames: new Set<string>()
          },
          options
        ),
      // #2956: files the attempt's tool rows under the chat turn, under the
      // same gate session id the mint above uses. Revoke clears it.
      noteTurn: (correlationId, turnId) => {
        if (turnId) deps.tokens.setCurrentTurnId(classifierGateSessionId(correlationId), turnId);
      },
      revoke: (correlationId) => {
        deps.tokens.clearCurrentTurnId(classifierGateSessionId(correlationId));
        deps.tokens.revokeBySessionId(classifierGateSessionId(correlationId));
      },
      tokenOptions: { ttlMs: GATE_TOKEN_TTL_MS, fixedExpiry: true }
    },
    now: deps.now ?? (() => Date.now())
  });
}

export interface ClassifierGateRunner {
  /** Admin-wide instance switch. `off`/`shadow` do nothing in this task; only `on` is handled. */
  mode(actorUserId: string): Promise<GateMode>;
  evaluate(request: GateRequest): Promise<GateOutcome>;
}

export interface GateTokenCallbacks {
  /**
   * Mints a short-lived gate token through the composition root's real token registry. `options`
   * carries the gate token's own TTL and fixed-expiry flag when the wiring sets them.
   */
  mint(actorUserId: string, correlationId: string, options?: GateTokenMintOptions): string;
  /**
   * #2956: files this attempt's tool rows under the chat turn. Called with the
   * request's turn id (or nothing) right after mint; the production revoke
   * clears it. Optional so test doubles keep working.
   */
  noteTurn?(correlationId: string, turnId: string | undefined): void;
  /** Revokes that token alone. Never revokes an existing model session's tokens. */
  revoke(correlationId: string): void;
  /**
   * Mint options applied to every gate token. The production wiring sets a short `ttlMs` AND
   * `fixedExpiry: true`, so use never slides the expiry out and a skipped revoke leaves the token
   * stale after a minute, not an hour.
   */
  readonly tokenOptions?: GateTokenMintOptions;
}

/** Everything a `ClassifierGate` needs except the clock (supplied by the runner) and the gateway. */
export interface ClassifierGateAttemptPorts {
  readonly classifier: ClassifierGatePorts["classifier"];
  readonly listTools: ClassifierGatePorts["listTools"];
  readonly loadCandidates: ClassifierGatePorts["loadCandidates"];
  readonly isReleased: ClassifierGatePorts["isReleased"];
}

export interface ClassifierGateRunnerDeps {
  readMode(actorUserId: string): Promise<GateMode>;
  /**
   * Builds the attempt ports. The gateway must already be bound to `token`; the runner never exposes
   * the token anywhere else. ABSENT until the later live-wiring step assembles the tool list and
   * classifier calls: without it the runner still mints and revokes a real token per attempt, then
   * declines, so every message falls through to the default model.
   */
  createPorts?: (
    actorUserId: string,
    token: string
  ) => ClassifierGateAttemptPorts & { readonly gateway: ClassifierGatePorts["gateway"] };
  readonly tokens: GateTokenCallbacks;
  now(): number;
  /** Test seam: deterministic correlation ids. */
  newCorrelationId?: () => string;
}

/** Declines without picking a tool. Returned until the tool-list/classifier wiring lands. */
function declineWithoutPorts(): GateOutcome {
  return { kind: "declined", reason: "no_eligible_tools", trace: { latencyMs: 0 } };
}

export function createClassifierGateRunner(deps: ClassifierGateRunnerDeps): ClassifierGateRunner {
  const newCorrelationId = deps.newCorrelationId ?? (() => randomUUID());
  return {
    mode: (actorUserId) => deps.readMode(actorUserId),
    async evaluate(request) {
      const correlationId = newCorrelationId();
      const token = deps.tokens.mint(request.actorUserId, correlationId, deps.tokens.tokenOptions);
      // #2956: the gate executes tools under its own session id, so the turn is
      // registered under that id too. Cleared by the revoke below.
      deps.tokens.noteTurn?.(correlationId, request.turnId);
      try {
        if (!deps.createPorts) return declineWithoutPorts();
        const attempt = deps.createPorts(request.actorUserId, token);
        const gate = new ClassifierGate({ ...attempt, now: deps.now });
        return await gate.evaluate(request);
      } finally {
        deps.tokens.revoke(correlationId);
      }
    }
  };
}
