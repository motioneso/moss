import { CLASSIFIER_LIMITS } from "@moss/module-sdk";
import type {
  IntegrationClassifierArgument,
  IntegrationClassifierPreparationState,
  IntegrationClassifierRisk,
  IntegrationClassifierToolPreparation,
  IntegrationToolDescriptor
} from "@moss/shared";

import { toolDefinitionFingerprint } from "./classifier-fingerprint.js";
import { effectiveEnabledTools } from "./curation.js";

/**
 * Owner storage, opt-in and invalidation for the connected-tool classifier (plan 2b.2, #2884).
 *
 * The stored shape is a single versioned map keyed by discovered tool name on the owner-only
 * connection row. This module is pure: it validates untrusted input, reads the stored map
 * defensively, and decides which tools are currently eligible. It never calls a model and never
 * writes — persistence and cache invalidation live in repository.ts and routes.ts.
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
}

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
  return { version: INTEGRATION_CLASSIFIER_PREPARATION_VERSION, entries };
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
  return { version: INTEGRATION_CLASSIFIER_PREPARATION_VERSION, entries };
}

export function withoutPreparationEntry(
  map: ClassifierPreparationMap,
  toolName: string
): ClassifierPreparationMap {
  if (!Object.prototype.hasOwnProperty.call(map.entries, toolName)) return map;
  const entries = entriesRecord(map.entries);
  delete entries[toolName];
  return { version: INTEGRATION_CLASSIFIER_PREPARATION_VERSION, entries };
}

export interface ClassifierConnectionState {
  readonly enabled: boolean;
  readonly classifierEnabled: boolean;
  readonly lastError: string | null;
  readonly discoveredTools: readonly IntegrationToolDescriptor[];
  /** Ordinary-chat curation: a tool the owner switched off for chat is not classifier-eligible. */
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
  readonly classifierPreparation: ClassifierPreparationMap;
}

export interface EligibleClassifierTool {
  readonly tool: IntegrationToolDescriptor;
  readonly risk: IntegrationClassifierRisk;
  readonly description: string;
  readonly arguments: Readonly<Record<string, IntegrationClassifierArgument>>;
  readonly replyTemplate: string;
  readonly candidateSource?: string;
}

/**
 * The tools the classifier may offer for this connection, in discovered order.
 *
 * Fail-closed everywhere: a disabled connection, the switch off, a failed discovery, a tool that
 * is no longer discovered, a tool the owner switched off for ordinary chat, no saved opt-in, an
 * unknown risk, or a definition that no longer matches the reviewed fingerprint all remove the
 * tool. A changed definition therefore reads as stale immediately, and a discovery failure cannot
 * preserve eligibility just because ordinary chat keeps its old tool list.
 */
export function effectiveClassifierTools(
  state: ClassifierConnectionState
): EligibleClassifierTool[] {
  if (!state.enabled || !state.classifierEnabled || state.lastError !== null) return [];
  // A tool the owner muted (or, over the group-opt-in threshold, never enabled) is off for
  // ordinary chat and must not become classifier-eligible behind that switch.
  const ordinaryEnabled = new Set(
    effectiveEnabledTools(state.discoveredTools, {
      enabledGroups: state.enabledGroups,
      enabledTools: state.enabledTools,
      mutedTools: state.mutedTools
    }).map((tool) => tool.name)
  );
  const out: EligibleClassifierTool[] = [];
  for (const tool of state.discoveredTools) {
    if (!ordinaryEnabled.has(tool.name)) continue;
    const entry = preparationEntry(state.classifierPreparation, tool.name);
    if (!entry || !entry.optIn || entry.reviewedRisk === null) continue;
    if (entry.definitionFingerprint !== toolDefinitionFingerprint(tool)) continue;
    out.push({
      tool,
      risk: entry.reviewedRisk,
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
  state: ClassifierConnectionState
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
