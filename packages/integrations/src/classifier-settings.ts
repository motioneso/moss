import { CLASSIFIER_LIMITS } from "@moss/module-sdk";
import type {
  IntegrationClassifierArgument,
  IntegrationClassifierPreparationState,
  IntegrationClassifierRisk,
  IntegrationClassifierToolPreparation,
  IntegrationClassifierToolSort,
  IntegrationToolDescriptor
} from "@moss/shared";

import { toolDefinitionFingerprint } from "./classifier-fingerprint.js";
import {
  higherRisk,
  toolRiskInputs,
  toolSortFingerprint,
  type RiskInputSource
} from "./classifier-risk-inputs.js";
import { effectiveEnabledTools } from "./curation.js";

/**
 * Owner storage and invalidation for the connected-tool classifier (#2884, #2984).
 *
 * Preparation and sorting are versioned maps keyed by discovered tool name on the owner-only
 * connection row. This module is pure: it validates untrusted input, reads the stored maps
 * defensively, and decides which tools are currently eligible. It never calls a model and never
 * writes. Persistence and cache invalidation live in repository.ts and routes.ts.
 */

export const INTEGRATION_CLASSIFIER_PREPARATION_VERSION = 1 as const;

/** Bound on the stored map so one connection cannot grow it without limit. */
export const INTEGRATION_CLASSIFIER_MAX_ENTRIES = 200;

/** Per-tool bounds. Descriptions and templates reuse the classifier's own declared limits. */
export const INTEGRATION_CLASSIFIER_MAX_ARGUMENTS = CLASSIFIER_LIMITS.candidates;
export const INTEGRATION_CLASSIFIER_MAX_DESCRIPTION_CHARS = CLASSIFIER_LIMITS.descriptionChars;
export const INTEGRATION_CLASSIFIER_MAX_TEMPLATE_CHARS = CLASSIFIER_LIMITS.templateChars;
export const INTEGRATION_CLASSIFIER_MAX_ARGUMENT_VALUES = CLASSIFIER_LIMITS.candidates;
export const INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS = CLASSIFIER_LIMITS.idChars;
/** One serialized entry cannot exceed this. */
export const INTEGRATION_CLASSIFIER_MAX_ENTRY_JSON_CHARS = 8192;

const RISKS: readonly IntegrationClassifierRisk[] = ["read", "write", "outbound", "destructive"];
const ARGUMENT_KINDS = ["enum", "candidates", "extract"] as const;
const ARGUMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ClassifierPreparationEntry {
  readonly optIn: boolean;
  readonly reviewedRisk: IntegrationClassifierRisk | null;
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
  readonly candidateSource?: string;
  readonly definitionFingerprint: string;
  readonly reviewedAt: string;
  readonly preparationVersion: number;
}

export interface ClassifierPreparationMap {
  readonly version: typeof INTEGRATION_CLASSIFIER_PREPARATION_VERSION;
  readonly entries: Readonly<Record<string, ClassifierPreparationEntry>>;
  /** Automatic preparations that failed, keyed by tool name. Only the owner's Try again resends them. */
  readonly failures?: Readonly<Record<string, ClassifierPreparationFailure>>;
}

/**
 * Why automatic preparation failed. `unsafe` means the tool's text held the stored credential.
 * `unsupported_shape` means the prepared entry could never be stored, and `too_many_tools` means
 * the connection already holds the most prepared tools it can store.
 */
export type ClassifierPreparationFailureReason =
  | "unsafe"
  | "provider_error"
  | "invalid_draft"
  | "definition_too_large"
  | "unsupported_shape"
  | "too_many_tools";

export interface ClassifierPreparationFailure {
  readonly reason: ClassifierPreparationFailureReason;
  /** The definition fingerprint the failed attempt was made against. */
  readonly definitionFingerprint: string;
  readonly failedAt: string;
}

const PREPARATION_FAILURE_REASONS: readonly ClassifierPreparationFailureReason[] = [
  "unsafe",
  "provider_error",
  "invalid_draft",
  "definition_too_large",
  "unsupported_shape",
  "too_many_tools"
];

/**
 * Tool names are attacker-influenced (a connected server chooses them), so they are looked up as
 * own keys only. A plain `{}` map would answer `entries["toString"]` with Object.prototype's
 * function and `"__proto__" in entries` with true; a null-prototype record plus
 * `Object.prototype.hasOwnProperty` keeps a tool literally named `toString`, `constructor` or
 * `__proto__` from manufacturing a fake review row or polluting a prototype.
 */
function entriesRecord(
  source?: Readonly<Record<string, ClassifierPreparationEntry>>
): Record<string, ClassifierPreparationEntry> {
  const out = Object.create(null) as Record<string, ClassifierPreparationEntry>;
  if (source) for (const key of Object.keys(source)) out[key] = source[key]!;
  return out;
}

/** The stored entry for a tool name, only when it is an own key. */
export function preparationEntry(
  map: ClassifierPreparationMap,
  toolName: string
): ClassifierPreparationEntry | undefined {
  return Object.prototype.hasOwnProperty.call(map.entries, toolName)
    ? map.entries[toolName]
    : undefined;
}

export function emptyPreparationMap(): ClassifierPreparationMap {
  return { version: INTEGRATION_CLASSIFIER_PREPARATION_VERSION, entries: entriesRecord() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneLine(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value) && value.length <= max
  );
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS
  );
}

function parseRisk(value: unknown, problems: string[]): IntegrationClassifierRisk | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && (RISKS as readonly string[]).includes(value)) {
    return value as IntegrationClassifierRisk;
  }
  problems.push("reviewedRisk must be read, write, outbound, destructive, or null");
  return null;
}

/** Validate one argument declaration. Returns the cleaned value or undefined (and records why). */
function parseArgument(
  name: string,
  raw: unknown,
  problems: string[]
): IntegrationClassifierArgument | undefined {
  if (!ARGUMENT_NAME.test(name) || name.length > INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS) {
    problems.push(`argument name "${name}" is not a valid bounded identifier`);
    return undefined;
  }
  if (!isRecord(raw)) {
    problems.push(`argument "${name}" must be an object`);
    return undefined;
  }
  if (!(ARGUMENT_KINDS as readonly unknown[]).includes(raw.kind)) {
    problems.push(`argument "${name}" kind must be enum, candidates, or extract`);
    return undefined;
  }
  const kind = raw.kind as IntegrationClassifierArgument["kind"];
  if (kind === "enum") {
    if (!Array.isArray(raw.values) || raw.values.length === 0) {
      problems.push(`argument "${name}" declared enum needs at least one value`);
      return undefined;
    }
    if (raw.values.length > INTEGRATION_CLASSIFIER_MAX_ARGUMENT_VALUES) {
      problems.push(
        `argument "${name}" has more than ${INTEGRATION_CLASSIFIER_MAX_ARGUMENT_VALUES} values`
      );
      return undefined;
    }
    const values: string[] = [];
    for (const value of raw.values) {
      if (!isOneLine(value, INTEGRATION_CLASSIFIER_MAX_IDENTIFIER_CHARS)) {
        problems.push(`argument "${name}" has an invalid enum value`);
        return undefined;
      }
      values.push(value);
    }
    if (raw.candidateSource !== undefined) {
      problems.push(`argument "${name}" is an enum and cannot also name a candidate source`);
      return undefined;
    }
    return { kind, values };
  }
  if (kind === "candidates") {
    if (!isIdentifier(raw.candidateSource)) {
      problems.push(`argument "${name}" declared candidates needs a bounded candidateSource`);
      return undefined;
    }
    if (raw.values !== undefined) {
      problems.push(`argument "${name}" declared candidates cannot carry fixed values`);
      return undefined;
    }
    return { kind, candidateSource: raw.candidateSource as string };
  }
  if (raw.values !== undefined || raw.candidateSource !== undefined) {
    problems.push(`argument "${name}" declared extract carries no values or candidate source`);
    return undefined;
  }
  return { kind };
}

function parseArguments(
  raw: unknown,
  problems: string[]
): Record<string, IntegrationClassifierArgument> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) {
    problems.push("arguments must be an object");
    return {};
  }
  const names = Object.keys(raw);
  if (names.length > INTEGRATION_CLASSIFIER_MAX_ARGUMENTS) {
    problems.push(`more than ${INTEGRATION_CLASSIFIER_MAX_ARGUMENTS} arguments`);
    return {};
  }
  // Null prototype: an argument named `__proto__` stays an own key instead of hitting the setter.
  const out = Object.create(null) as Record<string, IntegrationClassifierArgument>;
  for (const name of names) {
    const parsed = parseArgument(name, raw[name], problems);
    if (parsed) out[name] = parsed;
  }
  return out;
}

export interface ReviewedEntryInput {
  readonly optIn: boolean;
  readonly reviewedRisk: IntegrationClassifierRisk | null;
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
  readonly candidateSource?: string;
  readonly reviewedFingerprint: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Validate an untrusted save body. The tool name comes from the path, never the body. A body that
 * is not clean is rejected whole — never truncated — so a half-written review is never stored.
 */
export function parseReviewedEntry(raw: unknown): ParseResult<ReviewedEntryInput> {
  if (!isRecord(raw)) return { ok: false, problems: ["body must be a JSON object"] };
  const problems: string[] = [];

  if (typeof raw.optIn !== "boolean") problems.push("optIn must be a boolean");
  const reviewedRisk = parseRisk(raw.reviewedRisk, problems);

  const description = raw.description;
  if (!isOneLine(description, INTEGRATION_CLASSIFIER_MAX_DESCRIPTION_CHARS)) {
    problems.push(
      `description must be one line of at most ${INTEGRATION_CLASSIFIER_MAX_DESCRIPTION_CHARS} characters`
    );
  }
  const replyTemplate = raw.replyTemplate;
  if (!isOneLine(replyTemplate, INTEGRATION_CLASSIFIER_MAX_TEMPLATE_CHARS)) {
    problems.push(
      `replyTemplate must be one line of at most ${INTEGRATION_CLASSIFIER_MAX_TEMPLATE_CHARS} characters`
    );
  }
  const args = parseArguments(raw.arguments, problems);

  let candidateSource: string | undefined;
  if (raw.candidateSource !== undefined) {
    if (!isIdentifier(raw.candidateSource)) {
      problems.push("candidateSource must be a bounded non-empty string");
    } else {
      candidateSource = raw.candidateSource;
    }
  }

  if (!isIdentifier(raw.reviewedFingerprint)) {
    problems.push("reviewedFingerprint must be a non-empty string");
  }

  // One tool gets one candidate list, and the gate offers that single list for every candidates
  // argument. A tool whose arguments name more than one distinct source would have one argument
  // filled from a list the owner never approved for it, so the shape is refused at save time. The
  // menu builder enforces the same rule for entries already stored by an older version.
  const distinctSources = new Set(
    Object.values(args)
      .filter(
        (argument) => argument.kind === "candidates" && argument.candidateSource !== undefined
      )
      .map((argument) => argument.candidateSource as string)
  );
  if (distinctSources.size > 1) {
    problems.push("a tool may name at most one candidate source across its arguments");
  }

  if (problems.length > 0) return { ok: false, problems };

  const value: ReviewedEntryInput = {
    optIn: raw.optIn as boolean,
    reviewedRisk,
    description: description as string,
    arguments: args,
    replyTemplate: replyTemplate as string,
    ...(candidateSource !== undefined ? { candidateSource } : {}),
    reviewedFingerprint: raw.reviewedFingerprint as string
  };
  if (JSON.stringify(value).length > INTEGRATION_CLASSIFIER_MAX_ENTRY_JSON_CHARS) {
    return { ok: false, problems: ["review entry is too large"] };
  }
  return { ok: true, value };
}

/** Read one stored entry defensively. Any malformed entry is dropped, never trusted. */
function parseStoredEntry(raw: unknown): ClassifierPreparationEntry | null {
  if (!isRecord(raw)) return null;
  const parsed = parseReviewedEntry({
    optIn: raw.optIn,
    reviewedRisk: raw.reviewedRisk,
    description: raw.description,
    arguments: raw.arguments,
    replyTemplate: raw.replyTemplate,
    candidateSource: raw.candidateSource,
    reviewedFingerprint: raw.definitionFingerprint
  });
  if (!parsed.ok) return null;
  if (typeof raw.reviewedAt !== "string" || raw.reviewedAt === "") return null;
  const preparationVersion =
    typeof raw.preparationVersion === "number" &&
    Number.isInteger(raw.preparationVersion) &&
    raw.preparationVersion > 0
      ? raw.preparationVersion
      : null;
  if (preparationVersion === null) return null;

  const { reviewedFingerprint, ...rest } = parsed.value;
  return {
    ...rest,
    definitionFingerprint: reviewedFingerprint,
    reviewedAt: raw.reviewedAt,
    preparationVersion
  };
}

/**
 * Read the stored jsonb map. A map that is not the expected shape reads as empty; individual
 * malformed entries are dropped. Failing closed here is what keeps a corrupted column from
 * silently becoming eligibility.
 */
export function parsePreparationMap(raw: unknown): ClassifierPreparationMap {
  if (!isRecord(raw)) return emptyPreparationMap();
  if (raw.version !== INTEGRATION_CLASSIFIER_PREPARATION_VERSION) return emptyPreparationMap();
  if (!isRecord(raw.entries)) return emptyPreparationMap();
  const entries = entriesRecord();
  for (const [toolName, value] of Object.entries(raw.entries)) {
    if (!isIdentifier(toolName)) continue;
    const parsed = parseStoredEntry(value);
    if (parsed) entries[toolName] = parsed;
  }
  const failures = parseFailures(raw.failures);
  return {
    version: INTEGRATION_CLASSIFIER_PREPARATION_VERSION,
    entries,
    ...(failures ? { failures } : {})
  };
}

function parseFailures(raw: unknown): Record<string, ClassifierPreparationFailure> | null {
  if (!isRecord(raw)) return null;
  const out = Object.create(null) as Record<string, ClassifierPreparationFailure>;
  for (const [toolName, value] of Object.entries(raw)) {
    if (!isIdentifier(toolName) || !isRecord(value)) continue;
    const reason = PREPARATION_FAILURE_REASONS.find((candidate) => candidate === value.reason);
    if (!reason) continue;
    if (typeof value.definitionFingerprint !== "string" || value.definitionFingerprint === "") {
      continue;
    }
    if (typeof value.failedAt !== "string" || value.failedAt === "") continue;
    out[toolName] = {
      reason,
      definitionFingerprint: value.definitionFingerprint,
      failedAt: value.failedAt
    };
  }
  return out;
}

/** The stored failure for a tool name, only when it is an own key. */
export function preparationFailure(
  map: ClassifierPreparationMap,
  toolName: string
): ClassifierPreparationFailure | undefined {
  return map.failures && Object.prototype.hasOwnProperty.call(map.failures, toolName)
    ? map.failures[toolName]
    : undefined;
}

/** Whether the map can take an entry for this tool: it replaces one, or the cap has room. */
export function preparationHasRoom(map: ClassifierPreparationMap, toolName: string): boolean {
  return (
    preparationEntry(map, toolName) !== undefined ||
    Object.keys(map.entries).length < INTEGRATION_CLASSIFIER_MAX_ENTRIES
  );
}

/** Merge one reviewed entry, keeping at most the bounded number of entries. */
export function withPreparationEntry(
  map: ClassifierPreparationMap,
  toolName: string,
  entry: ClassifierPreparationEntry
): ClassifierPreparationMap {
  const entries = entriesRecord(map.entries);
  entries[toolName] = entry;
  const names = Object.keys(entries);
  if (names.length > INTEGRATION_CLASSIFIER_MAX_ENTRIES) return map;
  return { ...map, version: INTEGRATION_CLASSIFIER_PREPARATION_VERSION, entries };
}

export function withoutPreparationEntry(
  map: ClassifierPreparationMap,
  toolName: string
): ClassifierPreparationMap {
  if (!Object.prototype.hasOwnProperty.call(map.entries, toolName)) return map;
  const entries = entriesRecord(map.entries);
  delete entries[toolName];
  return { ...map, version: INTEGRATION_CLASSIFIER_PREPARATION_VERSION, entries };
}

export interface ClassifierConnectionState {
  readonly enabled: boolean;
  readonly classifierEnabled: boolean;
  readonly lastError: string | null;
  readonly discoveredTools: readonly RiskInputSource[];
  /** Ordinary-chat curation: a tool the owner switched off for chat is not classifier-eligible. */
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
  readonly classifierPreparation: ClassifierPreparationMap;
  readonly classifierSort: ClassifierSortMap;
  readonly classifierKeptOutTools: readonly string[];
}

export interface EligibleClassifierTool {
  readonly tool: IntegrationToolDescriptor;
  /** The current sort's risk, after the code rule and the old reviewed floor. */
  readonly risk: IntegrationClassifierRisk;
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
  readonly candidateSource?: string;
}

/**
 * The tools the classifier may offer for this connection, in discovered order (spec 8.5). This is
 * the connected-tool release: the gate offers exactly these.
 *
 * Fail-closed everywhere: a disabled connection, the switch off, a failed discovery, a tool that
 * is no longer discovered, a tool the owner switched off for ordinary chat, a kept-out tool, a
 * sort that is not current against the tool's risk inputs, or a preparation that is missing or
 * made against another definition all remove the tool. A changed tool therefore drops out at once
 * and returns only after it is sorted and prepared again.
 */
export function effectiveClassifierTools(
  state: ClassifierConnectionState
): EligibleClassifierTool[] {
  if (!state.enabled || !state.classifierEnabled || state.lastError !== null) return [];
  const ordinaryEnabled = new Set(
    effectiveEnabledTools(state.discoveredTools, {
      enabledGroups: state.enabledGroups,
      enabledTools: state.enabledTools,
      mutedTools: state.mutedTools
    }).map((tool) => tool.name)
  );
  const keptOut = new Set(state.classifierKeptOutTools);
  const out: EligibleClassifierTool[] = [];
  for (const tool of state.discoveredTools) {
    if (!ordinaryEnabled.has(tool.name) || keptOut.has(tool.name)) continue;
    const sort = toolSortState(state.classifierSort, tool);
    if (sort.status !== "current") continue;
    const entry = preparationEntry(state.classifierPreparation, tool.name);
    if (!entry || entry.definitionFingerprint !== toolDefinitionFingerprint(tool)) continue;
    out.push({
      tool,
      risk: sort.risk,
      description: entry.description,
      arguments: entry.arguments,
      replyTemplate: entry.replyTemplate,
      ...(entry.candidateSource !== undefined ? { candidateSource: entry.candidateSource } : {})
    });
  }
  return out;
}

/** The API view: one row per discovered tool that has a saved review, with derived state. */
export function classifierPreparationView(
  state: Pick<ClassifierConnectionState, "discoveredTools" | "classifierPreparation">
): IntegrationClassifierToolPreparation[] {
  const view: IntegrationClassifierToolPreparation[] = [];
  for (const tool of state.discoveredTools) {
    const entry = preparationEntry(state.classifierPreparation, tool.name);
    if (!entry) continue;
    const entryState: IntegrationClassifierPreparationState =
      entry.definitionFingerprint === toolDefinitionFingerprint(tool) ? "current" : "stale";
    view.push({ toolName: tool.name, ...entry, state: entryState });
  }
  return view;
}

/*
 * Sort storage (spec 8.2 and 8.3, #2984).
 *
 * A second versioned map on the owner-only connection row, keyed by discovered tool name. Each
 * entry holds the sorting pass's result for one tool, the owner's send-without-asking choice, and
 * a risk floor converted once from the old per-tool review. Like the preparation map it is read
 * defensively: a malformed map reads as empty and a malformed entry is dropped, so every tool
 * falls back to never tried and asks.
 */

export const INTEGRATION_CLASSIFIER_SORT_VERSION = 1 as const;

/** Bound on the stored sort map. Every discovered tool needs an entry, so this sits well above the opt-in bound. */
export const INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES = 1000;

export const INTEGRATION_CLASSIFIER_MAX_READABLE_NAME_CHARS = 80;

export type ClassifierSortStatus = "current" | "failed" | "never_tried";

/** Why a sort failed. `unsafe` means the tool's text held the stored credential and was not sent. */
export type ClassifierSortFailure = "error" | "unsafe";

export interface ClassifierSortEntry {
  readonly status: ClassifierSortStatus;
  /** The sorted group as its risk, after the code rule. Set only when current. */
  readonly risk: IntegrationClassifierRisk | null;
  /** The model-written display name. Set only when current. */
  readonly readableName: string | null;
  /** The risk-inputs fingerprint the sort or the failure was made against. */
  readonly sortFingerprint: string | null;
  readonly sortedAt: string | null;
  readonly failure: ClassifierSortFailure | null;
  /** The owner's choice to let a Sends things out tool run without asking. Tied to `sortFingerprint`. */
  readonly sendWithoutAsking: boolean;
  /** An owner-reviewed risk from the old flow. It only ever raises the sorted risk. */
  readonly legacyRiskFloor: IntegrationClassifierRisk | null;
}

export interface ClassifierSortMap {
  readonly version: typeof INTEGRATION_CLASSIFIER_SORT_VERSION;
  readonly entries: Readonly<Record<string, ClassifierSortEntry>>;
}

/** A tool's sort as read against its current risk inputs. Anything but `current` asks. */
export type ClassifierToolSortState =
  | {
      readonly status: "current";
      readonly risk: IntegrationClassifierRisk;
      readonly readableName: string;
      readonly sendWithoutAsking: boolean;
    }
  | { readonly status: "stale" }
  | { readonly status: "failed"; readonly failure: ClassifierSortFailure }
  | { readonly status: "never_tried" };

/** One sorting result to store. */
export type ClassifierSortResult =
  | {
      readonly status: "current";
      readonly risk: IntegrationClassifierRisk;
      readonly readableName: string;
      readonly sortFingerprint: string;
      readonly sortedAt: string;
    }
  | {
      readonly status: "failed";
      readonly failure: ClassifierSortFailure;
      readonly sortFingerprint: string;
      readonly sortedAt: string;
    };

function sortEntriesRecord(
  source?: Readonly<Record<string, ClassifierSortEntry>>
): Record<string, ClassifierSortEntry> {
  const out = Object.create(null) as Record<string, ClassifierSortEntry>;
  if (source) for (const key of Object.keys(source)) out[key] = source[key]!;
  return out;
}

export function emptySortMap(): ClassifierSortMap {
  return { version: INTEGRATION_CLASSIFIER_SORT_VERSION, entries: sortEntriesRecord() };
}

/** The stored sort entry for a tool name, only when it is an own key. */
export function sortEntry(
  map: ClassifierSortMap,
  toolName: string
): ClassifierSortEntry | undefined {
  return Object.prototype.hasOwnProperty.call(map.entries, toolName)
    ? map.entries[toolName]
    : undefined;
}

/** A display name is one line of bounded plain text with no control characters. */
export function isReadableName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= INTEGRATION_CLASSIFIER_MAX_READABLE_NAME_CHARS &&
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function storedRisk(value: unknown): IntegrationClassifierRisk | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && (RISKS as readonly string[]).includes(value)
    ? (value as IntegrationClassifierRisk)
    : undefined;
}

/** Read one stored sort entry. Any field that breaks its status's shape drops the entry. */
function parseStoredSortEntry(raw: unknown): ClassifierSortEntry | null {
  if (!isRecord(raw)) return null;
  const legacyRiskFloor = storedRisk(raw.legacyRiskFloor);
  if (legacyRiskFloor === undefined) return null;
  const base = { legacyRiskFloor };

  if (raw.status === "never_tried") {
    return {
      ...base,
      status: "never_tried",
      risk: null,
      readableName: null,
      sortFingerprint: null,
      sortedAt: null,
      failure: null,
      sendWithoutAsking: false
    };
  }
  if (!isIdentifier(raw.sortFingerprint) || !isIdentifier(raw.sortedAt)) return null;
  if (raw.status === "failed") {
    if (raw.failure !== "error" && raw.failure !== "unsafe") return null;
    return {
      ...base,
      status: "failed",
      risk: null,
      readableName: null,
      sortFingerprint: raw.sortFingerprint,
      sortedAt: raw.sortedAt,
      failure: raw.failure,
      sendWithoutAsking: false
    };
  }
  if (raw.status !== "current") return null;
  const risk = storedRisk(raw.risk);
  if (!risk || !isReadableName(raw.readableName)) return null;
  return {
    ...base,
    status: "current",
    risk,
    readableName: raw.readableName,
    sortFingerprint: raw.sortFingerprint,
    sortedAt: raw.sortedAt,
    failure: null,
    // The choice exists only while the sort, raised by any old floor, is Sends things out.
    sendWithoutAsking:
      raw.sendWithoutAsking === true && higherRisk(risk, legacyRiskFloor) === "outbound"
  };
}

export function parseSortMap(raw: unknown): ClassifierSortMap {
  if (!isRecord(raw)) return emptySortMap();
  if (raw.version !== INTEGRATION_CLASSIFIER_SORT_VERSION) return emptySortMap();
  if (!isRecord(raw.entries)) return emptySortMap();
  const entries = sortEntriesRecord();
  for (const [toolName, value] of Object.entries(raw.entries)) {
    if (!isIdentifier(toolName)) continue;
    const parsed = parseStoredSortEntry(value);
    if (parsed) entries[toolName] = parsed;
  }
  return { version: INTEGRATION_CLASSIFIER_SORT_VERSION, entries };
}

/**
 * A tool's sort against its current risk inputs. A sort or failure made against other inputs is
 * stale. The sorted risk is raised to the old reviewed floor, never lowered by it, and the
 * send-without-asking choice counts only while the tool's risk is `outbound`.
 */
export function toolSortState(
  map: ClassifierSortMap,
  tool: RiskInputSource
): ClassifierToolSortState {
  const entry = sortEntry(map, tool.name);
  if (!entry || entry.status === "never_tried") return { status: "never_tried" };
  if (entry.sortFingerprint !== toolSortFingerprint(toolRiskInputs(tool))) {
    return { status: "stale" };
  }
  if (entry.status === "failed") return { status: "failed", failure: entry.failure ?? "error" };
  const risk = higherRisk(entry.risk!, entry.legacyRiskFloor);
  return {
    status: "current",
    risk,
    readableName: entry.readableName!,
    sendWithoutAsking: entry.sendWithoutAsking && risk === "outbound"
  };
}

/**
 * Store one sorting result. The old reviewed floor survives. A send-without-asking choice
 * survives only a result made against the same risk inputs as the current sort it was set on.
 * Returns `null` for a result whose shape is not storable.
 */
export function withSortResult(
  map: ClassifierSortMap,
  toolName: string,
  result: ClassifierSortResult
): ClassifierSortMap | null {
  if (!isIdentifier(toolName) || !isIdentifier(result.sortFingerprint)) return null;
  if (!isIdentifier(result.sortedAt)) return null;
  const previous = sortEntry(map, toolName);
  if (!previous && Object.keys(map.entries).length >= INTEGRATION_CLASSIFIER_MAX_SORT_ENTRIES) {
    return null;
  }
  const legacyRiskFloor = previous?.legacyRiskFloor ?? null;

  let entry: ClassifierSortEntry;
  if (result.status === "current") {
    if (!(RISKS as readonly string[]).includes(result.risk)) return null;
    if (!isReadableName(result.readableName)) return null;
    const keepsChoice =
      previous?.status === "current" &&
      previous.sortFingerprint === result.sortFingerprint &&
      higherRisk(result.risk, legacyRiskFloor) === "outbound";
    entry = {
      status: "current",
      risk: result.risk,
      readableName: result.readableName,
      sortFingerprint: result.sortFingerprint,
      sortedAt: result.sortedAt,
      failure: null,
      sendWithoutAsking: keepsChoice ? previous.sendWithoutAsking : false,
      legacyRiskFloor
    };
  } else {
    if (result.failure !== "error" && result.failure !== "unsafe") return null;
    entry = {
      status: "failed",
      risk: null,
      readableName: null,
      sortFingerprint: result.sortFingerprint,
      sortedAt: result.sortedAt,
      failure: result.failure,
      sendWithoutAsking: false,
      legacyRiskFloor
    };
  }
  const entries = sortEntriesRecord(map.entries);
  entries[toolName] = entry;
  return { version: INTEGRATION_CLASSIFIER_SORT_VERSION, entries };
}

/**
 * Set or clear the owner's send-without-asking choice on one tool. Clearing always succeeds,
 * because it only adds asking. Setting needs a current sort whose risk is `outbound`; anything
 * else returns `null`.
 */
export function withSendWithoutAsking(
  map: ClassifierSortMap,
  tool: RiskInputSource,
  allow: boolean
): ClassifierSortMap | null {
  const entry = sortEntry(map, tool.name);
  if (!allow) {
    if (!entry || !entry.sendWithoutAsking) return map;
  } else {
    const state = toolSortState(map, tool);
    if (state.status !== "current" || state.risk !== "outbound" || !entry) return null;
  }
  const entries = sortEntriesRecord(map.entries);
  entries[tool.name] = { ...entry!, sendWithoutAsking: allow };
  return { version: INTEGRATION_CLASSIFIER_SORT_VERSION, entries };
}

/**
 * Clear every send-without-asking choice whose sort has gone stale against the newly discovered
 * tools, or whose tool is gone. A tool whose inputs change and later change back therefore still
 * asks until the owner allows it again.
 */
export function withoutStaleSendChoices(
  map: ClassifierSortMap,
  tools: readonly RiskInputSource[]
): ClassifierSortMap {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let entries: Record<string, ClassifierSortEntry> | null = null;
  for (const [toolName, entry] of Object.entries(map.entries)) {
    if (!entry.sendWithoutAsking) continue;
    const tool = byName.get(toolName);
    if (tool && entry.sortFingerprint === toolSortFingerprint(toolRiskInputs(tool))) continue;
    entries ??= sortEntriesRecord(map.entries);
    entries[toolName] = { ...entry, sendWithoutAsking: false };
  }
  return entries ? { version: INTEGRATION_CLASSIFIER_SORT_VERSION, entries } : map;
}

/**
 * Whether a connected tool runs in chat without asking (spec 8.3): a current sort of Looks things
 * up or Changes things, or Sends things out with the owner's choice. Sensitive, never tried, failed
 * and stale sorts ask, and a send choice on any group but Sends things out is ignored.
 */
export function toolRunsWithoutAsking(map: ClassifierSortMap, tool: RiskInputSource): boolean {
  const state = toolSortState(map, tool);
  if (state.status !== "current") return false;
  if (state.risk === "read" || state.risk === "write") return true;
  return state.risk === "outbound" && state.sendWithoutAsking;
}

/** The API view: each discovered tool's sort against its current risk inputs, and whether it asks. */
export function classifierSortView(
  map: ClassifierSortMap,
  tools: readonly RiskInputSource[]
): IntegrationClassifierToolSort[] {
  return tools.map((tool) => {
    const state = toolSortState(map, tool);
    const current = state.status === "current";
    return {
      toolName: tool.name,
      status: state.status,
      risk: current ? state.risk : null,
      failure: state.status === "failed" ? state.failure : null,
      sendWithoutAsking: current && state.sendWithoutAsking,
      asksFirst: !toolRunsWithoutAsking(map, tool)
    };
  });
}
