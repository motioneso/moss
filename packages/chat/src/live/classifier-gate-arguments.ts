import type { ClassifierCapability } from "@moss/ai";
import type {
  ClassifierCandidate,
  JsonSchema,
  ModuleAssistantToolManifest
} from "@moss/module-sdk";
import { checkClassifierEligibility } from "@moss/module-sdk";

/**
 * Argument handling for the chat classifier gate: which tools the configured classifier can serve,
 * how each argument is supplied, and the code-side checks on what comes back. The gate never
 * passes the raw message to a tool; every value is picked from a list or extracted against a schema,
 * then checked here.
 */

export type GateToolRisk = ModuleAssistantToolManifest["risk"];

/** One entry on the gate's menu. `moduleId` is the area; `moduleDescription` is its one-line summary. */
export interface GateTool {
  readonly moduleId: string;
  readonly moduleDescription: string;
  readonly name: string;
  readonly risk: GateToolRisk;
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly classifier?: ModuleAssistantToolManifest["classifier"];
}

export type ArgumentKind = "enum" | "candidates" | "extract";

export interface ArgumentPlan {
  readonly name: string;
  readonly kind: ArgumentKind;
  readonly required: boolean;
}

/** Most separate choice questions one tool may need after the tool pick. */
export const MAX_ARGUMENT_QUESTIONS = 2;

/** Sentinel option on every argument question. */
export const ARGUMENT_NONE = "none_of_these";

/** Answers carry no unit; a lead this close to the bar counts as meeting it. */
const SCORE_EPSILON = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredNames(schema: JsonSchema | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
}

function propertyOf(schema: JsonSchema | undefined, name: string): Record<string, unknown> {
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const property = properties[name];
  return isRecord(property) ? property : {};
}

/** Every argument the classifier supplies: all required ones plus any declared optional one. */
export function planArguments(tool: GateTool): ArgumentPlan[] {
  const declared = tool.classifier?.arguments ?? {};
  const required = requiredNames(tool.inputSchema);
  const names = [...new Set([...required, ...Object.keys(declared)])];
  return names.map((name) => ({
    name,
    kind: declared[name]?.kind ?? "enum",
    required: required.includes(name)
  }));
}

/**
 * The classifier's own declaration check plus the limits the gate adds. Returns null when the tool
 * may be offered, otherwise the reason it is not.
 */
export function gateEligibilityProblem(
  tool: GateTool,
  capability: ClassifierCapability | null
): string | null {
  const declaration = checkClassifierEligibility(tool);
  if (!declaration.eligible) return "not_declared";
  const plan = planArguments(tool);
  const extracts = plan.some((arg) => arg.kind === "extract");
  if (extracts && capability === "choice_only") return "needs_typed_extraction";
  if (plan.filter((arg) => arg.kind === "candidates").length > 1) return "too_many_candidate_lists";
  if (!extracts && plan.length > MAX_ARGUMENT_QUESTIONS) return "too_many_arguments";
  for (const arg of plan) {
    if (arg.kind !== "enum") continue;
    const values = propertyOf(tool.inputSchema, arg.name)["enum"];
    if (!Array.isArray(values) || !values.every(isChoiceValue)) return "unsupported_enum";
  }
  return null;
}

type ChoiceValue = string | number | boolean;

function isChoiceValue(value: unknown): value is ChoiceValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** One option the classifier may pick for an argument: the id it names and the value the tool gets. */
export interface ArgumentOption {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
}

/** Options for an enum argument. Null when two values would share one id. */
export function enumOptions(tool: GateTool, name: string): ArgumentOption[] | null {
  const values = propertyOf(tool.inputSchema, name)["enum"];
  if (!Array.isArray(values)) return null;
  const options = values.map((value) => ({
    id: String(value),
    label: String(value),
    value
  }));
  const ids = new Set(options.map((option) => option.id));
  if (ids.size !== options.length || ids.has(ARGUMENT_NONE)) return null;
  return options;
}

/** Options for a candidates argument. Null when a candidate id is the reserved sentinel. */
export function candidateOptions(
  candidates: readonly ClassifierCandidate[]
): ArgumentOption[] | null {
  if (candidates.length === 0 || candidates.some((entry) => entry.id === ARGUMENT_NONE))
    return null;
  return candidates.map((entry) => ({ id: entry.id, label: entry.label, value: entry.id }));
}

/** Schema for one typed extraction covering every argument the classifier supplies. */
export function extractionSchema(
  tool: GateTool,
  plan: readonly ArgumentPlan[],
  options: ReadonlyMap<string, readonly ArgumentOption[]>
): Record<string, unknown> {
  // Argument names may come from a connected server; a null prototype keeps `__proto__` an own key.
  const properties = Object.create(null) as Record<string, unknown>;
  for (const arg of plan) {
    const offered = options.get(arg.name);
    properties[arg.name] = offered
      ? { type: "string", enum: offered.map((option) => option.id) }
      : propertyOf(tool.inputSchema, arg.name);
  }
  return {
    type: "object",
    additionalProperties: false,
    required: plan.filter((arg) => arg.required).map((arg) => arg.name),
    properties
  };
}

export type ExtractedArguments =
  | { readonly ok: true; readonly input: Record<string, unknown> }
  | { readonly ok: false; readonly reason: "invalid_arguments" | "candidate_not_offered" };

/**
 * Checks an extraction against the plan: an object, no field outside the plan, every required field
 * present, and every candidate or enum value one that was actually offered.
 */
export function checkExtractedArguments(
  values: unknown,
  plan: readonly ArgumentPlan[],
  options: ReadonlyMap<string, readonly ArgumentOption[]>
): ExtractedArguments {
  if (!isRecord(values)) return { ok: false, reason: "invalid_arguments" };
  const allowed = new Set(plan.map((arg) => arg.name));
  if (Object.keys(values).some((key) => !allowed.has(key))) {
    return { ok: false, reason: "invalid_arguments" };
  }
  const input = Object.create(null) as Record<string, unknown>;
  for (const arg of plan) {
    const value = values[arg.name];
    if (value === undefined) {
      if (arg.required) return { ok: false, reason: "invalid_arguments" };
      continue;
    }
    const offered = options.get(arg.name);
    if (offered) {
      const match = offered.find((option) => option.id === value);
      if (!match) return { ok: false, reason: "candidate_not_offered" };
      input[arg.name] = match.value;
    } else {
      input[arg.name] = value;
    }
  }
  return { ok: true, input };
}

/** The confidence a pick must reach before the gate acts on a tool of this risk. */
export const RISK_CONFIDENCE_BAR: Readonly<Record<GateToolRisk, number>> = {
  read: 0.9,
  write: 0.95,
  outbound: 0.95,
  destructive: 0.95
};

/** The least lead the top choice must hold over the runner-up. */
export const MIN_LEAD = 0.4;

export const THRESHOLD_VERSION = "v1";

export function meetsConfidenceBar(confidence: number, risk: GateToolRisk): boolean {
  return confidence + SCORE_EPSILON >= RISK_CONFIDENCE_BAR[risk];
}

export function meetsLead(lead: number): boolean {
  return lead + SCORE_EPSILON >= MIN_LEAD;
}

function valueAt(data: unknown, path: string): unknown {
  let node: unknown = data;
  for (const segment of path.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Fills the tool's reply template from its structured result. Returns null when any placeholder is
 * missing or is not a plain string, number or boolean, so a malformed result never reads as success.
 */
export function renderReplyTemplate(template: string, result: unknown): string | null {
  let missing = false;
  const text = template.replace(/\{([^{}]*)\}/g, (_match, path: string) => {
    const value = valueAt(result, path);
    if (typeof value === "string" || typeof value === "boolean") return String(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    missing = true;
    return "";
  });
  return missing ? null : text;
}
