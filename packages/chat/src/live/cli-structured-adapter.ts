import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { sanitizeSessionKey } from "./cli-session-lifecycle.js";

import type {
  GenerateStructuredProviderInput,
  ProviderKind,
  StructuredProviderAdapter,
  StructuredProviderResult,
  StructuredRunPriority,
  StructuredTelemetryEvent
} from "@moss/ai";

import { CliChatUnavailableError } from "./errors.js";
import { selectEngineFactory, type ChatEngineFactory } from "./runtime.js";
import type { CliChatEngine } from "./types.js";

/** #1422: one fixed directory per calling service so the CLI's cwd (near the top of its system
 * prompt) stays identical across one-shot calls and the prompt-cache prefix can hit. Destroyed and
 * recreated at this same path on every call (see `generateOneShotStructured`'s finally block) so
 * private per-call prompt content never survives between calls. */
const STRUCTURED_ONE_SHOT_ROOT = join(tmpdir(), "jarv1s-structured");

function oneShotStructuredDir(service: string | undefined): string {
  return join(STRUCTURED_ONE_SHOT_ROOT, sanitizeSessionKey(service ?? "unscoped"));
}

const CLI_STRUCTURED_TIMEOUT_MS = 120_000;
const CLI_STRUCTURED_POLL_MS = 100;
let activeCliStructuredRuns = 0;
type CliStructuredWaiter = {
  readonly priority: StructuredRunPriority;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
};
const cliStructuredWaiters: Record<StructuredRunPriority, CliStructuredWaiter[]> = {
  foreground: [],
  background: []
};

function releaseCliStructuredSlot(): void {
  const next = cliStructuredWaiters.foreground.shift() ?? cliStructuredWaiters.background.shift();
  if (!next) {
    activeCliStructuredRuns -= 1;
    return;
  }
  next.signal?.removeEventListener("abort", next.abort!);
  activeCliStructuredRuns = 1;
  next.resolve(releaseCliStructuredSlot);
}

function acquireCliStructuredSlot(
  priority: StructuredRunPriority,
  signal?: AbortSignal
): Promise<() => void> {
  if (signal?.aborted) {
    const error = new Error("aborted");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  if (activeCliStructuredRuns === 0 && cliStructuredWaiters.foreground.length === 0) {
    activeCliStructuredRuns = 1;
    return Promise.resolve(releaseCliStructuredSlot);
  }
  return new Promise((resolve, reject) => {
    const waiter: CliStructuredWaiter = { priority, resolve, reject, signal };
    waiter.abort = () => {
      const queue = cliStructuredWaiters[priority];
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      signal?.removeEventListener("abort", waiter.abort!);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    cliStructuredWaiters[priority].push(waiter);
    signal?.addEventListener("abort", waiter.abort, { once: true });
  });
}

/**
 * #982/#869/#981: chat-owned implementation of ai's structured CLI port. It reuses the exact
 * one-shot engine factory selected for chat (tmux/herdr or authenticated cli-runner RPC), returns
 * raw assistant text, and leaves parsing/Ajv repair to `generateStructured`.
 */
export class CliStructuredAdapter implements StructuredProviderAdapter {
  private readonly scopedSessions = new Map<string, ScopedStructuredSession>();

  constructor(
    private readonly provider: ProviderKind,
    private readonly engineFactory: ChatEngineFactory,
    private readonly timeoutMs = CLI_STRUCTURED_TIMEOUT_MS,
    private readonly pollMs = CLI_STRUCTURED_POLL_MS
  ) {}

  async generateStructured(
    input: GenerateStructuredProviderInput
  ): Promise<StructuredProviderResult> {
    if (input.scope) return this.generateScopedStructured(input);
    return this.generateOneShotStructured(input);
  }

  private async generateOneShotStructured(
    input: GenerateStructuredProviderInput
  ): Promise<StructuredProviderResult> {
    const startedAt = Date.now();
    const priority = input.priority ?? "foreground";
    const emit = (event: StructuredTelemetryEvent) => input.telemetry?.emit({ ...event, priority });
    let exit: "complete" | "busy" | "timeout" | "no-reply" | "error" = "error";
    emit({ kind: "invoked" });
    if (activeCliStructuredRuns >= 1) emit({ kind: "busy", exit: "busy" });
    let release: (() => void) | undefined;
    try {
      release = await acquireCliStructuredSlot(priority, input.signal);
    } catch (error) {
      exit = input.signal?.aborted ? "timeout" : "error";
      emit({ kind: "exit", exit });
      emit({ kind: "elapsed", elapsedMs: Date.now() - startedAt });
      throw error;
    }

    let neutralDir: string | undefined;
    let engine: CliChatEngine | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    let timedOut = false;

    try {
      neutralDir = oneShotStructuredDir(input.service);
      await mkdir(neutralDir, { recursive: true, mode: 0o700 });
      const personaPath = join(neutralDir, "persona.md");
      await writeFile(personaPath, "You produce structured JSON only.\n", { mode: 0o600 });
      const activeEngine = await this.engineFactory(this.provider, `structured-${randomUUID()}`, {
        executionMode: "non_interactive"
      });
      engine = activeEngine;
      const stopped = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          emit({ kind: "timeout" });
          void activeEngine.kill().catch(() => undefined);
          reject(new CliChatUnavailableError("CLI structured generation timed out"));
        }, this.timeoutMs);
        abort = () => {
          void activeEngine.interrupt().catch(() => undefined);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        input.signal?.addEventListener("abort", abort, { once: true });
      });
      const generated = this.run(activeEngine, neutralDir, personaPath, input);
      try {
        const rawText = await Promise.race([generated, stopped]);
        exit = "complete";
        return { rawText, usage: { inputTokens: 0, outputTokens: 0 } };
      } catch (error) {
        await activeEngine.kill().catch(() => undefined);
        const final = await activeEngine.readNew(0).catch(() => null);
        const reply = final?.records
          .slice()
          .reverse()
          .find((record) => record.kind === "reply")?.text;
        if (reply !== undefined) {
          emit({ kind: "late-read" });
          exit = timedOut ? "timeout" : "complete";
          return { rawText: reply, usage: { inputTokens: 0, outputTokens: 0 } };
        }
        exit = timedOut
          ? "timeout"
          : input.signal?.aborted
            ? "timeout"
            : error instanceof CliChatUnavailableError
              ? "no-reply"
              : "error";
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) input.signal?.removeEventListener("abort", abort);
      await engine?.kill().catch(() => undefined);
      // #981: structured prompts can contain private module data; unlike durable chat, this
      // one-shot surface has no transcript-retention purpose.
      await engine?.purgeTranscripts?.().catch(() => undefined);
      if (neutralDir) await rm(neutralDir, { recursive: true, force: true });
      release();
      emit({ kind: "exit", exit });
      emit({ kind: "elapsed", elapsedMs: Date.now() - startedAt });
    }
  }

  private async generateScopedStructured(
    input: GenerateStructuredProviderInput
  ): Promise<StructuredProviderResult> {
    const startedAt = Date.now();
    const priority = input.priority ?? "foreground";
    const emit = (event: StructuredTelemetryEvent) => input.telemetry?.emit({ ...event, priority });
    const key = structuredScopeKey(input.scope!);
    let exit: "complete" | "busy" | "timeout" | "no-reply" | "error" = "error";
    let release: (() => void) | undefined;
    let session: ScopedStructuredSession | undefined;
    let succeeded = false;
    emit({ kind: "invoked" });
    try {
      if (activeCliStructuredRuns >= 1) emit({ kind: "busy", exit: "busy" });
      release = await acquireCliStructuredSlot(priority, input.signal);
      session = this.scopedSessions.get(key);
      if (!session) {
        const engine = await this.engineFactory(this.provider, `structured-${randomUUID()}`, {
          executionMode: "non_interactive"
        });
        if (!isCliStructuredEngine(engine)) {
          await engine.kill().catch(() => undefined);
          throw new CliChatUnavailableError("CLI structured stream is unavailable");
        }
        const neutralDir = await mkdtemp(join(tmpdir(), "jarv1s-structured-"));
        const personaPath = join(neutralDir, "persona.md");
        try {
          await writeFile(personaPath, "You produce structured JSON only.\n", { mode: 0o600 });
          const candidate: ScopedStructuredSession = { engine, neutralDir, offset: 0 };
          session = candidate;
          this.scopedSessions.set(key, session);
          const launched = await engine.launchStructured({
            neutralDir,
            personaPath,
            personaText: "You produce structured JSON only.",
            model: input.model.provider_model_id,
            schema: input.schema
          });
          session.offset = launched.offset;
        } catch (error) {
          if (session) await this.closeScopedSession(key, session);
          else {
            await engine.kill().catch(() => undefined);
            await rm(neutralDir, { recursive: true, force: true });
          }
          session = undefined;
          throw error;
        }
      }

      if (!(await session.engine.isAlive())) {
        throw new CliChatUnavailableError("CLI structured stream exited without a reply");
      }
      await session.engine.submitStructured(buildCliStructuredPrompt(input));
      const controller = new AbortController();
      const abort = () => controller.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          emit({ kind: "timeout" });
          controller.abort();
          reject(new CliChatUnavailableError("CLI structured generation timed out"));
        }, this.timeoutMs);
      });
      try {
        const rawText = await Promise.race([
          this.readScopedTurn(session, input, controller.signal),
          stopped
        ]);
        exit = "complete";
        succeeded = true;
        return { rawText, usage: { inputTokens: 0, outputTokens: 0 } };
      } catch (error) {
        exit = timedOut || input.signal?.aborted ? "timeout" : "no-reply";
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
      }
    } catch (error) {
      if (input.signal?.aborted) exit = "timeout";
      throw error;
    } finally {
      if (session && (!succeeded || input.closeScope)) {
        await this.closeScopedSession(key, session);
      }
      release?.();
      emit({ kind: "exit", exit });
      emit({ kind: "elapsed", elapsedMs: Date.now() - startedAt });
    }
  }

  private async readScopedTurn(
    session: ScopedStructuredSession,
    input: GenerateStructuredProviderInput,
    signal: AbortSignal
  ): Promise<string> {
    let firstReadable = false;
    for (;;) {
      if (signal.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      const next = await session.engine.readStructured(session.offset);
      session.offset = next.offset;
      if (next.text !== undefined) {
        if (!firstReadable) {
          firstReadable = true;
          input.telemetry?.emit({
            kind: "first-readable",
            priority: input.priority ?? "foreground"
          });
        }
        if (next.complete) return next.text;
      }
      if (next.complete || !(await session.engine.isAlive())) {
        throw new CliChatUnavailableError("CLI structured stream exited without a reply");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async closeScopedSession(key: string, session: ScopedStructuredSession): Promise<void> {
    if (this.scopedSessions.get(key) === session) this.scopedSessions.delete(key);
    await session.engine.kill().catch(() => undefined);
    await session.engine.purgeTranscripts?.().catch(() => undefined);
    session.offset = 0;
    await rm(session.neutralDir, { recursive: true, force: true });
  }

  private async run(
    engine: CliChatEngine,
    neutralDir: string,
    personaPath: string,
    input: GenerateStructuredProviderInput
  ): Promise<string> {
    let firstReadable = false;
    let offset = (
      await engine.launch({
        neutralDir,
        personaPath,
        personaText: "You produce structured JSON only.",
        model: input.model.provider_model_id
      })
    ).offset;
    await engine.submit(buildCliStructuredPrompt(input));

    for (;;) {
      const next = await engine.readNew(offset);
      offset = next.offset;
      const reply = [...next.records].reverse().find((record) => record.kind === "reply")?.text;
      if (reply !== undefined && !firstReadable) {
        firstReadable = true;
        input.telemetry?.emit({ kind: "first-readable", priority: input.priority ?? "foreground" });
      }
      if (next.complete) {
        if (reply !== undefined) return reply;
        throw new CliChatUnavailableError("CLI structured generation completed without a reply");
      }
      if (!(await engine.isAlive())) {
        throw new CliChatUnavailableError("CLI structured generation exited without a reply");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}

type ScopedStructuredSession = {
  readonly engine: CliChatEngine & CliStructuredEngine;
  readonly neutralDir: string;
  offset: number;
};

type CliStructuredEngine = {
  launchStructured(opts: {
    readonly neutralDir: string;
    readonly personaPath: string;
    readonly personaText?: string;
    readonly model?: string;
    readonly schema: Record<string, unknown>;
  }): Promise<{ readonly offset: number }>;
  submitStructured(text: string): Promise<void>;
  readStructured(afterOffset: number): Promise<{
    readonly text?: string;
    readonly offset: number;
    readonly complete: boolean;
  }>;
};

function isCliStructuredEngine(
  engine: CliChatEngine
): engine is CliChatEngine & CliStructuredEngine {
  return (
    typeof (engine as Partial<CliStructuredEngine>).launchStructured === "function" &&
    typeof (engine as Partial<CliStructuredEngine>).submitStructured === "function" &&
    typeof (engine as Partial<CliStructuredEngine>).readStructured === "function"
  );
}

function structuredScopeKey(scope: NonNullable<GenerateStructuredProviderInput["scope"]>): string {
  return [scope.actorUserId, scope.connectorAccountId, scope.lineageId].join("\u0000");
}

/** #982 composition helper: resolve the transport once, then create provider-specific adapters. */
export function createCliStructuredAdapterFactory(
  engineFactory: ChatEngineFactory = selectEngineFactory().factory
): (kind: ProviderKind) => CliStructuredAdapter {
  const adapters = new Map<ProviderKind, CliStructuredAdapter>();
  return (kind) => {
    const existing = adapters.get(kind);
    if (existing) return existing;
    const adapter = new CliStructuredAdapter(kind, engineFactory);
    adapters.set(kind, adapter);
    return adapter;
  };
}

function buildCliStructuredPrompt(input: GenerateStructuredProviderInput): string {
  const conversation = input.messages
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n\n");
  return [
    conversation,
    `JSON Schema:\n${JSON.stringify(input.schema)}`,
    "Respond with ONLY a JSON object matching this schema. No markdown or commentary."
  ].join("\n\n");
}
