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
 * and the rest) passes through unchanged. It records:
 *  - `ok` when a submitted turn reaches `readNew(...).complete`;
 *  - `error` when `submit` throws (the turn never reached the model);
 *  - `aborted` when `interrupt` arrives with a turn still pending (a caller Stop).
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
  let turnPending = false;

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
            try {
              await target.submit(text);
              turnPending = true;
            } catch (error) {
              record("error");
              throw error;
            }
          };
        case "readNew":
          return async (afterOffset: number) => {
            let result: { records: TranscriptRecord[]; offset: number; complete: boolean };
            try {
              result = await target.readNew(afterOffset);
            } catch (error) {
              if (turnPending) {
                turnPending = false;
                record("error");
              }
              throw error;
            }
            if (result.complete && turnPending) {
              turnPending = false;
              record("ok");
            }
            return result;
          };
        case "interrupt":
          return async () => {
            if (turnPending) {
              turnPending = false;
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
