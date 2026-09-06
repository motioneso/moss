/**
 * Neutral lifecycle contract for a persistent provider-CLI child (#1557 Phase 1).
 *
 * `ProviderChatRuntime` is provider-agnostic: no adapter-specific detail (flags, transport,
 * process shape) leaks into this file. Phase 1 ships exactly one concrete implementation
 * (`claude-persistent-runtime.ts`), wrapped for the existing `CliChatEngine` contract by
 * `persistent-runtime-engine.ts` so `chat-session-manager` keeps its current call shape.
 *
 * Not exported from `public.ts` — nothing outside `live/` consumes this yet.
 */

import type { ProviderKind } from "@moss/ai";

import type { EngineLaunchOpts, TranscriptRecord } from "./types.js";

export type ProviderRuntimeKind = "persistent" | "bounded-fallback";

export type ChildState =
  | "launching"
  | "ready"
  | "in-turn"
  | "awaiting-approval"
  | "idle"
  | "reaping";

export type ReapReason =
  | "idle-timeout"
  | "lru-evict"
  | "flag-drain"
  | "token-rotation"
  | "incognito-end"
  | "crash-cleanup"
  | "shutdown";

export type CancelOutcome = { readonly approvalsResolved: number };

export type RecoveryOutcome =
  | { readonly kind: "resubmitted" } // provably-pre-acceptance only
  | {
      readonly kind: "neutral-failure";
      readonly reason: string; // server-composed, no model prose
      /** #2242: set when the failure was the provider refusing the saved sign-in, rather than any
       *  other failure. Kept so callers can tell "log in again" from "try again". */
      readonly loginRejected?: boolean;
    };

export interface RuntimeHealth {
  readonly alive: boolean;
  readonly state: ChildState;
  readonly turnsCompleted: number;
  readonly lastResultAt: number | null; // from terminal result frames ONLY (ruling 8)
}

/**
 * Fail-closed MCP readiness check: resolves once `initialize` + `tools/list` have both
 * succeeded (HTTP 200, no JSON-RPC `.error`) against the child's minted token. Rejects on any
 * failure (unreachable, non-200, `.error` present) — never retried by the runtime itself. The
 * caller constructs this as a closure over `opts.mcpServerUrl`/`opts.mcpToken` (P1.4); injecting
 * it as a function lets `launch()` unit tests script admission failure without real HTTP.
 */
export type McpReadinessProbe = () => Promise<void>;

/**
 * One decoded, push-delivered event from a child's stream-JSON stdout, tagged to the turn that
 * produced it. Only one turn is ever in flight on a given child (Phase 1 has no pipelining), so
 * a single current `turnId` is enough to correlate frames — no request/response matching needed.
 */
export type RuntimeTurnEvent =
  | { readonly kind: "record"; readonly turnId: string; readonly record: TranscriptRecord }
  | { readonly kind: "turn-complete"; readonly turnId: string }
  | { readonly kind: "turn-failed"; readonly turnId: string; readonly outcome: RecoveryOutcome };

export interface ProviderChatRuntime {
  readonly kind: ProviderRuntimeKind;
  readonly provider: ProviderKind;
  /** Fail-closed admission: resolves only after the server-side MCP session for this child's
   *  token has initialized AND listed tools; no user frame may be written before then. */
  launch(opts: EngineLaunchOpts & { readonly mcpReadiness: McpReadinessProbe }): Promise<void>;
  submitTurn(turnId: string, engineText: string): Promise<void>;
  /** Push-based; resolves per-frame as the bounded decoder parses. Replaces readNew polling. */
  streamEvents(): AsyncIterable<RuntimeTurnEvent>;
  cancel(turnId: string): Promise<CancelOutcome>;
  health(): Promise<RuntimeHealth>;
  reap(reason: ReapReason): Promise<void>;
  /** Called by the owner after a child death mid-turn. Decides resubmit-vs-neutral-failure
   *  from acceptance evidence (frame accepted? any tool activity?), relaunch ≤ once per turn. */
  recover(turnId: string): Promise<RecoveryOutcome>;
}
