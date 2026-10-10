import {
  GATE_TIMEOUT_ABORT_REASON,
  validateToolInput,
  type ClassifierChoiceQuestion,
  type ClassifierChoiceResult,
  type ClassifierExtractionResult,
  type ClassifierHandle,
  type GatewayGateOutcome,
  type GenerateChoicesActivity
} from "@moss/ai";
import { normalizeClassifierCandidates } from "@moss/module-sdk";

import {
  ARGUMENT_NONE,
  THRESHOLD_VERSION,
  candidateOptions,
  checkExtractedArguments,
  enumOptions,
  extractionSchema,
  gateEligibilityProblem,
  meetsConfidenceBar,
  meetsLead,
  planArguments,
  renderReplyTemplate,
  type ArgumentOption,
  type ArgumentPlan,
  type GateTool
} from "./classifier-gate-arguments.js";

export { THRESHOLD_VERSION };
export type { GateTool };

/**
 * The classifier gate's decision engine (#2873). It decides, for one accepted chat message, whether
 * the configured classifier can pick a tool and its values well enough to run it, or whether the
 * message goes to the default model as today.
 *
 * Every dependency arrives through `ClassifierGatePorts`, so this file holds the rules and nothing
 * else: no database, no provider, no chat session. Every failure path ends in a decline, except a
 * non-read tool that was dispatched and then failed, which ends in a code-written failure so the
 * default model never repeats an action that may have half run.
 */

export type GateMode = "off" | "shadow" | "on";

/**
 * `deadlineMs` bounds an attempt until its model is known, and the whole attempt when no speed
 * record is wired. With one, the model's measured limit takes over (see `classifier-gate-speed.ts`).
 */
export const GATE_LIMITS = {
  maxMessageBytes: 2_000,
  deadlineMs: 3_000,
  cooldownMs: 30_000
} as const;

const NONE = "none";
const NEEDS_EARLIER = "needs_earlier_conversation";

export type GateDeclineReason =
  | "private_chat"
  | "gate_off"
  | "attachment"
  | "oversize"
  | "no_eligible_tools"
  | "no_classifier"
  | "classifier_not_supported"
  | "cooling_off"
  | "none"
  | "needs_earlier_conversation"
  | "low_confidence"
  | "low_lead"
  | "invalid_arguments"
  | "candidates_unavailable"
  | "candidate_not_offered"
  | "classifier_error"
  | "timeout"
  | "gateway_declined"
  | "read_failed";

/** What the gate saw, for the shadow record. Confidence and lead are the weakest of all answers. */
export interface GateTrace {
  readonly moduleId?: string;
  readonly toolName?: string;
  /**
   * Task 4.1 (#2901) — the risk of the tool the attempt dispatched, when one was picked. The
   * lifecycle seam uses it to decide whether a storage failure after a handled turn may fall back
   * (a read is safe to repeat; a write/outbound/destructive attempt already ran).
   */
  readonly risk?: GateTool["risk"];
  readonly confidence?: number;
  readonly lead?: number;
  readonly latencyMs: number;
}

export type GateOutcome =
  | {
      readonly kind: "declined";
      readonly reason: GateDeclineReason;
      /** The gateway's own reason when `reason` is `gateway_declined`. */
      readonly detail?: string;
      readonly trace: GateTrace;
    }
  /** Shadow only: the gate would have run this tool. Nothing ran. */
  | { readonly kind: "would_handle"; readonly trace: GateTrace }
  | { readonly kind: "handled"; readonly reply: string; readonly trace: GateTrace }
  /** A non-read tool was dispatched and failed or could not be confirmed. Never replayed. */
  | { readonly kind: "terminal_failure"; readonly message: string; readonly trace: GateTrace }
  | { readonly kind: "cancelled"; readonly trace: GateTrace };

export interface ClassifierGatePorts {
  readonly classifier: {
    resolve(): Promise<ClassifierHandle | null>;
    choose(
      handle: ClassifierHandle,
      input: {
        readonly state: Record<string, unknown>;
        readonly question: ClassifierChoiceQuestion;
        readonly signal: AbortSignal;
        /** #2956: the turn the check line joins. */
        readonly activity?: GenerateChoicesActivity;
      }
    ): Promise<ClassifierChoiceResult>;
    extract(
      handle: ClassifierHandle,
      input: {
        readonly instructions: string;
        readonly state: Record<string, unknown>;
        readonly schema: Record<string, unknown>;
        readonly signal: AbortSignal;
        /** #2956: the turn the check line joins. */
        readonly activity?: GenerateChoicesActivity;
      }
    ): Promise<ClassifierExtractionResult>;
  };
  /** Every tool the actor could run, with its opt-in declaration. Eligibility is decided here. */
  listTools(): Promise<readonly GateTool[]>;
  /** Runs the tool's candidate hook. Raw output; the engine validates it. */
  loadCandidates(tool: GateTool, signal: AbortSignal): Promise<unknown>;
  gateway: {
    call(
      toolName: string,
      input: Record<string, unknown>,
      mode: "execute" | "dry-run"
    ): Promise<GatewayGateOutcome>;
  };
  /** Whether this tool is released for live use. Only consulted in `on` mode. */
  isReleased(tool: GateTool): boolean;
  /**
   * #3365: how fast each routing model answers. Once the model is known, its measured limit
   * replaces the pre-model deadline, and every answered or timed-out attempt is recorded. Absent,
   * the whole attempt keeps `GATE_LIMITS.deadlineMs`.
   */
  readonly speed?: GateSpeed;
  /**
   * #3064: the attempt ran past the gate deadline. The gate calls this once per such
   * attempt (never on a user-cancelled turn) and owns the timeout line: every recording
   * layer skips its own abort line when the signal carries the gate's reason, so the log
   * shows this line exactly once. Optional so test doubles keep working.
   */
  noteTimeout?(activity: {
    readonly actorUserId: string;
    readonly modelName: string;
    readonly turnId?: string;
    readonly parentId?: string;
    readonly latencyMs: number;
  }): void;
  now(): number;
}

/** #3365: per-model answer times and the time limit they imply. Keyed by the model's config id. */
export interface GateSpeed {
  limitMs(modelId: string): number;
  /** One attempt's time divided by the questions it put to the model. */
  record(modelId: string, perQuestionMs: number): void;
}

/** What `classify` reports back to `evaluate` as the attempt moves on. */
interface ClassifyHooks {
  /** The cooldown key, once the model is resolved. */
  coolKey(key: string): void;
  /** The resolved model, before any question is asked. */
  model(model: ClassifierHandle["model"]): void;
}

export interface GateRequest {
  readonly actorUserId: string;
  /** Conversation captured when this turn starts. Missing identity stays fail-closed. */
  readonly threadId: string | null;
  readonly message: string;
  readonly hasAttachment: boolean;
  readonly incognito: boolean;
  readonly mode: GateMode;
  /** The turn's cancellation. Aborting it stops the gate without a fallback. */
  readonly signal?: AbortSignal;
  /**
   * #2956: the turn this check belongs to. The check line carries it (and the
   * answer line id as its parent) so one turn reads as one group.
   */
  readonly turnId?: string;
  readonly parentId?: string;
}

const FAILED_ACTION_MESSAGE =
  "That action did not complete, and it was not retried. Check before trying again.";
const UNCONFIRMED_ACTION_MESSAGE =
  "The action ran, but its result could not be confirmed. Check before trying again.";

type Guarded<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "aborted" }
  | { readonly kind: "threw" };

/** Resolves when the promise does, or as soon as the signal aborts, whichever is first. */
function guard<T>(work: Promise<T>, signal: AbortSignal): Promise<Guarded<T>> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.resolve({ kind: "aborted" });
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? { kind: "aborted" } : { kind: "value", value });
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? { kind: "aborted" } : { kind: "threw" });
      }
    );
  });
}

class Stop {
  constructor(
    readonly reason: GateDeclineReason,
    readonly detail?: string
  ) {}
}

export class ClassifierGate {
  private readonly coolingUntil = new Map<string, number>();
  /** #3365: questions put to the model, per attempt, keyed by the attempt's deadline signal. */
  private readonly questions = new WeakMap<AbortSignal, number>();

  constructor(private readonly ports: ClassifierGatePorts) {}

  async evaluate(request: GateRequest): Promise<GateOutcome> {
    const startedAt = this.ports.now();
    const trace: { -readonly [K in keyof GateTrace]: GateTrace[K] } = { latencyMs: 0 };
    const finish = <T extends GateOutcome>(outcome: T): T => {
      trace.latencyMs = Math.max(0, this.ports.now() - startedAt);
      return outcome;
    };
    const decline = (reason: GateDeclineReason, detail?: string): GateOutcome =>
      finish({
        kind: "declined",
        reason,
        ...(detail === undefined ? {} : { detail }),
        trace
      });

    const early = this.quickCheck(request);
    if (early) return decline(early);

    const deadline = new AbortController();
    const onCancel = () => deadline.abort();
    request.signal?.addEventListener("abort", onCancel, { once: true });
    if (request.signal?.aborted) deadline.abort();
    const timeUp = () => deadline.abort(GATE_TIMEOUT_ABORT_REASON);
    const elapsed = () => Math.max(0, this.ports.now() - startedAt);
    let timer = setTimeout(timeUp, GATE_LIMITS.deadlineMs);
    let coolKey: string | null = null;
    let checkModel: string | undefined;
    let speedModel: string | null = null;
    const recordSpeed = () => {
      const asked = this.questions.get(deadline.signal) ?? 0;
      if (speedModel && asked > 0) this.ports.speed?.record(speedModel, elapsed() / asked);
    };

    try {
      const picked = await this.classify(request, deadline.signal, trace, {
        coolKey: (key) => {
          coolKey = key;
        },
        model: (model) => {
          checkModel = model.provider_model_id;
          if (!this.ports.speed) return;
          // #3365: the model's own limit, counted from the start of the attempt.
          speedModel = model.id;
          clearTimeout(timer);
          timer = setTimeout(timeUp, Math.max(0, this.ports.speed.limitMs(model.id) - elapsed()));
        }
      });
      clearTimeout(timer);
      recordSpeed();
      if (picked instanceof Stop) return decline(picked.reason, picked.detail);
      return await this.dispatch(request, picked, trace, finish, decline);
    } catch (error) {
      if (error instanceof AbortedError) {
        if (request.signal?.aborted) return finish({ kind: "cancelled", trace });
        if (coolKey) this.startCooldown(coolKey);
        // #3365: a timeout counts the question in flight as answered at the deadline, so the
        // record reads the model as at least this slow and the next limit grows.
        recordSpeed();
        // #3064: one owner for the timeout line — the gate. It always files on a gate
        // deadline, because it alone knows the turn, the model and the elapsed time.
        // Every recording layer skips its own abort line when the signal carries the
        // gate's reason, so the log shows this line exactly once. Before any model was
        // resolved there is no model to name, so the line says so.
        this.ports.noteTimeout?.({
          actorUserId: request.actorUserId,
          modelName: checkModel ?? "none",
          ...(request.turnId ? { turnId: request.turnId } : {}),
          ...(request.parentId ? { parentId: request.parentId } : {}),
          latencyMs: Math.max(0, this.ports.now() - startedAt)
        });
        return decline("timeout");
      }
      if (error instanceof FailedError) {
        if (coolKey) this.startCooldown(coolKey);
        return decline("classifier_error");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onCancel);
    }
  }

  private quickCheck(request: GateRequest): GateDeclineReason | null {
    if (request.incognito) return "private_chat";
    if (request.mode === "off") return "gate_off";
    if (request.hasAttachment) return "attachment";
    if (new TextEncoder().encode(request.message).length > GATE_LIMITS.maxMessageBytes) {
      return "oversize";
    }
    return null;
  }

  private countQuestion(signal: AbortSignal): void {
    this.questions.set(signal, (this.questions.get(signal) ?? 0) + 1);
  }

  private startCooldown(key: string): void {
    this.coolingUntil.set(key, this.ports.now() + GATE_LIMITS.cooldownMs);
  }

  /** Runs both questions and the argument step. Returns the validated pick, or why not. */
  private async classify(
    request: GateRequest,
    signal: AbortSignal,
    trace: { -readonly [K in keyof GateTrace]: GateTrace[K] },
    hooks: ClassifyHooks
  ): Promise<Pick | Stop> {
    const listed = await this.run(this.ports.listTools(), signal);
    const declared = listed.filter(
      (tool) =>
        gateEligibilityProblem(tool, null) !== "not_declared" &&
        (request.mode !== "on" || this.ports.isReleased(tool))
    );
    if (declared.length === 0) return new Stop("no_eligible_tools");

    const handle = await this.run(this.ports.classifier.resolve(), signal);
    if (!handle) return new Stop("no_classifier");
    hooks.model(handle.model);
    const coolKey = `${request.actorUserId}|${handle.model.id}`;
    if ((this.coolingUntil.get(coolKey) ?? 0) > this.ports.now()) return new Stop("cooling_off");
    hooks.coolKey(coolKey);

    const menu = declared.filter(
      (tool) => gateEligibilityProblem(tool, handle.capability) === null
    );
    if (menu.length === 0) return new Stop("no_eligible_tools");

    // #2956: every check in this turn carries the turn and its answer line, so
    // the activity page groups the checks with the answer they informed.
    const activity: GenerateChoicesActivity = {
      ownerUserId: request.actorUserId,
      actionCode: "chat.tool_check",
      ...(request.turnId ? { turnId: request.turnId } : {}),
      ...(request.parentId ? { parentId: request.parentId } : {})
    };

    const area = await this.chooseArea(handle, request.message, menu, signal, trace, activity);
    if (area instanceof Stop) return area;
    const tool = await this.chooseTool(
      handle,
      request.message,
      area.tools,
      signal,
      trace,
      activity
    );
    if (tool instanceof Stop) return tool;

    trace.moduleId = tool.tool.moduleId;
    trace.toolName = tool.tool.name;
    trace.risk = tool.tool.risk;
    const bars = this.barCheck(tool.tool, area.answer, tool.answer);
    if (bars) return bars;

    const input = await this.chooseArguments(
      handle,
      request.message,
      tool.tool,
      signal,
      trace,
      activity
    );
    if (input instanceof Stop) return input;
    return { tool: tool.tool, input };
  }

  /** Awaits a port call under the deadline. An abort or a throw ends the whole attempt. */
  private async run<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    const result = await guard(work, signal);
    if (result.kind === "aborted") throw new AbortedError();
    if (result.kind === "threw") throw new FailedError();
    return result.value;
  }

  private async ask(
    handle: ClassifierHandle,
    state: Record<string, unknown>,
    question: ClassifierChoiceQuestion,
    signal: AbortSignal,
    trace: { -readonly [K in keyof GateTrace]: GateTrace[K] },
    activity: GenerateChoicesActivity
  ): Promise<Answer | Stop> {
    this.countQuestion(signal);
    const result = await this.run(
      this.ports.classifier.choose(handle, { state, question, signal, activity }),
      signal
    );
    if (!result.ok) return this.failure(result.error);
    noteWeakest(trace, result.confidence, result.lead);
    return { choice: result.choice, confidence: result.confidence, lead: result.lead };
  }

  private failure(
    error: "not_supported" | "needs_config" | "provider_error" | "invalid_response" | "aborted"
  ): Stop {
    if (error === "aborted") throw new AbortedError();
    if (error === "not_supported") return new Stop("classifier_not_supported");
    if (error === "needs_config") return new Stop("no_classifier");
    throw new FailedError();
  }

  private async chooseArea(
    handle: ClassifierHandle,
    message: string,
    menu: readonly GateTool[],
    signal: AbortSignal,
    trace: { -readonly [K in keyof GateTrace]: GateTrace[K] },
    activity: GenerateChoicesActivity
  ): Promise<{ tools: GateTool[]; answer: Answer } | Stop> {
    const areas = new Map<string, GateTool[]>();
    for (const tool of menu) {
      if (tool.moduleId === NONE || tool.moduleId === NEEDS_EARLIER) continue;
      areas.set(tool.moduleId, [...(areas.get(tool.moduleId) ?? []), tool]);
    }
    if (areas.size === 0) return new Stop("no_eligible_tools");

    const criteria: Record<string, string> = {};
    for (const [moduleId, tools] of areas) criteria[moduleId] = tools[0]!.moduleDescription;
    criteria[NONE] =
      "The message needs the default assistant: open-ended, conversational, writing or reasoning.";
    criteria[NEEDS_EARLIER] =
      "The message only makes sense with earlier turns, such as 'make it brighter' or 'do that again'.";

    const answer = await this.ask(
      handle,
      { message },
      {
        instructions:
          "Which area can handle this message with one tool call? Choose none if unsure.",
        criteria
      },
      signal,
      trace,
      activity
    );
    if (answer instanceof Stop) return answer;
    if (answer.choice === NONE) return new Stop("none");
    if (answer.choice === NEEDS_EARLIER) return new Stop("needs_earlier_conversation");
    if (!meetsLead(answer.lead)) return new Stop("low_lead");
    return { tools: areas.get(answer.choice) ?? [], answer };
  }

  private async chooseTool(
    handle: ClassifierHandle,
    message: string,
    tools: readonly GateTool[],
    signal: AbortSignal,
    trace: { -readonly [K in keyof GateTrace]: GateTrace[K] },
    activity: GenerateChoicesActivity
  ): Promise<{ tool: GateTool; answer: Answer } | Stop> {
    const usable = tools.filter((tool) => tool.name !== NONE);
    if (usable.length === 0) return new Stop("no_eligible_tools");
    const criteria: Record<string, string> = {};
    for (const tool of usable) criteria[tool.name] = tool.classifier!.description;
    criteria[NONE] = "No tool here fits the message.";

    const answer = await this.ask(
      handle,
      { message },
      { instructions: "Which tool fits this message? Choose none if unsure.", criteria },
      signal,
      trace,
      activity
    );
    if (answer instanceof Stop) return answer;
    if (answer.choice === NONE) return new Stop("none");
    if (!meetsLead(answer.lead)) return new Stop("low_lead");
    const tool = usable.find((entry) => entry.name === answer.choice);
    if (!tool) throw new FailedError();
    return { tool, answer };
  }

  /** The confidence bar depends on the tool, so the first answer is checked once the tool is known. */
  private barCheck(tool: GateTool, ...answers: Answer[]): Stop | null {
    for (const answer of answers) {
      if (!meetsConfidenceBar(answer.confidence, tool.risk)) return new Stop("low_confidence");
    }
    return null;
  }

  private async chooseArguments(
    handle: ClassifierHandle,
    message: string,
    tool: GateTool,
    signal: AbortSignal,
    trace: { -readonly [K in keyof GateTrace]: GateTrace[K] },
    activity: GenerateChoicesActivity
  ): Promise<Record<string, unknown> | Stop> {
    const plan = planArguments(tool);
    const options = await this.optionsFor(tool, plan, signal);
    if (options instanceof Stop) return options;

    let input: Record<string, unknown>;
    if (plan.some((arg) => arg.kind === "extract")) {
      this.countQuestion(signal);
      const extracted = await this.run(
        this.ports.classifier.extract(handle, {
          instructions: `Extract the argument values for the tool described as: ${tool.classifier!.description}`,
          state: { message },
          schema: extractionSchema(tool, plan, options),
          signal,
          activity
        }),
        signal
      );
      if (!extracted.ok) return this.failure(extracted.error);
      const checked = checkExtractedArguments(extracted.values, plan, options);
      if (!checked.ok) return new Stop(checked.reason);
      input = checked.input;
    } else {
      // Argument names may come from a connected server; a null prototype keeps `__proto__` an own key.
      input = Object.create(null) as Record<string, unknown>;
      for (const arg of plan) {
        const offered = options.get(arg.name)!;
        const criteria = Object.fromEntries(offered.map((option) => [option.id, option.label]));
        criteria[ARGUMENT_NONE] = "None of these fit the message.";
        const answer = await this.ask(
          handle,
          { message, argument: arg.name },
          {
            instructions: `Which value of "${arg.name}" does the message ask for? Choose ${ARGUMENT_NONE} if unsure.`,
            criteria
          },
          signal,
          trace,
          activity
        );
        if (answer instanceof Stop) return answer;
        if (answer.choice === ARGUMENT_NONE) return new Stop("none");
        if (!meetsLead(answer.lead)) return new Stop("low_lead");
        if (!meetsConfidenceBar(answer.confidence, tool.risk)) return new Stop("low_confidence");
        const picked = offered.find((option) => option.id === answer.choice);
        if (!picked) throw new FailedError();
        input[arg.name] = picked.value;
      }
    }

    try {
      await validateToolInput(tool.inputSchema, input, { external: true, toolName: tool.name });
    } catch {
      return new Stop("invalid_arguments");
    }
    return input;
  }

  /** The offered values for every enum and candidates argument. Extract arguments have none. */
  private async optionsFor(
    tool: GateTool,
    plan: readonly ArgumentPlan[],
    signal: AbortSignal
  ): Promise<Map<string, readonly ArgumentOption[]> | Stop> {
    const options = new Map<string, readonly ArgumentOption[]>();
    for (const arg of plan) {
      if (arg.kind === "enum") {
        const offered = enumOptions(tool, arg.name);
        if (!offered) return new Stop("invalid_arguments");
        options.set(arg.name, offered);
      } else if (arg.kind === "candidates") {
        const raw = await guard(this.ports.loadCandidates(tool, signal), signal);
        if (raw.kind === "aborted") throw new AbortedError();
        if (raw.kind === "threw") return new Stop("candidates_unavailable");
        const normalized = normalizeClassifierCandidates(raw.value);
        const offered = normalized.ok ? candidateOptions(normalized.candidates) : null;
        if (!offered) return new Stop("candidates_unavailable");
        options.set(arg.name, offered);
      }
    }
    return options;
  }

  private async dispatch(
    request: GateRequest,
    picked: Pick,
    trace: GateTrace,
    finish: <T extends GateOutcome>(outcome: T) => T,
    decline: (reason: GateDeclineReason, detail?: string) => GateOutcome
  ): Promise<GateOutcome> {
    const { tool, input } = picked;
    const mutating = tool.risk !== "read";
    let outcome: GatewayGateOutcome;
    try {
      outcome = await this.ports.gateway.call(
        tool.name,
        input,
        request.mode === "on" ? "execute" : "dry-run"
      );
    } catch {
      // The call may have reached the handler, so a non-read tool must not be replayed.
      return mutating
        ? finish({ kind: "terminal_failure", message: UNCONFIRMED_ACTION_MESSAGE, trace })
        : decline("read_failed");
    }

    if (outcome.kind === "declined") return decline("gateway_declined", outcome.reason);
    if (outcome.kind === "would_run") return finish({ kind: "would_handle", trace });

    if (outcome.outcome !== "success") {
      return mutating
        ? finish({ kind: "terminal_failure", message: FAILED_ACTION_MESSAGE, trace })
        : decline("read_failed");
    }
    const result = outcome.response.ok ? outcome.response.structuredData : undefined;
    const reply = renderReplyTemplate(tool.classifier!.replyTemplate, result);
    if (reply === null) {
      return mutating
        ? finish({ kind: "terminal_failure", message: UNCONFIRMED_ACTION_MESSAGE, trace })
        : decline("read_failed");
    }
    return finish({ kind: "handled", reply, trace });
  }
}

interface Answer {
  readonly choice: string;
  readonly confidence: number;
  readonly lead: number;
}

interface Pick {
  readonly tool: GateTool;
  readonly input: Record<string, unknown>;
}

class AbortedError extends Error {}
class FailedError extends Error {}

function noteWeakest(
  trace: { -readonly [K in keyof GateTrace]: GateTrace[K] },
  confidence: number,
  lead: number
): void {
  trace.confidence =
    trace.confidence === undefined ? confidence : Math.min(trace.confidence, confidence);
  trace.lead = trace.lead === undefined ? lead : Math.min(trace.lead, lead);
}
