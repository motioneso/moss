import { normalizeReminderRequest, recognizeRelativeReminder } from "../reminders/recognizer.js";
import { recognizeRepeatingReminder, type RepeatRequest } from "../reminders/repeat-recognizer.js";
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
    | "aborted",
  validation?: { readonly keyword: string; readonly schemaPath: string }
) {
  console.warn(
    JSON.stringify({
      event: "chat.scheduled_read_refused",
      stage,
      errorClass,
      ...(validation
        ? { validation: { keyword: validation.keyword, schemaPath: validation.schemaPath } }
        : {})
    })
  );
}

export interface ScheduledReadCandidate {
  readonly id: string;
  readonly title: string;
}
export interface ScheduledReadPlan {
  readonly kind: "scheduled_read";
  readonly failure?: "unavailable";
  readonly taskId: string | null;
  readonly title: string;
  readonly when:
    | Extract<ReturnType<typeof recognizeRelativeReminder>, { kind: "request" | "clock_request" }>
    | RepeatRequest
    | null;
}

export function namesScheduledRead(request: string): boolean {
  const normalized = normalizeReminderRequest(request);
  return (
    request.length <= 700 &&
    /^check\b/.test(normalized) &&
    !/^check\s+(?:which|what|how|why|where|when)\b/.test(normalized) &&
    /\b(?:check|status)\b/i.test(request) &&
    /\btask\b/i.test(request) &&
    /\b(?:(?:in|after)\s+(?:\d+|an?|one|two|three|five|ten|half)\b|at\s+\d|tomorrow|tonight|every|each|daily|weekly|hourly|monthly)\b/i.test(
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
  const requestedRepeat = recognizeRepeatingReminder(`remind me to ${request}`);
  if (
    signal?.aborted ||
    requestedRepeat?.kind === "unsupported" ||
    (/\b(?:every|each|daily|weekly|monthly|hourly)\b/i.test(request) &&
      requestedRepeat?.kind !== "repeat_request") ||
    /\b(?:delete|remove|update|change|complete|mark|monthly)\b/i.test(request)
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
  const matches = candidates.filter((item) => item.id === taskId);
  if (matches.length !== 1) {
    recordScheduledReadFailure("item_selection", "ValidationError");
    return undefined;
  }
  const task = matches[0]!;
  const titleAt = task.title ? request.toLowerCase().indexOf(task.title.toLowerCase()) : -1;
  const ownerTiming =
    titleAt < 0
      ? request
      : request.slice(0, titleAt) + "selected task" + request.slice(titleAt + task.title.length);
  const confirmedRepeat = recognizeRepeatingReminder(`remind me to ${ownerTiming}`);
  if (
    requestedRepeat?.kind === "repeat_request" &&
    (confirmedRepeat?.kind !== "repeat_request" ||
      JSON.stringify(confirmedRepeat.repeat) !== JSON.stringify(requestedRepeat.repeat) ||
      confirmedRepeat.clock !== requestedRepeat.clock ||
      confirmedRepeat.weekday !== requestedRepeat.weekday ||
      /\b(?:(?:in|after|at)\s+(?:\d+|an?|one|two|three|five|ten|half)|tomorrow|tonight|until|starting|start at|not after)\b/i.test(
        confirmedRepeat.text
      ))
  )
    return refuse("timing");

  if (typeof timing !== "string") return refuse("output_shape");
  const repeat = recognizeRepeatingReminder(timing);
  if (requestedRepeat?.kind === "repeat_request") {
    if (
      repeat?.kind !== "repeat_request" ||
      JSON.stringify(repeat.repeat) !== JSON.stringify(requestedRepeat.repeat) ||
      repeat.clock !== requestedRepeat.clock ||
      repeat.weekday !== requestedRepeat.weekday
    )
      return refuse("timing");
    return { kind: "scheduled_read", taskId: task.id, title: task.title, when: repeat };
  }
  if (repeat) return refuse("timing");
  const when = recognizeRelativeReminder(timing);
  if (when.kind !== "request" && when.kind !== "clock_request") return refuse("timing");
  return { kind: "scheduled_read", taskId: task.id, title: task.title, when };
}
