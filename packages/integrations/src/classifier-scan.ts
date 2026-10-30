import type { IntegrationClassifierArgument, IntegrationToolDescriptor } from "@moss/shared";

import { toolDefinitionFingerprint } from "./classifier-fingerprint.js";
import {
  INTEGRATION_CLASSIFIER_MAX_ARGUMENTS,
  INTEGRATION_CLASSIFIER_MAX_ARGUMENT_VALUES,
  INTEGRATION_CLASSIFIER_MAX_DESCRIPTION_CHARS,
  INTEGRATION_CLASSIFIER_MAX_ENTRY_JSON_CHARS,
  INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS,
  INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES,
  INTEGRATION_CLASSIFIER_MAX_TEMPLATE_CHARS,
  isReadableName,
  preparationEntry,
  toolSortState,
  type ClassifierPreparationMap,
  type ClassifierSortMap
} from "./classifier-settings.js";

/**
 * Scan storage for one connection (#3844 slice 1).
 *
 * The scan map is a versioned JSON map on the owner-only connection row. It holds the actions
 * the scan found, keyed by tool name then action key, and the target lists, keyed by listing
 * source. This module is pure. It validates untrusted input, reads the stored map defensively,
 * and converts the old sort, send and preparation maps into the new shape. It never calls a
 * model, never writes, and nothing reads it to decide asking yet. Persistence lives in
 * repository.ts, and the scan itself lands in a later slice. The map holds no credential, no
 * connection address and no raw listing reply.
 */

export const INTEGRATION_CLASSIFIER_SCAN_VERSION = 1 as const;

/** The single action key a converted tool gets. Real action splitting lands with the scan. */
export const CLASSIFIER_SCAN_TOOL_ACTION_KEY = "tool";

/**
 * What one action does, which sets whether Moss asks. The first four words are today's sorted
 * risks, so a converted sort keeps its word. `guarded` and `unknown` are new.
 */
export type ClassifierActionKind =
  | "read"
  | "write"
  | "guarded"
  | "outbound"
  | "destructive"
  | "unknown";

const ACTION_KINDS: readonly ClassifierActionKind[] = [
  "read",
  "write",
  "guarded",
  "outbound",
  "destructive",
  "unknown"
];

/** The owner's mark on one action. No mark means the default for the action's kind. */
export type ClassifierActionMark = "ask_first" | "run_without_asking";

const ACTION_MARKS: readonly ClassifierActionMark[] = ["ask_first", "run_without_asking"];

export interface ClassifierScanActionMark {
  readonly choice: ClassifierActionMark;
  /** The action's definition fingerprint when the mark was set. A change makes it not match. */
  readonly fingerprint: string;
}

export interface ClassifierScanAction {
  readonly key: string;
  readonly kind: ClassifierActionKind;
  readonly readableName: string;
  readonly description: string;
  readonly replyTemplate: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  /** The deciding argument values that pick this action out of its tool. Empty for one action. */
  readonly decidingValues: Readonly<Record<string, string>>;
  /** The definition fingerprint of the tool this action was made against. */
  readonly definitionFingerprint: string;
  readonly scannedAt: string;
  readonly mark: ClassifierScanActionMark | null;
}

export interface ClassifierScanTargetEntry {
  readonly id: string;
  readonly label: string;
}

export interface ClassifierScanTargetList {
  /** The listing tool this list was read through. */
  readonly sourceTool: string;
  readonly definitionFingerprint: string;
  readonly readAt: string;
  readonly entries: readonly ClassifierScanTargetEntry[];
}

export interface ClassifierScanMap {
  readonly version: typeof INTEGRATION_CLASSIFIER_SCAN_VERSION;
  readonly actions: Readonly<Record<string, Readonly<Record<string, ClassifierScanAction>>>>;
  readonly targets: Readonly<Record<string, ClassifierScanTargetList>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS
  );
}

function isOneLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value) && value.length <= max
  );
}

/**
 * Tool names are attacker-influenced, so every record here has a null prototype. A tool
 * literally named `toString`, `constructor` or `__proto__` stays an own key.
 */
function record<T>(source?: Readonly<Record<string, T>>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (source) for (const key of Object.keys(source)) out[key] = source[key]!;
  return out;
}

export function emptyScanMap(): ClassifierScanMap {
  return { version: INTEGRATION_CLASSIFIER_SCAN_VERSION, actions: record(), targets: record() };
}

/** The stored action for a tool and action key, only when both are own keys. */
export function scanAction(
  map: ClassifierScanMap,
  toolName: string,
  actionKey: string
): ClassifierScanAction | undefined {
  if (!Object.prototype.hasOwnProperty.call(map.actions, toolName)) return undefined;
  const actions = map.actions[toolName]!;
  return Object.prototype.hasOwnProperty.call(actions, actionKey) ? actions[actionKey] : undefined;
}

/** The stored target list for a listing source, only when it is an own key. */
export function scanTargetList(
  map: ClassifierScanMap,
  source: string
): ClassifierScanTargetList | undefined {
  return Object.prototype.hasOwnProperty.call(map.targets, source)
    ? map.targets[source]
    : undefined;
}

/** Whether the action still carries a live mark. A changed action's mark stops matching. */
export function scanActionMarkIsCurrent(action: ClassifierScanAction): boolean {
  return action.mark !== null && action.mark.fingerprint === action.definitionFingerprint;
}

const ARGUMENT_KINDS = ["enum", "candidates", "extract"] as const;
const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseArgument(raw: unknown): IntegrationClassifierArgument | null {
  if (!isRecord(raw)) return null;
  if (!(ARGUMENT_KINDS as readonly unknown[]).includes(raw.kind)) return null;
  const kind = raw.kind as IntegrationClassifierArgument["kind"];
  if (kind === "enum") {
    if (!Array.isArray(raw.values) || raw.values.length === 0) return null;
    if (raw.values.length > INTEGRATION_CLASSIFIER_MAX_ARGUMENT_VALUES) return null;
    if (raw.candidateSource !== undefined) return null;
    const values: string[] = [];
    for (const value of raw.values) {
      if (!isOneLine(value, INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS)) return null;
      values.push(value);
    }
    return { kind, values };
  }
  if (kind === "candidates") {
    if (!isIdentifier(raw.candidateSource) || raw.values !== undefined) return null;
    return { kind, candidateSource: raw.candidateSource };
  }
  if (raw.values !== undefined || raw.candidateSource !== undefined) return null;
  return { kind };
}

function parseArguments(raw: unknown): Record<string, IntegrationClassifierArgument> | null {
  if (!isRecord(raw)) return null;
  const names = Object.keys(raw);
  if (names.length > INTEGRATION_CLASSIFIER_MAX_ARGUMENTS) return null;
  const out = Object.create(null) as Record<string, IntegrationClassifierArgument>;
  for (const name of names) {
    if (!ARGUMENT_NAME.test(name) || name.length > INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS) {
      return null;
    }
    const parsed = parseArgument(raw[name]);
    if (!parsed) return null;
    out[name] = parsed;
  }
  return out;
}

function parseMark(raw: unknown): ClassifierScanActionMark | null | undefined {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const choice = ACTION_MARKS.find((candidate) => candidate === raw.choice);
  if (!choice || !isIdentifier(raw.fingerprint)) return undefined;
  return { choice, fingerprint: raw.fingerprint };
}

function parseStringRecord(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(raw)) {
    if (!isIdentifier(name) || !isOneLine(value, INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS)) {
      return null;
    }
    out[name] = value;
  }
  return out;
}

/** Read one stored action. Any field that breaks the shape drops the action. */
function parseScanAction(raw: unknown): ClassifierScanAction | null {
  if (!isRecord(raw)) return null;
  if (!isIdentifier(raw.key)) return null;
  const kind = ACTION_KINDS.find((candidate) => candidate === raw.kind);
  if (!kind) return null;
  if (!isReadableName(raw.readableName)) return null;
  if (!isOneLine(raw.description, INTEGRATION_CLASSIFIER_MAX_DESCRIPTION_CHARS)) return null;
  if (!isOneLine(raw.replyTemplate, INTEGRATION_CLASSIFIER_MAX_TEMPLATE_CHARS)) return null;
  const args = parseArguments(raw.arguments);
  if (!args) return null;
  const decidingValues = parseStringRecord(raw.decidingValues);
  if (!decidingValues) return null;
  if (!isIdentifier(raw.definitionFingerprint) || !isIdentifier(raw.scannedAt)) return null;
  const mark = parseMark(raw.mark);
  if (mark === undefined) return null;
  return {
    key: raw.key,
    kind,
    readableName: raw.readableName,
    description: raw.description,
    replyTemplate: raw.replyTemplate,
    arguments: args,
    decidingValues,
    definitionFingerprint: raw.definitionFingerprint,
    scannedAt: raw.scannedAt,
    mark
  };
}

function parseTargetList(raw: unknown): ClassifierScanTargetList | null {
  if (!isRecord(raw)) return null;
  if (!isIdentifier(raw.sourceTool)) return null;
  if (!isIdentifier(raw.definitionFingerprint) || !isIdentifier(raw.readAt)) return null;
  if (
    !Array.isArray(raw.entries) ||
    raw.entries.length > INTEGRATION_CLASSIFIER_MAX_ARGUMENT_VALUES
  ) {
    return null;
  }
  const entries: ClassifierScanTargetEntry[] = [];
  for (const entry of raw.entries) {
    if (!isRecord(entry)) return null;
    if (!isIdentifier(entry.id)) return null;
    if (!isOneLine(entry.label, INTEGRATION_CLASSIFIER_MAX_DESCRIPTION_CHARS)) return null;
    entries.push({ id: entry.id, label: entry.label });
  }
  return {
    sourceTool: raw.sourceTool,
    definitionFingerprint: raw.definitionFingerprint,
    readAt: raw.readAt,
    entries
  };
}

/**
 * Read the stored jsonb map. A map that is not the expected shape reads as empty, and a
 * malformed action or target list is dropped. Failing closed keeps a damaged column from
 * silently becoming eligibility in a later slice.
 */
export function parseScanMap(raw: unknown): ClassifierScanMap {
  if (!isRecord(raw)) return emptyScanMap();
  if (raw.version !== INTEGRATION_CLASSIFIER_SCAN_VERSION) return emptyScanMap();
  if (!isRecord(raw.actions) || !isRecord(raw.targets)) return emptyScanMap();
  const actions = record<Readonly<Record<string, ClassifierScanAction>>>();
  for (const [toolName, value] of Object.entries(raw.actions)) {
    if (!isIdentifier(toolName) || !isRecord(value)) continue;
    const toolActions = record<ClassifierScanAction>();
    for (const [actionKey, actionRaw] of Object.entries(value)) {
      const parsed = parseScanAction(actionRaw);
      if (parsed && parsed.key === actionKey) toolActions[actionKey] = parsed;
    }
    if (Object.keys(toolActions).length > 0) actions[toolName] = toolActions;
  }
  const targets = record<ClassifierScanTargetList>();
  for (const [source, value] of Object.entries(raw.targets)) {
    if (!isIdentifier(source)) continue;
    const parsed = parseTargetList(value);
    if (parsed) targets[source] = parsed;
  }
  return { version: INTEGRATION_CLASSIFIER_SCAN_VERSION, actions, targets };
}

/**
 * Store one action. An action that breaks the stored shape, or a new tool past the bound,
 * leaves the map unchanged. The whole action is refused, never cut down to fit.
 */
export function withScanAction(
  map: ClassifierScanMap,
  toolName: string,
  action: ClassifierScanAction
): ClassifierScanMap {
  if (!isIdentifier(toolName)) return map;
  const parsed = parseScanAction(action);
  if (!parsed) return map;
  if (JSON.stringify(parsed).length > INTEGRATION_CLASSIFIER_MAX_ENTRY_JSON_CHARS) return map;
  const existing = Object.prototype.hasOwnProperty.call(map.actions, toolName)
    ? map.actions[toolName]!
    : undefined;
  if (!existing && Object.keys(map.actions).length >= INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES) {
    return map;
  }
  const toolActions = record(existing);
  toolActions[parsed.key] = parsed;
  const actions = record(map.actions);
  actions[toolName] = toolActions;
  return { ...map, actions };
}

/** Store one target list. A list that breaks the stored shape leaves the map unchanged. */
export function withScanTargetList(
  map: ClassifierScanMap,
  source: string,
  list: ClassifierScanTargetList
): ClassifierScanMap {
  if (!isIdentifier(source)) return map;
  const parsed = parseTargetList(list);
  if (!parsed) return map;
  if (!Object.prototype.hasOwnProperty.call(map.targets, source)) {
    if (Object.keys(map.targets).length >= INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES) return map;
  }
  const targets = record(map.targets);
  targets[source] = parsed;
  return { ...map, targets };
}

/**
 * Whether the tool has a deciding argument. A top-level property whose schema carries a
 * non-empty fixed choice list can pick out more than one action, so the tool waits for a real
 * scan instead of gaining a single converted action.
 */
function hasDecidingArgument(tool: IntegrationToolDescriptor): boolean {
  if (!isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties)) return false;
  return Object.values(tool.inputSchema.properties).some(
    (property) => isRecord(property) && Array.isArray(property.enum) && property.enum.length > 0
  );
}

/**
 * Convert the old sort, send and preparation maps into a scan map (spec 5.1, #3844).
 *
 * A tool converts only when its sort is current, its preparation matches its current
 * definition, and it has no deciding argument. Its single action takes the sort's raised risk
 * as its kind, the preparation's text and arguments, and a Run without asking mark only when
 * the send choice counted on a Sends something out sort. Anything else converts to nothing,
 * so the tool keeps asking exactly as it does today. Nothing here changes asking. Later
 * slices replace converted actions with scanned ones.
 */
export function scanMapFromLegacy(
  sort: ClassifierSortMap,
  preparation: ClassifierPreparationMap,
  tools: readonly IntegrationToolDescriptor[]
): ClassifierScanMap {
  let map = emptyScanMap();
  for (const tool of tools) {
    if (hasDecidingArgument(tool)) continue;
    const state = toolSortState(sort, tool);
    if (state.status !== "current") continue;
    const prepared = preparationEntry(preparation, tool.name);
    if (!prepared) continue;
    if (prepared.definitionFingerprint !== toolDefinitionFingerprint(tool)) continue;
    const kind = state.risk as ClassifierActionKind;
    map = withScanAction(map, tool.name, {
      key: CLASSIFIER_SCAN_TOOL_ACTION_KEY,
      kind,
      readableName: state.readableName,
      description: prepared.description,
      replyTemplate: prepared.replyTemplate,
      arguments: prepared.arguments,
      decidingValues: {},
      definitionFingerprint: prepared.definitionFingerprint,
      scannedAt: prepared.reviewedAt,
      mark:
        kind === "outbound" && state.sendWithoutAsking
          ? { choice: "run_without_asking", fingerprint: prepared.definitionFingerprint }
          : null
    });
  }
  return map;
}
