import { randomUUID } from "node:crypto";

import type { ClassifierHandle } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import type {
  ClassifierShadowRepository,
  ModelToolObservation
} from "../classifier-shadow-repository.js";
import {
  ClassifierGate,
  GATE_LIMITS,
  type GateMode,
  type GateOutcome,
  type GateSpeed
} from "./classifier-gate.js";
import { gateEligibilityProblem, type GateTool } from "./classifier-gate-arguments.js";
import type { ClassifierGatePortsFactory } from "./classifier-gate-wiring.js";
import { fileClassifierTimeoutLine } from "./classifier-gate-wiring.js";
import type { ChatSurface } from "./chat-surface.js";

/**
 * #2907 (plan 3.5) — the shadow half of the classifier gate. One attempt runs alongside the default
 * turn under that turn's cancellation; it never executes a tool, never creates a card, never
 * consumes allowance, and never delays the default reply. The attempt records a hypothetical
 * decision and the manager reports the model's first tool attempt so the record can be compared.
 *
 * Failures here are invisible to chat: mode/incognito/classifier/ports/storage problems all end the
 * shadow attempt quietly. Nothing stores message text beyond the already-merged 3.4 record, and a
 * private chat never reaches this file.
 */

export const SHADOW_OBSERVATION_BUFFER_LIMIT = 200;

export interface ClassifierGateShadowTurnInput {
  readonly actorUserId: string;
  /** Conversation captured with privacy at turn start, before any mode wait. */
  readonly threadId: string | null;
  readonly surface: ChatSurface;
  /** The accepted original text. Never logged. */
  readonly message: string;
  /** Server-issued correlation id for this turn. */
  readonly turnId: string;
  readonly hasAttachment: boolean;
  /**
   * The privacy of the conversation THIS turn runs in, captured from the turn's own session at the
   * moment the turn starts. Never re-read later: the user can resume or start another conversation
   * before the shadow check runs. A private turn is never classified or recorded.
   */
  readonly incognito: boolean;
  /** The turn's cancellation; aborting it stops the shadow attempt too. */
  readonly signal: AbortSignal;
}

export interface ClassifierGateShadowRunner {
  /** Launch the shadow attempt for one turn. Returns immediately; never throws. */
  start(input: ClassifierGateShadowTurnInput): void;
  /** The model's first tool record for this turn, as the transport named it. Fire-and-forget. */
  observeModelTool(actorUserId: string, turnId: string, rawToolName: string): void;
  /** The turn completed with no model tool attempt. */
  noModelTool(actorUserId: string, turnId: string): void;
  /** The turn was cancelled before any comparison could be made. */
  cancelTurn(actorUserId: string, turnId: string): void;
}

export interface ClassifierGateShadowRunnerDeps {
  /** Reads the admin-wide gate mode. Only `shadow` runs an attempt. */
  readMode(actorUserId: string): Promise<GateMode>;
  /** #3365: the routing-model speed record the live runner shares. Absent, the fixed limit applies. */
  readonly speed?: GateSpeed;
  /** Builds the attempt ports, already bound to `token` and the attempt's correlation id. */
  createPorts: ClassifierGatePortsFactory;
  readonly repository: ClassifierShadowRepository;
  readonly dataContext: DataContextRunner;
  readonly tokens: {
    /** Mints a short-lived gate token with the captured tool allowlist. */
    mint(
      actorUserId: string,
      correlationId: string,
      threadId: string | null,
      allowedToolNames: Set<string>
    ): string;
    /** Revokes that token alone. */
    revoke(correlationId: string): void;
  };
  /** The actor's executable tool names, captured as the token's allowlist. */
  listToolNames(actorUserId: string): Promise<readonly string[]>;
  readonly thresholdVersion: string;
  /** Called with the operation name only, never message text. */
  readonly onFailure?: (operation: string) => void;
  now(): number;
}

interface PendingTurn {
  readonly actorUserId: string;
  /** The 3.4 record exists, so observations can be written directly. */
  opened: boolean;
  /** The shadow attempt finished (whether or not it opened a record). */
  settled: boolean;
  /** The chat turn ended; the pending entry may be reclaimed once the attempt settles too. */
  ended: boolean;
  /** The model's first tool call was seen; later calls are never compared. */
  sawTool: boolean;
  /**
   * Transport key to `module.tool` identity, built before the record opens. Only a key that one
   * executable tool alone can produce, and whose tool takes part in the classifier, has an entry.
   * Any other model tool is stored with no name.
   */
  toolIdentities?: ReadonlyMap<string, string>;
  observation?: TurnObservation;
}

/** A model tool stays as the transport named it until the record is written. */
type TurnObservation =
  | Exclude<ModelToolObservation, { readonly kind: "tool" }>
  | { readonly kind: "tool"; readonly rawToolName: string };

const OBSERVATION_PRIORITY: Readonly<Record<ModelToolObservation["kind"], number>> = {
  tool: 3,
  cancelled: 2,
  no_model_tool: 1,
  unobserved: 0
};

const TRANSPORT_PREFIXES = ["mcp__jarvis__", "mcp__moss__"] as const;

/**
 * The CLI renders `calendar.listVisibleEvents` as `mcp__jarvis__calendar_listVisibleEvents`. It
 * encodes every dot as an underscore, so `hub.turn_on` and `hub.turn.on` arrive the same. Names
 * are compared in that encoded form, exactly as written.
 */
function transportKey(name: string): string {
  const prefix = TRANSPORT_PREFIXES.find((candidate) => name.startsWith(candidate));
  return (prefix ? name.slice(prefix.length) : name).replaceAll(".", "_");
}

export function createClassifierGateShadowRunner(
  deps: ClassifierGateShadowRunnerDeps
): ClassifierGateShadowRunner {
  const pending = new Map<string, PendingTurn>();
  /**
   * A timeout or classifier error starts a 30-second cooldown for that actor + classifier. The
   * decision engine's own cooldown map is per-instance, and each attempt builds a fresh gate, so
   * the runner holds the cross-turn state here. Keeping it here also means a cooled-off turn makes
   * no classifier request at all.
   */
  const coolingUntil = new Map<string, number>();

  const fail = (operation: string) => {
    deps.onFailure?.(operation);
  };

  const withActor = <T>(
    actorUserId: string,
    requestId: string,
    work: (db: DataContextDb) => Promise<T>
  ): Promise<T> => deps.dataContext.withDataContext({ actorUserId, requestId }, work);

  const writeObservation = (
    actorUserId: string,
    turnId: string,
    turn: PendingTurn,
    observation: TurnObservation
  ): void => {
    const identity =
      observation.kind === "tool"
        ? turn.toolIdentities?.get(transportKey(observation.rawToolName))
        : undefined;
    const stored: ModelToolObservation =
      observation.kind !== "tool"
        ? observation
        : identity
          ? { kind: "tool", toolId: identity }
          : { kind: "unobserved" };
    void withActor(actorUserId, `classifier_shadow_observe_${turnId}`, (db) =>
      deps.repository.observeModelTool(db, turnId, stored)
    ).catch(() => fail("observe"));
  };

  const maybeReclaim = (turnId: string): void => {
    const turn = pending.get(turnId);
    if (turn?.settled && turn.ended) pending.delete(turnId);
  };

  const markEnded = (turnId: string): void => {
    const turn = pending.get(turnId);
    if (turn) turn.ended = true;
  };

  /**
   * Records one observation for a turn that is still tracked. A tracked record that exists takes it
   * directly; one whose attempt is still running buffers it (with priority) until the attempt opens
   * the row; a tracked turn with no row and no running attempt drops it. An untracked turn means no
   * record exists, so nothing is written — this is why gate `off` costs the default turn no writes.
   */
  const recordObservation = (
    actorUserId: string,
    turnId: string,
    observation: TurnObservation
  ): void => {
    const turn = pending.get(turnId);
    if (!turn) return;
    if (observation.kind === "tool") {
      if (turn.sawTool) return;
      turn.sawTool = true;
    }
    if (turn.opened) {
      writeObservation(actorUserId, turnId, turn, observation);
      return;
    }
    if (turn.settled) return;
    if (
      !turn.observation ||
      OBSERVATION_PRIORITY[observation.kind] > OBSERVATION_PRIORITY[turn.observation.kind]
    ) {
      turn.observation = observation;
    }
  };

  const runAttempt = async (input: ClassifierGateShadowTurnInput): Promise<void> => {
    const { actorUserId, turnId } = input;
    try {
      if (input.signal.aborted) return;
      const mode = await deps.readMode(actorUserId);
      if (mode !== "shadow") return;
      if (input.signal.aborted) return;
      // Ruling 9 / Ben's 2026-10-02 ruling: a private chat takes part in nothing. The flag comes
      // from THIS turn's own session, captured when the turn started, so a later resume or new chat
      // cannot make a private message look public.
      if (input.incognito) return;
      if (input.signal.aborted) return;
      // Match the gate's own bound so an oversize message is never written to the 3.4 record (its
      // message_text column caps at 2000 bytes) and never reaches a classifier.
      if (new TextEncoder().encode(input.message).length > GATE_LIMITS.maxMessageBytes) return;

      const allowedToolNames = new Set(await deps.listToolNames(actorUserId));
      const token = deps.tokens.mint(actorUserId, turnId, input.threadId, allowedToolNames);
      try {
        const ports = deps.createPorts(actorUserId, token, turnId);
        let resolved: ClassifierHandle | null | undefined;
        const classifier = {
          ...ports.classifier,
          resolve: async () =>
            resolved === undefined ? (resolved = await ports.classifier.resolve()) : resolved
        };
        const handle = await classifier.resolve();
        const coolKey = `${actorUserId}|${handle?.model.id ?? "none"}`;
        const cooling = (coolingUntil.get(coolKey) ?? 0) > deps.now();

        // Listed once and shared with the gate. A failed listing leaves no identities, so no model
        // tool name is stored, and the gate still sees the same failure.
        const listing = ports.listTools();
        const listed = await listing.catch(() => []);
        const tracked = pending.get(turnId);
        if (tracked) tracked.toolIdentities = modelToolIdentities(allowedToolNames, listed);

        const opened = await withActor(actorUserId, `classifier_shadow_open_${turnId}`, (db) =>
          deps.repository.open(db, {
            turnId,
            incognito: false,
            messageText: input.message,
            classifierConfigId: handle?.model.provider_config_id ?? "none",
            classifierConfigVersion: handle
              ? `${handle.model.provider_kind}:${handle.model.provider_model_id}:${handle.capability}`
              : "none",
            thresholdVersion: deps.thresholdVersion
          })
        ).catch(() => false);
        if (!opened) return;

        const turn = pending.get(turnId);
        if (turn) {
          turn.opened = true;
          if (turn.observation) {
            writeObservation(actorUserId, turnId, turn, turn.observation);
            turn.observation = undefined;
          }
          maybeReclaim(turnId);
        }

        // A cooled-off turn makes no classifier request; the record still shows why.
        if (cooling) {
          await withActor(actorUserId, `classifier_shadow_complete_${turnId}`, (db) =>
            deps.repository.complete(db, { turnId, decision: "declined", reason: "cooling_off" })
          ).catch(() => fail("complete"));
          return;
        }

        const gate = new ClassifierGate({
          classifier,
          listTools: () => listing,
          loadCandidates: ports.loadCandidates,
          gateway: ports.gateway,
          isReleased: ports.isReleased,
          // #3064: prod runs the classifier in shadow, so a shadow timeout files the
          // same single line as the engine path.
          noteTimeout: (activity) => fileClassifierTimeoutLine(activity),
          ...(deps.speed ? { speed: deps.speed } : {}),
          now: deps.now
        });
        const outcome = await gate.evaluate({
          actorUserId,
          threadId: input.threadId,
          message: input.message,
          hasAttachment: input.hasAttachment,
          incognito: false,
          mode: "shadow",
          signal: input.signal,
          // #2956: the shadow turn id is the chat turn id, so the check lines
          // join the turn they informed; the answer line id is its parent.
          turnId,
          parentId: turnId
        });
        // Cross-turn cooldown, matching the engine's rule at the runner's scope.
        if (
          outcome.kind === "declined" &&
          (outcome.reason === "timeout" || outcome.reason === "classifier_error")
        ) {
          coolingUntil.set(coolKey, deps.now() + GATE_LIMITS.cooldownMs);
        }
        await withActor(actorUserId, `classifier_shadow_complete_${turnId}`, (db) =>
          deps.repository.complete(db, { turnId, ...toCompletion(outcome) })
        ).catch(() => fail("complete"));
      } finally {
        deps.tokens.revoke(turnId);
      }
    } catch {
      // A mode read, classifier, port or storage failure never reaches chat.
    } finally {
      const turn = pending.get(turnId);
      if (turn) {
        turn.settled = true;
        maybeReclaim(turnId);
      }
    }
  };

  return {
    start(input) {
      const existing = pending.get(input.turnId);
      if (existing) return;
      pending.set(input.turnId, {
        actorUserId: input.actorUserId,
        opened: false,
        settled: false,
        ended: false,
        sawTool: false
      });
      if (pending.size > SHADOW_OBSERVATION_BUFFER_LIMIT) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      void runAttempt(input);
    },
    observeModelTool(actorUserId, turnId, rawToolName) {
      recordObservation(actorUserId, turnId, { kind: "tool", rawToolName });
    },
    noModelTool(actorUserId, turnId) {
      markEnded(turnId);
      recordObservation(actorUserId, turnId, { kind: "no_model_tool" });
      maybeReclaim(turnId);
    },
    cancelTurn(actorUserId, turnId) {
      markEnded(turnId);
      recordObservation(actorUserId, turnId, { kind: "cancelled" });
      maybeReclaim(turnId);
    }
  };
}

type CompletionInput = Omit<Parameters<ClassifierShadowRepository["complete"]>[1], "turnId">;

function toCompletion(outcome: GateOutcome): CompletionInput {
  switch (outcome.kind) {
    case "would_handle":
      return withTrace("would_handle", outcome);
    case "cancelled":
      return withTrace("cancelled", outcome);
    case "declined": {
      const trace = withTrace("declined", outcome);
      if (outcome.reason === "none") return { ...trace, decision: "none" };
      if (outcome.reason === "needs_earlier_conversation")
        return { ...trace, decision: "needs_earlier_conversation" };
      if (outcome.reason === "timeout" || outcome.reason === "classifier_error")
        return { ...trace, decision: "failed", reason: outcome.reason };
      return { ...trace, reason: outcome.reason };
    }
    default:
      // `handled`/`terminal_failure` cannot occur in shadow, but if they ever did the record is a
      // decline: shadow never executes.
      return withTrace("declined", outcome);
  }
}

/**
 * Maps each transport key to the identity the gate records for the same tool. A key that more than
 * one executable tool can produce is left out, so a kept-out tool can never pass as a classifier
 * tool whose name encodes the same way.
 */
function modelToolIdentities(
  executableNames: ReadonlySet<string>,
  classifierTools: readonly GateTool[]
): Map<string, string> {
  const namesByKey = new Map<string, Set<string>>();
  for (const name of [...executableNames, ...classifierTools.map((tool) => tool.name)]) {
    const key = transportKey(name);
    namesByKey.set(key, (namesByKey.get(key) ?? new Set()).add(name));
  }

  const eligible = new Map<string, GateTool | null>();
  for (const tool of classifierTools) {
    if (gateEligibilityProblem(tool, null) === "not_declared") continue;
    eligible.set(tool.name, eligible.has(tool.name) ? null : tool);
  }

  const identities = new Map<string, string>();
  for (const [key, names] of namesByKey) {
    if (names.size !== 1) continue;
    const [name] = names;
    const tool = name === undefined ? undefined : eligible.get(name);
    if (tool) identities.set(key, `${tool.moduleId}.${toBareToolName(tool.moduleId, tool.name)}`);
  }
  return identities;
}

/**
 * The 3.4 record stores `module_id` and a bare `tool_name`, and rebuilds the comparison identity as
 * `module_id.tool_name`. A first-party manifest tool name already carries its module prefix
 * (`calendar.listVisibleEvents`), so strip it here; otherwise the identity would double the prefix
 * and every shadow comparison would read as a mismatch. A tool with no matching prefix is unchanged.
 */
function toBareToolName(moduleId: string | undefined, toolName: string): string {
  if (moduleId !== undefined && toolName.startsWith(`${moduleId}.`)) {
    return toolName.slice(moduleId.length + 1);
  }
  return toolName;
}

function withTrace(
  decision: "would_handle" | "declined" | "cancelled",
  outcome: Extract<GateOutcome, { trace: unknown }>
): CompletionInput {
  const { trace } = outcome;
  return {
    decision,
    ...(trace.moduleId !== undefined ? { moduleId: trace.moduleId } : {}),
    ...(trace.toolName !== undefined
      ? { toolName: toBareToolName(trace.moduleId, trace.toolName) }
      : {}),
    ...(trace.confidence !== undefined ? { confidence: trace.confidence } : {}),
    ...(trace.lead !== undefined ? { margin: trace.lead } : {}),
    latencyMs: trace.latencyMs
  };
}

/** The per-turn handle a caller keeps while a turn runs. No-op when no runner is wired. */
export interface ClassifierGateShadowTurn {
  /** Report the first model tool record; later ones are ignored. */
  noteTool(rawToolName: string): void;
  /** Report a Stop before any comparison. */
  cancel(): void;
  /** Report no-model-tool once the turn ends without one. */
  finish(): void;
}

/**
 * Allocates a turn id and starts one shadow attempt. Keeping the per-turn bookkeeping here (rather
 * than in `runTurn`) holds the manager under its file-size gate. The id is server-issued;
 * correlation never keys on the actor alone.
 */
export function beginClassifierGateShadowTurn(
  runner: ClassifierGateShadowRunner | undefined,
  actorUserId: string,
  surface: ChatSurface,
  message: string,
  incognito: boolean,
  options: {
    readonly threadId: string | null;
    readonly hasAttachment: boolean;
    readonly signal: AbortSignal;
    readonly turnId?: string;
  }
): ClassifierGateShadowTurn {
  // #2956: the turn id is minted once where the chat turn starts, so the shadow
  // record, the audit rows and the activity lines share one value. Callers that
  // predate the turn id keep the old mint.
  const turnId = options.turnId ?? randomUUID();
  runner?.start({
    actorUserId,
    threadId: options.threadId,
    surface,
    message,
    turnId,
    hasAttachment: options.hasAttachment,
    incognito,
    signal: options.signal
  });
  let observed = false;
  return {
    noteTool(rawToolName) {
      if (observed) return;
      observed = true;
      runner?.observeModelTool(actorUserId, turnId, rawToolName);
    },
    cancel() {
      observed = true;
      runner?.cancelTurn(actorUserId, turnId);
    },
    finish() {
      if (!observed) runner?.noModelTool(actorUserId, turnId);
    }
  };
}
