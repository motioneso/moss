import type { ActivityDetailStep } from "@moss/db";

import type { TranscriptRecord } from "./types.js";

/** #2956: detail steps are bounded in count; every step is fixed template words. */
const ANSWER_DETAIL_STEP_CAP = 20;

function answerStepTitle(record: TranscriptRecord): string {
  if (record.toolName) return record.toolName;
  switch (record.kind) {
    case "result":
      return "Result";
    default:
      return record.kind;
  }
}

function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 100) / 10}s`;
}

/** Fixed words for a tool step outcome; failed steps add the spec 5.4 sentence. */
function toolStepResult(record: TranscriptRecord): string {
  if (record.rejected) return "Did not finish.";
  switch (record.outcome) {
    case "executed":
    case "allowed":
      return "Finished.";
    case "denied":
      return "Did not finish. You declined this action.";
    case "error":
      return "Did not finish. Something went wrong that Moss could not name.";
    default:
      return "Called.";
  }
}

function approvalStepResult(record: TranscriptRecord): string {
  switch (record.decidedBy) {
    case "person":
      return "Approved by you.";
    case "policy":
      return "Approved by policy.";
    case "timeout":
      return "Approval timed out.";
    case "cancelled":
      return "Approval cancelled.";
    default:
      return "Needed approval.";
  }
}

/** Meta the record itself declares: the turn model, approval mode, elapsed time. */
function stepMeta(record: TranscriptRecord, modelName: string): readonly string[] {
  const meta = [modelName];
  if (record.decidedBy === "person") meta.push("decided by you");
  else if (record.decidedBy === "policy") meta.push("decided by policy");
  if (record.elapsedMs !== undefined) meta.push(`took ${formatStepDuration(record.elapsedMs)}`);
  return meta;
}

function withStepMeta(result: string, meta: readonly string[]): string {
  return meta.length === 0 ? result : `${result} · ${meta.join(" · ")}`;
}

function templatedActivityStep(
  record: TranscriptRecord,
  modelName: string
): ActivityDetailStep | undefined {
  switch (record.kind) {
    case "thought":
    case "thinking":
    case "user":
    case "status":
    case "reply":
      return undefined;
    case "action_request":
      return {
        title: record.toolName ?? "Approval",
        result: withStepMeta(approvalStepResult(record), stepMeta(record, modelName))
      };
    case "approved":
      return {
        title: record.toolName ?? "Approval",
        result: withStepMeta("Approved.", stepMeta(record, modelName))
      };
    case "refusal":
    case "refused":
      return {
        title: answerStepTitle(record),
        result: withStepMeta("Did not finish.", stepMeta(record, modelName))
      };
    case "error":
      return {
        title: "Error",
        result: withStepMeta(
          "Did not finish. Something went wrong that Moss could not name.",
          stepMeta(record, modelName)
        )
      };
    case "tool":
    case "action_result":
      return {
        title: record.toolName ?? "Tool",
        result: withStepMeta(toolStepResult(record), stepMeta(record, modelName))
      };
    default:
      return {
        title: answerStepTitle(record),
        result: withStepMeta("Finished.", stepMeta(record, modelName))
      };
  }
}

/**
 * #2956: the turn's records as detail steps, ending with the answer step. No
 * step carries transcript text: thinking stays private, tool text and the reply
 * never reach the row. Each step keeps its title (the tool name or the kind
 * label) plus a templated result built from the outcome and the record's own
 * meta. Asked-for and returned stay unset until a tool declares display fields
 * (#2987). Long turns keep their first steps; the tail is the answer.
 */
export function answerDetailSteps(
  records: readonly TranscriptRecord[],
  reply: string,
  meta: { readonly modelName: string; readonly durationMs?: number }
): ActivityDetailStep[] {
  const steps: ActivityDetailStep[] = [];
  for (const record of records) {
    if (steps.length >= ANSWER_DETAIL_STEP_CAP - 1) break;
    const step = templatedActivityStep(record, meta.modelName);
    if (step) steps.push(step);
  }
  if (reply) {
    const answerMeta =
      meta.durationMs === undefined
        ? [meta.modelName]
        : [meta.modelName, `took ${formatStepDuration(meta.durationMs)}`];
    steps.push({ title: "Answer", result: withStepMeta("Answered.", answerMeta) });
  }
  return steps;
}
