import { types } from "node:util";
import { safePostgresErrorFields } from "@moss/db";

const reported = new Set<string>();
const MAX_REPORTED_ACTIONS = 1_000;

function safeErrorClass(error: unknown): string {
  if (!types.isNativeError(error)) return "Unknown";
  const prototype: unknown = Object.getPrototypeOf(error);
  if (prototype === TypeError.prototype) return "TypeError";
  if (prototype === RangeError.prototype) return "RangeError";
  if (prototype === SyntaxError.prototype) return "SyntaxError";
  if (prototype === ReferenceError.prototype) return "ReferenceError";
  if (prototype === URIError.prototype) return "URIError";
  if (prototype === EvalError.prototype) return "EvalError";
  if (prototype === AggregateError.prototype) return "AggregateError";
  return "Error";
}

/** Shared bounded dedupe for the same record crossing retries and delivery layers. */
export function reportActionRecordFailure(actionRequestId: string, error?: unknown): void {
  if (reported.has(actionRequestId)) return;
  if (reported.size >= MAX_REPORTED_ACTIONS) reported.delete(reported.values().next().value!);
  reported.add(actionRequestId);
  // Fixed classes and a validated SQLSTATE only; never names, messages, causes or content.
  console.warn("action_record_delivery_failed", {
    actionRequestId,
    ...(safePostgresErrorFields(error) ?? { errorClass: safeErrorClass(error) })
  });
}
