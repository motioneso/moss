/**
 * Bounded, push-based incremental line splitter over a persistent Claude child's
 * `--output-format stream-json` stdout (#1557 Phase 1, P1.2).
 *
 * Replaces the one-shot structured engine's unbounded accumulator
 * (`claude-print-chat-engine.ts`'s `structuredOutput += chunk`, `:99-101`) with two explicit
 * bounds. Feed raw stdout text via `write()` as it arrives and stdout close via `end()`; consume
 * decoded `RuntimeTurnEvent`s via `events()` as they are parsed — there is no offset/`readNew`
 * polling API, this is push-based straight into `ProviderChatRuntime.streamEvents()`.
 */

import type { ProviderKind } from "@moss/ai";

import { looksLikeLoginRejection, recordProviderLoginRejected } from "./provider-probe.js";
import type { RuntimeTurnEvent } from "./provider-runtime.js";

/** This decoder reads one provider's stream-json output; a refused sign-in it sees belongs to
 *  that provider. Callers with a different provider pass their own `reportLoginRejected`. */
const DECODED_PROVIDER: ProviderKind = "anthropic";

/**
 * Bound on a single stream-json line (one assistant message chunk or tool_use payload). 2MB is
 * comfortably larger than any single frame Claude Code emits in normal operation; past this the
 * child is misbehaving — the exact failure class the unbounded `structuredOutput +=`
 * accumulator could not catch at all.
 */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * Bound on bytes held in memory for one child: the current not-yet-newline-terminated partial
 * line plus any decoded events not yet drained by the consumer. A live runtime holds one decoder
 * per warm child, so this bounds worst-case per-child memory if the consumer (the adapter's
 * `streamEvents()` reader) stalls, independent of any single frame's size. Kept well above
 * `MAX_FRAME_BYTES` so a single in-bound frame never trips it on its own.
 */
export const MAX_TOTAL_BUFFERED_BYTES = 8 * 1024 * 1024;

const FRAME_TOO_LARGE_REASON =
  "The assistant process produced a single output line larger than this runtime allows and was stopped.";
const TOTAL_BUFFERED_EXCEEDED_REASON =
  "The assistant process produced more output than this runtime buffers and was stopped.";
const EOF_WITHOUT_TERMINAL_REASON = "The assistant process ended before completing this turn.";
export const PROVIDER_ERROR_RESULT_REASON =
  "The assistant process reported an error completing this turn.";
/**
 * #2242 (round 3): the provider answered, and what it said was "this sign-in is no good". That is
 * a different thing from the assistant crashing, and telling someone to try again is the wrong
 * advice — they have to sign in again. Composed here, never quoting the provider's own text, so
 * nothing from the raw error (which can carry credential material) reaches a person or a log.
 */
export const LOGIN_REJECTED_RESULT_REASON =
  "The provider refused the saved sign-in for this assistant, so this message was not answered. Log in again to continue.";

export interface PersistentStreamDecoderOpts {
  /** Invoked at most once, when a bound is exceeded. The decoder only decides when to kill —
   *  the caller (the P1.3 adapter, which owns the child process) does the actual kill. */
  readonly killChild: (reason: string) => void;
  /** Override for tests; production callers should rely on the `MAX_FRAME_BYTES` default. */
  readonly maxFrameBytes?: number;
  /** Override for tests; production callers should rely on the `MAX_TOTAL_BUFFERED_BYTES` default. */
  readonly maxTotalBufferedBytes?: number;
  /**
   * #2242 (round 3): called when the provider's own answer says it refused the sign-in, so the
   * saved "the login works" answer is dropped and the next readiness check asks for a fresh
   * login. Defaults to reporting it for the provider this stream belongs to. The stream never
   * sees the credential itself, so the report names no credential — an explicit fresh login
   * clears it, as does a readiness check that really succeeds.
   */
  readonly reportLoginRejected?: () => void;
}

type QueueWaiter = (result: IteratorResult<RuntimeTurnEvent>) => void;

export class PersistentStreamDecoder {
  private readonly maxFrameBytes: number;
  private readonly maxTotalBufferedBytes: number;
  private readonly killChild: (reason: string) => void;
  private readonly reportLoginRejected: () => void;

  private buffer = "";
  private currentTurnId: string | null = null;
  private sawTerminalForTurn = false;
  private sawReplyForTurn = false;
  private killed = false;
  private ended = false;

  private readonly queue: RuntimeTurnEvent[] = [];
  private queuedBytes = 0;
  private readonly waiters: QueueWaiter[] = [];

  constructor(opts: PersistentStreamDecoderOpts) {
    this.killChild = opts.killChild;
    this.maxFrameBytes = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.maxTotalBufferedBytes = opts.maxTotalBufferedBytes ?? MAX_TOTAL_BUFFERED_BYTES;
    this.reportLoginRejected =
      opts.reportLoginRejected ?? (() => recordProviderLoginRejected(DECODED_PROVIDER));
  }

  /** Call once per submitted turn, before writing the user frame. Only one turn is ever in
   *  flight on a given child (Phase 1 has no pipelining). */
  beginTurn(turnId: string): void {
    this.currentTurnId = turnId;
    this.sawTerminalForTurn = false;
    this.sawReplyForTurn = false;
  }

  /** Feed raw stdout text as it arrives. */
  write(chunk: string): void {
    if (this.killed || this.ended) return;
    this.buffer += chunk;
    this.drainLines();
  }

  /** stdout closed (EOF) — the child died or exited. */
  end(): void {
    if (this.killed || this.ended) return;
    this.ended = true;
    if (this.currentTurnId !== null && !this.sawTerminalForTurn) {
      this.emit({
        kind: "turn-failed",
        turnId: this.currentTurnId,
        outcome: { kind: "neutral-failure", reason: EOF_WITHOUT_TERMINAL_REASON }
      });
    }
    this.closeQueue();
  }

  async *events(): AsyncIterable<RuntimeTurnEvent> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        this.queuedBytes -= approxSize(queued);
        yield queued;
        continue;
      }
      if (this.ended || this.killed) return;
      const next = await new Promise<IteratorResult<RuntimeTurnEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  private drainLines(): void {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > this.maxFrameBytes) {
        this.failBound(FRAME_TOO_LARGE_REASON);
        return;
      }
      this.processLine(line);
      if (this.killed) return;
      if (this.buffer.length + this.queuedBytes > this.maxTotalBufferedBytes) {
        this.failBound(TOTAL_BUFFERED_EXCEEDED_REASON);
        return;
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > this.maxFrameBytes) {
      this.failBound(FRAME_TOO_LARGE_REASON);
    } else if (this.buffer.length + this.queuedBytes > this.maxTotalBufferedBytes) {
      this.failBound(TOTAL_BUFFERED_EXCEEDED_REASON);
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      console.warn("[persistent-stream-decoder] malformed stream-json line, skipping");
      return;
    }
    this.mapRecord(record);
  }

  private mapRecord(record: Record<string, unknown>): void {
    const turnId = this.currentTurnId;
    if (turnId === null) return; // no turn in flight; ignore stray frames

    if (record["type"] === "result") {
      this.sawTerminalForTurn = true;
      // #2242 (round 3): keep WHICH kind of failure this was. A refused sign-in used to be
      // flattened into a general failure here, so the one place that learns a login has died
      // during a real conversation threw that knowledge away and the saved success stood.
      // Checked whether or not some reply text already arrived this turn: the provider can
      // answer a little and then refuse the sign-in, and that refusal is just as final. It was
      // being read only when nothing had been said yet, so a part-answered turn left the saved
      // "the login works" answer standing and the next check reused it.
      const loginRejected = looksLikeLoginRejection(failureText(record));
      if (loginRejected) this.reportLoginRejected();
      if (!this.sawReplyForTurn) {
        const isUsableResult = record["is_error"] !== true && record["subtype"] === "success";
        if (!isUsableResult) {
          this.emit({
            kind: "turn-failed",
            turnId,
            outcome: {
              kind: "neutral-failure",
              reason: loginRejected ? LOGIN_REJECTED_RESULT_REASON : PROVIDER_ERROR_RESULT_REASON,
              ...(loginRejected ? { loginRejected: true } : {})
            }
          });
          return;
        }
        const result = record["result"];
        if (typeof result === "string" && result.length > 0) {
          this.sawReplyForTurn = true;
          this.emit({ kind: "record", turnId, record: { kind: "reply", text: result } });
        }
      }
      this.emit({ kind: "turn-complete", turnId });
      return;
    }
    if (record["type"] !== "assistant") return;

    const message = record["message"];
    if (!isRecord(message)) return;
    const content = message["content"];
    if (!Array.isArray(content)) return;

    if (message["stop_reason"] === "end_turn") {
      const text = content
        .filter(isRecord)
        .filter((item): item is Record<string, unknown> & { text: string } => {
          return item["type"] === "text" && typeof item["text"] === "string";
        })
        .map((item) => item.text)
        .join("\n");
      if (text.length > 0) {
        this.sawReplyForTurn = true;
        this.emit({ kind: "record", turnId, record: { kind: "reply", text } });
      }
      return;
    }

    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item["type"] === "thinking" && typeof item["thinking"] === "string") {
        this.emit({ kind: "record", turnId, record: { kind: "thinking", text: item["thinking"] } });
      } else if (item["type"] === "tool_use" && typeof item["name"] === "string") {
        this.emit({
          kind: "record",
          turnId,
          record: { kind: "tool", text: item["name"], toolName: item["name"] }
        });
      } else if (item["type"] === "text" && typeof item["text"] === "string") {
        this.emit({ kind: "record", turnId, record: { kind: "status", text: item["text"] } });
      }
    }
  }

  private failBound(reason: string): void {
    this.killed = true;
    const turnId = this.currentTurnId;
    this.buffer = "";
    this.killChild(reason);
    if (turnId !== null) {
      this.emit({ kind: "turn-failed", turnId, outcome: { kind: "neutral-failure", reason } });
    }
    this.closeQueue();
  }

  private emit(event: RuntimeTurnEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
    this.queuedBytes += approxSize(event);
  }

  private closeQueue(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }
}

/**
 * The failure text a result frame carries, gathered from its error-carrying fields only — never
 * from the assistant's own words, so an ordinary reply that happens to mention a sign-in cannot
 * be mistaken for the provider refusing one. The gathered text is only ever matched against, and
 * is never emitted or logged.
 */
function failureText(record: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of ["error", "result"]) {
    const value = record[field];
    if (typeof value === "string") parts.push(value);
  }
  const errors = record["errors"];
  if (Array.isArray(errors)) {
    for (const entry of errors) if (typeof entry === "string") parts.push(entry);
  }
  return parts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approxSize(event: RuntimeTurnEvent): number {
  return JSON.stringify(event).length;
}
