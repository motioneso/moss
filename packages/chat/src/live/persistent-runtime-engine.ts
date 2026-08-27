/**
 * `CliChatEngine` adapter over `ProviderChatRuntime` (#1557 Phase 1, P1.6).
 *
 * `chat-session-manager.ts` drives every engine through the existing offset-polling
 * `CliChatEngine` contract (`types.ts:81-112`): `submit()` fires a turn, `readNew(afterOffset)`
 * is polled until `complete`. `ProviderChatRuntime.streamEvents()` is push-based instead
 * (`provider-runtime.ts`) — this adapter is the seam that reconciles the two: a single
 * long-lived pump consumes the runtime's event stream into a monotonically-growing
 * `TranscriptRecord` buffer that `readNew` slices by index, exactly like
 * `claude-print-chat-engine.ts`'s `readStructured` re-slices its own buffer.
 *
 * Error-class mapping (plan decision, `docs/superpowers/plans/2026-08-10-1557-*.md` §Neutral
 * lifecycle contract):
 * - A failure provably before acceptance (`launch()`/`submit()` itself throws — the runtime's
 *   `submitTurn` only throws for "not launched" or a rejected stdin-write callback, both proof
 *   the text never entered the child) maps to `CliChatUnavailableError`. The manager heals +
 *   resubmits exactly once (`chat-session-manager.ts:441-448`).
 * - A `recover()` outcome of `neutral-failure` (delivery may have happened — the child died
 *   mid-turn and re-acceptance evidence says do not retry) maps to `CliChatDeliveryUnknownError`.
 *   The manager evicts the session and never resubmits (`chat-session-manager.ts:434-440`).
 * - A `recover()` outcome of `resubmitted` is NOT surfaced as an error: the runtime already
 *   relaunched the child and resent the turn transparently, so the pump re-subscribes to the
 *   fresh event stream and keeps draining into the same buffer.
 */
import { randomUUID } from "node:crypto";

import type { ProviderKind, TmuxIo } from "@moss/ai";

import {
  ClaudePersistentRuntime,
  createMcpReadinessProbe,
  type ClaudePersistentRuntimeOpts
} from "./claude-persistent-runtime.js";
import { CodexPersistentRuntime } from "./codex-persistent-runtime.js";
import { CliChatDeliveryUnknownError, CliChatUnavailableError } from "./errors.js";
import type { ProviderChatRuntime, RecoveryOutcome } from "./provider-runtime.js";
import type { CliChatEngine, EngineKillOpts, EngineLaunchOpts, TranscriptRecord } from "./types.js";

export interface ClaudePersistentRuntimeEngineOpts {
  readonly credentialFile?: string;
  /** Which provider's persistent adapter to build when `runtime` isn't injected. Defaults to
   *  `"anthropic"` so every existing call site keeps today's behavior unchanged. */
  readonly provider?: ProviderKind;
  /** Injected for tests; production callers rely on the default runtime for `provider`. */
  readonly runtime?: ProviderChatRuntime;
  readonly spawnChild?: ClaudePersistentRuntimeOpts["spawnChild"];
}

/** No provider transcript ever exists to purge (P1.0: `--no-session-persistence` adopted) —
 *  kept as a documented no-op, not an omitted method, so the incognito guard at
 *  `chat-session-manager.ts:249` (`!engine.purgeTranscripts`) admits this engine. */
const NO_RESUMABLE_TRANSCRIPT_REASON =
  "no-op: --no-session-persistence means the provider keeps no resumable transcript to purge";

export class ClaudePersistentRuntimeEngine implements CliChatEngine {
  readonly provider: ProviderKind;

  private readonly runtime: ProviderChatRuntime;

  private readonly buffer: TranscriptRecord[] = [];
  private readonly completedTurns = new Set<string>();
  private readonly failureByTurn = new Map<string, RecoveryOutcome & { kind: "neutral-failure" }>();
  private currentTurnId: string | null = null;
  private pumpPromise: Promise<void> | null = null;
  private pumpError: unknown = null;

  constructor(
    _sessionKey: string,
    io: Pick<TmuxIo, "run" | "writeFile">,
    opts: ClaudePersistentRuntimeEngineOpts = {}
  ) {
    this.provider = opts.provider ?? "anthropic";
    if (opts.runtime) {
      this.runtime = opts.runtime;
    } else if (this.provider === "openai-compatible") {
      this.runtime = new CodexPersistentRuntime({
        io,
        tokenEnvPath: opts.credentialFile,
        spawnChild: opts.spawnChild
      });
    } else {
      this.runtime = new ClaudePersistentRuntime({
        io,
        credentialFile: opts.credentialFile,
        spawnChild: opts.spawnChild
      });
    }
  }

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    const mcpReadiness = createMcpReadinessProbe(opts.mcpServerUrl ?? "", opts.mcpToken ?? "");
    try {
      await this.runtime.launch({ ...opts, mcpReadiness });
    } catch (err) {
      // Provably pre-acceptance: launch never reached "ready", so no user frame could ever
      // have been written. Safe for the manager to heal + resubmit.
      throw new CliChatUnavailableError("could not start the persistent assistant session", {
        cause: err
      });
    }
    this.startPump();
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    const turnId = randomUUID();
    this.currentTurnId = turnId;
    try {
      await this.runtime.submitTurn(turnId, text);
    } catch (err) {
      // `submitTurn` only throws for "not launched" or a rejected stdin-write callback — both
      // proof the text never entered the child (provably pre-acceptance).
      throw new CliChatUnavailableError("could not submit the turn to the persistent session", {
        cause: err
      });
    }
  }

  async interrupt(): Promise<void> {
    await this.runtime.cancel(this.currentTurnId ?? "");
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.pumpError !== null) {
      const err = this.pumpError;
      this.pumpError = null;
      // Unexpected — the runtime contract never documents streamEvents()/recover() throwing.
      // Treat conservatively as delivery-unknown (never auto-retry) rather than assume safety.
      throw new CliChatDeliveryUnknownError(
        err instanceof Error ? err.message : "persistent runtime event stream failed"
      );
    }

    const turnId = this.currentTurnId;
    if (turnId !== null) {
      const failure = this.failureByTurn.get(turnId);
      if (failure) {
        this.failureByTurn.delete(turnId);
        throw new CliChatDeliveryUnknownError(failure.reason);
      }
    }

    const records = this.buffer.slice(afterOffset);
    const offset = this.buffer.length;
    const complete = turnId !== null && this.completedTurns.has(turnId);
    return { records, offset, complete };
  }

  async isAlive(): Promise<boolean> {
    return (await this.runtime.health()).alive;
  }

  async kill(_opts?: EngineKillOpts): Promise<void> {
    await this.runtime.reap("shutdown");
  }

  /** No-op — see `NO_RESUMABLE_TRANSCRIPT_REASON`. Present (not omitted) so the incognito
   *  guard admits this engine. */
  async purgeTranscripts(): Promise<void> {
    void NO_RESUMABLE_TRANSCRIPT_REASON;
  }

  /** One pump for the life of the engine: drains `streamEvents()` into `buffer`, and on a
   *  `turn-failed` event asks the runtime to `recover()` — resubmitting transparently
   *  (re-subscribing to the fresh post-relaunch stream) or recording a terminal
   *  `neutral-failure` for `readNew` to surface as `CliChatDeliveryUnknownError`. */
  private startPump(): void {
    if (this.pumpPromise !== null) return;
    this.pumpPromise = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        let failedTurnId: string | null = null;
        for await (const event of this.runtime.streamEvents()) {
          if (event.kind === "record") {
            this.buffer.push(event.record);
          } else if (event.kind === "turn-complete") {
            this.completedTurns.add(event.turnId);
          } else if (event.kind === "turn-failed") {
            failedTurnId = event.turnId;
            break;
          }
        }
        if (failedTurnId === null) return; // stream ended cleanly (reaped/shut down)

        const recovery = await this.runtime.recover(failedTurnId);
        if (recovery.kind === "resubmitted") {
          // The runtime already relaunched the child and resent the turn. Re-subscribing to
          // streamEvents() picks up the NEW decoder (the old generator ended when the old
          // decoder's stdout closed) and keeps draining into the same buffer.
          continue;
        }
        this.failureByTurn.set(failedTurnId, recovery);
        return; // terminal: this engine instance is done; readNew surfaces the failure once.
      }
    } catch (err) {
      this.pumpError = err;
    }
  }
}
