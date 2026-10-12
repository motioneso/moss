import { recognizeRelativeReminder } from "../reminders/recognizer.js";
import type { StructuredFailureReason } from "@moss/ai";

export type ScheduledReadFailureStage =
  | "active_modules"
  | "candidates"
  | "model_route"
  | "prepare"
  | "generate"
  | "request"
  | "output_shape"
  | "item_selection"
  | "timing"
  | StructuredFailureReason;

export function recordScheduledReadFailure(
  stage: ScheduledReadFailureStage,
  errorClass:
    | "ValidationError"
    | "Error"
    | "TypeError"
    | "SyntaxError"
    | "RangeError"
    | "needs_config"
    | "validation_failed"
    | "provider_error"
    | "aborted"
) {
  console.warn(JSON.stringify({ event: "chat.scheduled_read_refused", stage, errorClass }));
}

export interface ScheduledReadCandidate {
  readonly id: string;
  readonly title: string;
}
export interface ScheduledReadPlan {
  readonly kind: "scheduled_read";
  readonly taskId: string | null;
  readonly title: string;
  readonly when: Extract<
    ReturnType<typeof recognizeRelativeReminder>,
    { kind: "request" | "clock_request" }
  > | null;
}

export function namesScheduledRead(request: string): boolean {
  return (
    request.length <= 700 &&
    /\b(?:check|status)\b/i.test(request) &&
    /\btask\b/i.test(request) &&
    /\b(?:(?:in|after)\s+(?:\d+|an?|one|two|three|five|ten|half)\b|at\s+\d|tomorrow|tonight|every|daily|weekly)\b/i.test(
      request
    )
  );
}

export const SCHEDULED_READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    taskId: {
      type: "string",
      maxLength: 36,
      description: "Exactly one listed item UUID, or empty if ambiguous or unsupported."
    },
    timingRequest: {
      type: "string",
      maxLength: 500,
      description:
        "The requested timing as a reminder, such as remind me in 30 seconds to check task. Preserve time and deadline."
    }
  },
  required: ["taskId", "timingRequest"]
};

export async function resolveScheduledReadRequest(
  request: string,
  candidates: readonly ScheduledReadCandidate[],
  interpret: () => Promise<unknown>,
  signal?: AbortSignal
): Promise<ScheduledReadPlan | undefined> {
  if (!namesScheduledRead(request)) return undefined;
  const refused: ScheduledReadPlan = {
    kind: "scheduled_read",
    taskId: null,
    title: "",
    when: null
  };
  const refuse = (stage: ScheduledReadFailureStage) => {
    recordScheduledReadFailure(stage, signal?.aborted ? "aborted" : "ValidationError");
    return refused;
  };
  if (
    signal?.aborted ||
    /\b(?:delete|remove|update|change|complete|mark|every|daily|weekly|monthly|hourly)\b/i.test(
      request
    )
  )
    return refuse("request");
  const output = await interpret();
  if (signal?.aborted || !output || typeof output !== "object" || Array.isArray(output))
    return refuse("output_shape");
  const fields = Object.entries(output);
  if (fields.length !== 2 || fields.some(([key]) => key !== "taskId" && key !== "timingRequest"))
    return refuse("output_shape");
  const taskId = fields.find(([key]) => key === "taskId")?.[1];
  const timing = fields.find(([key]) => key === "timingRequest")?.[1];
  const task = candidates.find((item) => item.id === taskId);
  if (!task || typeof timing !== "string") return refuse("item_selection");
  const when = recognizeRelativeReminder(timing);
  if (when.kind !== "request" && when.kind !== "clock_request") return refuse("timing");
  return { kind: "scheduled_read", taskId: task.id, title: task.title, when };
}
