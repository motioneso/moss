/**
 * Classifier opt-in for assistant tools.
 *
 * A tool joins the chat classifier's menu only when it carries a `classifier` declaration. The
 * declaration is data plus one optional read-only candidate hook; templates are strings with
 * `{field}` placeholders, never code. `checkClassifierEligibility` is the single gate: it returns
 * `eligible: false` for an absent declaration and for any incomplete or unbounded one, so a
 * half-written contract is never listed.
 *
 * Node-free, so the barrel stays browser-safe.
 */

import type { JsonSchema, ToolContext } from "./index.js";

/** Size bounds for everything the classifier sees or a hook returns. */
export const CLASSIFIER_LIMITS = {
  descriptionChars: 200,
  templateChars: 200,
  labelChars: 80,
  idChars: 80,
  /** Max enum values in a tool schema and max candidates a hook may return. */
  candidates: 50
} as const;

/**
 * How the classifier supplies one argument.
 * - `enum`: pick one value of the argument's own schema `enum`.
 * - `candidates`: pick one id from the list the tool's `candidates` hook returns.
 * - `extract`: extract a typed value from the message. Only classifiers that can return
 *   extracted fields can serve this; others treat the tool as ineligible.
 */
export type ClassifierArgumentDecl =
  | { readonly kind: "enum" }
  | { readonly kind: "candidates" }
  | { readonly kind: "extract" };

/** One value the classifier may pick. `id` is what the tool receives; `label` is shown to the classifier. */
export interface ClassifierCandidate {
  readonly id: string;
  readonly label: string;
}

/**
 * Read-only, actor-scoped producer of candidate values for a `candidates` argument (for example
 * the names of the user's lights). `scopedDb` is a DataContextDb typed `unknown` for the same
 * reason as ToolExecute. The hook must not write, must honor `signal`, and returns at most
 * `CLASSIFIER_LIMITS.candidates` entries; the host validates the result with
 * `normalizeClassifierCandidates` and declines on any violation.
 */
export type ClassifierCandidateProvider = (
  scopedDb: unknown,
  ctx: ToolContext,
  options: { readonly signal: AbortSignal }
) => Promise<readonly ClassifierCandidate[]>;

export interface ModuleAssistantToolClassifier {
  /** One line the classifier reads when choosing between tools. */
  readonly description: string;
  /**
   * How each argument is supplied. A required argument whose schema is not an `enum` must be
   * declared here. Optional arguments left undeclared are never supplied by the classifier.
   */
  readonly arguments?: Readonly<Record<string, ClassifierArgumentDecl>>;
  /** Required when any argument is `candidates`. */
  readonly candidates?: ClassifierCandidateProvider;
  /**
   * Reply text filled from the tool result, for example "Added {task.title}.". Each placeholder
   * is a dotted path into `outputSchema.properties` ending at a string, number, integer or
   * boolean. The classifier never writes reply text.
   */
  readonly replyTemplate: string;
}

export type ClassifierEligibility =
  | { readonly eligible: true }
  /** `problems` is empty when the tool simply has no declaration. */
  | { readonly eligible: false; readonly problems: readonly string[] };

/** The slice of a tool manifest the check reads. */
export interface ClassifierEligibilityInput {
  readonly name: string;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly classifier?: ModuleAssistantToolClassifier;
}

const PLACEHOLDER = /\{([^{}]*)\}/g;
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAIN_TYPES = new Set(["string", "number", "integer", "boolean"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkOneLine(label: string, value: unknown, max: number, problems: string[]): void {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${label} must be a non-empty string`);
  } else if (/[\r\n]/.test(value)) {
    problems.push(`${label} must be a single line`);
  } else if (value.length > max) {
    problems.push(`${label} must be at most ${max} characters`);
  }
}

function placeholderType(outputSchema: JsonSchema | undefined, path: string): string | undefined {
  let node: unknown = outputSchema;
  for (const segment of path.split(".")) {
    if (!PATH_SEGMENT.test(segment) || !isRecord(node) || !isRecord(node.properties)) {
      return undefined;
    }
    node = node.properties[segment];
  }
  return isRecord(node) && typeof node.type === "string" ? node.type : undefined;
}

function checkTemplate(
  template: unknown,
  outputSchema: JsonSchema | undefined,
  problems: string[]
): void {
  checkOneLine("replyTemplate", template, CLASSIFIER_LIMITS.templateChars, problems);
  if (typeof template !== "string") return;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const path = match[1] ?? "";
    const type = placeholderType(outputSchema, path);
    if (type === undefined) {
      problems.push(`replyTemplate placeholder {${path}} is not a field of the tool result`);
    } else if (!PLAIN_TYPES.has(type)) {
      problems.push(`replyTemplate placeholder {${path}} must be a string, number or boolean`);
    }
  }
  // A brace left over after removing well-formed placeholders is a typo, not literal text.
  if (/[{}]/.test(template.replace(PLACEHOLDER, ""))) {
    problems.push("replyTemplate has an unmatched brace");
  }
}

function enumValues(property: unknown): readonly unknown[] | undefined {
  return isRecord(property) && Array.isArray(property.enum) && property.enum.length > 0
    ? property.enum
    : undefined;
}

function checkArguments(
  tool: ClassifierEligibilityInput,
  decl: ModuleAssistantToolClassifier,
  problems: string[]
): void {
  const schema = tool.inputSchema;
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  const declared = decl.arguments ?? {};

  for (const [name, arg] of Object.entries(declared)) {
    if (!(name in properties)) {
      problems.push(`argument ${name} is not in the input schema`);
      continue;
    }
    if (arg.kind === "enum" && !enumValues(properties[name])) {
      problems.push(`argument ${name} is declared enum but its schema has no enum`);
    }
    if (arg.kind === "candidates" && !decl.candidates) {
      problems.push(`argument ${name} needs a candidates hook`);
    }
    if (arg.kind !== "enum" && arg.kind !== "candidates" && arg.kind !== "extract") {
      problems.push(`argument ${name} has an unknown kind`);
    }
  }

  for (const name of required) {
    const values = enumValues(properties[name]);
    if (values) {
      if (values.length > CLASSIFIER_LIMITS.candidates) {
        problems.push(`argument ${name} has more than ${CLASSIFIER_LIMITS.candidates} enum values`);
      }
    } else if (!(name in declared)) {
      problems.push(`required argument ${name} is not an enum and is not declared`);
    }
  }

  // Enum values the classifier picks from are part of the menu, so they carry the same bound.
  for (const [name, arg] of Object.entries(declared)) {
    const values = enumValues(properties[name]);
    if (arg.kind === "enum" && values && values.length > CLASSIFIER_LIMITS.candidates) {
      problems.push(`argument ${name} has more than ${CLASSIFIER_LIMITS.candidates} enum values`);
    }
  }
}

/**
 * Whether a tool may appear on the classifier menu. Absent declaration is ineligible with no
 * problems; an incomplete one is ineligible with the reasons.
 */
export function checkClassifierEligibility(
  tool: ClassifierEligibilityInput
): ClassifierEligibility {
  const decl = tool.classifier;
  if (decl === undefined) return { eligible: false, problems: [] };

  const problems: string[] = [];
  checkOneLine("description", decl.description, CLASSIFIER_LIMITS.descriptionChars, problems);
  checkTemplate(decl.replyTemplate, tool.outputSchema, problems);
  checkArguments(tool, decl, problems);

  const unique = [...new Set(problems)];
  return unique.length === 0 ? { eligible: true } : { eligible: false, problems: unique };
}

export type NormalizedCandidates =
  | { readonly ok: true; readonly candidates: readonly ClassifierCandidate[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates a candidate hook's output. Oversize or malformed output is rejected whole, never
 * truncated, because a silently shortened list would hide choices from the menu.
 */
export function normalizeClassifierCandidates(raw: unknown): NormalizedCandidates {
  if (!Array.isArray(raw)) return { ok: false, reason: "candidates must be an array" };
  if (raw.length > CLASSIFIER_LIMITS.candidates) {
    return { ok: false, reason: `more than ${CLASSIFIER_LIMITS.candidates} candidates` };
  }
  const seen = new Set<string>();
  const candidates: ClassifierCandidate[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.label !== "string") {
      return { ok: false, reason: "each candidate needs a string id and label" };
    }
    if (entry.id === "" || entry.id.length > CLASSIFIER_LIMITS.idChars) {
      return { ok: false, reason: "candidate id is empty or too long" };
    }
    if (entry.label.trim() === "" || entry.label.length > CLASSIFIER_LIMITS.labelChars) {
      return { ok: false, reason: "candidate label is empty or too long" };
    }
    if (seen.has(entry.id)) return { ok: false, reason: "duplicate candidate id" };
    seen.add(entry.id);
    candidates.push({ id: entry.id, label: entry.label });
  }
  return { ok: true, candidates };
}
