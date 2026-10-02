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

export interface ClassifierGateRunner {
  /** Admin-wide instance switch. `off`/`shadow` do nothing in this task; only `on` is handled. */
  mode(actorUserId: string): Promise<GateMode>;
  evaluate(request: GateRequest): Promise<GateOutcome>;
}

export interface GateTokenCallbacks {
  /** Mints a short-lived gate token through the composition root's real token registry. */
  mint(actorUserId: string, correlationId: string): string;
  /** Revokes that token alone. Never revokes an existing model session's tokens. */
  revoke(correlationId: string): void;
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
      const token = deps.tokens.mint(request.actorUserId, correlationId);
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
