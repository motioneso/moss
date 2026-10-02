/**
 * Plan 3.6b (#2890), ruling 15: one model activity row per live chat turn, including CLI chat
 * turns. Live chat runs a whole CLI session, so no provider adapter sees the call; this wraps the
 * session engine and records at the turn boundary. Inner tool-loop calls are not visible, so the
 * row is per turn, matching the plan.
 *
 * Only transport facts are recorded: kind, a fixed action label, the outcome and the session's
 * actual model (from the launch options). No message text, prompt, tool argument or identity ever
 * enters the row — there is no field for one.
 *
 * The wrapper uses a Proxy so every optional engine method the session manager probes
 * (`startsToolClientPerTurn`, `resetActivityDeadline`, `purgeTranscripts`, `getLastSubmitDiagnostics`
 * and the rest) passes through unchanged. It records exactly one row per user turn:
 *  - `ok` when a submitted turn reaches `readNew(...).complete`;
 *  - `aborted` when `interrupt` arrives with a turn still pending (a caller Stop);
 *  - `error` when a pending turn is abandoned — a new `submit` starts before the old one finished
 *    (the idle watchdog, or a heal-and-relaunch that never resumed the old turn) — or `readNew`
 *    throws while a turn is pending.
 * A `submit` that throws does NOT record on its own: the manager retries a genuinely unavailable
 * engine, and recording both the failed attempt and the successful retry would double-log one turn.
 */

import { recordModelActivity, type ModelActivityRecorder } from "@moss/ai";

import type { CliChatEngine, EngineLaunchOpts, TranscriptRecord } from "./types.js";

function outcomeResult(outcome: "ok" | "error" | "aborted"): string {
  return outcome === "ok" ? "completed" : outcome === "aborted" ? "stopped" : "failed";
}

/** Wrap a chat session engine so each turn records one model activity row. */
export function withTurnActivityRecording(
  engine: CliChatEngine,
  onModelCall: ModelActivityRecorder = recordModelActivity
): CliChatEngine {
  let modelName = engine.provider as string;
  /** The in-flight turn, and whether its submit failed and the manager may retry it. */
  let pending: { readonly failed: boolean } | null = null;

  const record = (outcome: "ok" | "error" | "aborted"): void => {
    onModelCall({
      kind: "chat",
      action: "chat",
      outcome,
      modelName,
      result: outcomeResult(outcome)
    });
  };

  return new Proxy(engine, {
    get(target, property, receiver) {
      switch (property) {
        case "launch":
          return async (opts: EngineLaunchOpts) => {
            // The resolved model for this session; falls back to the provider kind when the CLI
            // rides its own account model (the "default" sentinel omits --model).
            modelName = opts.model ?? (target.provider as string);
            return target.launch(opts);
          };
        case "submit":
          return async (text: string) => {
            // A new turn starting while one is still pending means the manager abandoned the old
            // one (idle watchdog, or a heal-and-relaunch). Record it as an error. A pending turn
            // whose submit already failed is a retry — replace it silently, do not double-log.
            if (pending && !pending.failed) record("error");
            pending = { failed: false };
            try {
              await target.submit(text);
            } catch (error) {
              pending = { failed: true };
              throw error;
            }
          };
        case "readNew":
          return async (afterOffset: number) => {
            let result: { records: TranscriptRecord[]; offset: number; complete: boolean };
            try {
              result = await target.readNew(afterOffset);
            } catch (error) {
              if (pending) {
                pending = null;
                record("error");
              }
              throw error;
            }
            if (result.complete && pending) {
              const failed = pending.failed;
              pending = null;
              record(failed ? "error" : "ok");
            }
            return result;
          };
        case "interrupt":
          return async () => {
            if (pending) {
              pending = null;
              record("aborted");
            }
            await target.interrupt();
          };
        default:
          return Reflect.get(target, property, receiver);
      }
    }
  });
}
