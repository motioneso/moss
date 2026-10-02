/**
 * Model activity log (plan 3.6a, #2889): the seam every provider adapter records through.
 *
 * Recording is deliberately fire-and-forget. A call settles first, then a short entry is handed to
 * the installed recorder; the recorder is never awaited and never allowed to throw into the model
 * path. A failed write is logged and dropped.
 *
 * An entry is a projection of transport facts only — the call kind, an action label, the outcome,
 * the actual model name and a fixed result line. It can never carry a message, prompt, tool
 * argument or secret: there is no field for one, and none is passed here.
 */

import type { FastifyBaseLogger } from "fastify";

export type ModelActivityOutcome = "ok" | "error" | "aborted";

export type ModelActivityEntry = {
  readonly kind: string;
  readonly action: string;
  readonly outcome: ModelActivityOutcome;
  readonly modelName: string;
  readonly result: string;
  readonly occurredAt?: Date;
};

export type ModelActivityRecorder = (entry: ModelActivityEntry) => void;

/** The database-backed half, awaited by the installed recorder and never by a caller. */
export type ModelActivityWriter = (entry: ModelActivityEntry) => Promise<void>;

/** Short, allow-listed result lines. Never an error message — those can carry response bodies. */
const RESULT_OK = "completed";
const RESULT_ERROR = "failed";
const RESULT_ABORTED = "stopped";

let installedRecorder: ModelActivityRecorder | null = null;

/** Install (or clear) the process-wide recorder. Called once at each composition root. */
export function installModelActivityRecorder(recorder: ModelActivityRecorder | null): void {
  installedRecorder = recorder;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function invokeSafely(
  recorder: ModelActivityRecorder,
  entry: ModelActivityEntry,
  onError?: (error: unknown) => void
): void {
  try {
    const maybe = recorder(entry) as unknown;
    if (isThenable(maybe)) {
      void Promise.resolve(maybe).catch((error: unknown) => onError?.(error));
    }
  } catch (error) {
    onError?.(error);
  }
}

/** Record one entry on the installed recorder. No-op when none is installed; never throws. */
export function recordModelActivity(entry: ModelActivityEntry): void {
  const recorder = installedRecorder;
  if (!recorder) return;
  invokeSafely(recorder, entry);
}

/**
 * A short action label for a structured call: the calling service without its `module.` namespace,
 * or `structured` when the caller did not name one. Never message content.
 */
export function modelActivityAction(service: string | undefined): string {
  if (!service) return "structured";
  const label = service.startsWith("module.") ? service.slice("module.".length) : service;
  return label.length > 0 ? label : "structured";
}

/** DB CHECK limits for the short fields; a value over the limit is truncated, never dropped. */
const KIND_LIMIT = 64;
const ACTION_LIMIT = 200;
const RESULT_LIMIT = 500;

function truncate(value: string, max: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= max ? value : codePoints.slice(0, max).join("");
}

/** Clamp every field to the column CHECK limits so an over-long value can never drop its row. */
export function boundModelActivityEntry(entry: ModelActivityEntry): ModelActivityEntry {
  return {
    ...entry,
    kind: truncate(entry.kind, KIND_LIMIT),
    action: truncate(entry.action, ACTION_LIMIT),
    modelName: truncate(entry.modelName, ACTION_LIMIT),
    result: truncate(entry.result, RESULT_LIMIT)
  };
}

/**
 * Build the database-backed recorder. A failed insert is swallowed to the logger, never surfaced to
 * the model call.
 */
export function createDbModelActivityRecorder(
  write: ModelActivityWriter,
  logger?: Pick<FastifyBaseLogger, "warn">
): ModelActivityRecorder {
  return (entry) => {
    void write(boundModelActivityEntry(entry)).catch((error: unknown) => {
      logger?.warn(
        {
          event: "model_activity_write_failed",
          name: error instanceof Error ? error.name : "UnknownError"
        },
        "model activity write failed"
      );
    });
  };
}

/**
 * Run one provider call and record its result after it settles. The record happens outside the
 * awaited work, so it can neither slow the call nor fail it.
 */
export async function withModelActivityRecording<T>(
  recorder: ModelActivityRecorder | undefined,
  context: { readonly kind: string; readonly action: string; readonly modelName: string },
  run: () => Promise<T>
): Promise<T> {
  try {
    const value = await run();
    if (recorder) {
      invokeSafely(recorder, { ...context, outcome: "ok", result: RESULT_OK });
    }
    return value;
  } catch (error) {
    if (recorder) {
      const aborted = error instanceof Error && error.name === "AbortError";
      invokeSafely(recorder, {
        ...context,
        outcome: aborted ? "aborted" : "error",
        result: aborted ? RESULT_ABORTED : RESULT_ERROR
      });
    }
    throw error;
  }
}
