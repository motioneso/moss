// packages/module-registry/src/external/validate-classifier.ts
//
// Positive validation of an installable module's classifier opt-in (plan 2.2, #2882). Node-free:
// this module is reachable from @moss/module-registry's browser entry.
//
// The external-only structure is checked here — unknown keys, the handler-name shape, and the
// candidates/handler symmetry the JSON form needs. The description, template and argument rules
// come from the SDK's checkClassifierEligibility, called with a stub in place of the handler
// function, so the manifest validator and the tool-manifest eligibility check cannot drift.
import {
  checkClassifierEligibility,
  type ClassifierArgumentDecl,
  type ClassifierCandidate,
  type JsonSchema
} from "@moss/module-sdk";

const CLASSIFIER_KEYS = new Set(["description", "arguments", "candidatesHandler", "replyTemplate"]);
// Same dotted handler shape and cap as briefing.handler in validate.ts.
const HANDLER_RE = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/;
const HANDLER_MAX = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates `tool.classifier` in place, appending human-readable problems to `errors`. Absent is
 * valid (ineligible tool). Callers must not re-emit the classifier separately: `validate.ts`
 * copies `assistantTools` wholesale, so a validated declaration rides through untouched.
 */
export function validateClassifierDeclaration(
  tool: Record<string, unknown>,
  errors: string[]
): void {
  const raw = tool.classifier;
  if (raw === undefined) return;
  if (!isRecord(raw)) {
    errors.push("classifier must be an object");
    return;
  }

  const unknown = Object.keys(raw).filter((key) => !CLASSIFIER_KEYS.has(key));
  if (unknown.length > 0) {
    errors.push(`classifier contains unknown fields: ${unknown.join(", ")}`);
  }

  const args = raw.arguments;
  if (args !== undefined && !isRecord(args)) {
    errors.push("classifier.arguments must be an object");
  }
  const declaredCandidatesArgs = isRecord(args)
    ? Object.entries(args)
        .filter(([, arg]) => isRecord(arg) && arg.kind === "candidates")
        .map(([name]) => name)
    : [];

  const candidatesHandler = raw.candidatesHandler;
  if (candidatesHandler !== undefined) {
    if (
      typeof candidatesHandler !== "string" ||
      candidatesHandler.length > HANDLER_MAX ||
      !HANDLER_RE.test(candidatesHandler)
    ) {
      errors.push("classifier.candidatesHandler must be a dotted handler name (max 64 chars)");
    }
    if (declaredCandidatesArgs.length === 0) {
      errors.push("classifier.candidatesHandler is declared but no argument uses candidates");
    }
  } else if (declaredCandidatesArgs.length > 0) {
    errors.push(
      `classifier argument ${declaredCandidatesArgs[0]} uses candidates but no candidatesHandler is declared`
    );
  }

  // The stub is never called here; it exists only to satisfy the SDK's "a candidates argument
  // needs a candidates hook" rule so the rest of the declaration is checked by the real gate.
  const eligibility = checkClassifierEligibility({
    name: typeof tool.name === "string" ? tool.name : "",
    ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema as JsonSchema } : {}),
    ...(isRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema as JsonSchema } : {}),
    classifier: {
      description: raw.description as string,
      ...(isRecord(args)
        ? { arguments: args as Readonly<Record<string, ClassifierArgumentDecl>> }
        : {}),
      ...(candidatesHandler !== undefined
        ? { candidates: async () => [] as readonly ClassifierCandidate[] }
        : {}),
      replyTemplate: raw.replyTemplate as string
    }
  });
  for (const problem of eligibility.eligible ? [] : eligibility.problems) {
    errors.push(`classifier ${problem}`);
  }
}
