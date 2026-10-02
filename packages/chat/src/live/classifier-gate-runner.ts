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
 * Runtime wiring is deliberately NOT attached in this task (activation is hard-blocked): the ports
 * factory is supplied when the classifier and tool-menu wiring lands, and until then the manager
 * receives no runner and every turn follows today's path unchanged.
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
   * the token anywhere else.
   */
  createPorts(
    actorUserId: string,
    token: string
  ): ClassifierGateAttemptPorts & { readonly gateway: ClassifierGatePorts["gateway"] };
  readonly tokens: GateTokenCallbacks;
  now(): number;
  /** Test seam: deterministic correlation ids. */
  newCorrelationId?: () => string;
}

export function createClassifierGateRunner(deps: ClassifierGateRunnerDeps): ClassifierGateRunner {
  const newCorrelationId = deps.newCorrelationId ?? (() => randomUUID());
  return {
    mode: (actorUserId) => deps.readMode(actorUserId),
    async evaluate(request) {
      const correlationId = newCorrelationId();
      const token = deps.tokens.mint(request.actorUserId, correlationId);
      try {
        const attempt = deps.createPorts(request.actorUserId, token);
        const gate = new ClassifierGate({ ...attempt, now: deps.now });
        return await gate.evaluate(request);
      } finally {
        deps.tokens.revoke(correlationId);
      }
    }
  };
}
