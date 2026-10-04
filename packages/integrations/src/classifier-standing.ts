import type {
  IntegrationClassifierArgument,
  IntegrationClassifierRisk,
  IntegrationClassifierToolSort,
  IntegrationClassifierToolState,
  IntegrationToolDescriptor
} from "@moss/shared";

import { toolDefinitionFingerprint } from "./classifier-fingerprint.js";
import { readableToolNames } from "./classifier-readable-name.js";
import type { RiskInputSource } from "./classifier-risk-inputs.js";
import {
  preparationEntry,
  preparationFailure,
  sortRunsWithoutAsking,
  toolSortState,
  type ClassifierPreparationEntry,
  type ClassifierPreparationFailureReason,
  type ClassifierPreparationMap,
  type ClassifierSortMap,
  type ClassifierToolSortState
} from "./classifier-settings.js";
import { effectiveEnabledTools } from "./curation.js";
import type { DiscoveredTool } from "./openapi-convert.js";

/**
 * Where each discovered tool stands with the classifier (#2884, #2984).
 *
 * Reads the stored preparation and sort maps against the current tool list. Pure: it never calls
 * a model and never writes. The gate and the connection page both read toolStandings, so they
 * cannot disagree.
 */

const ROOT_COMBINATORS = ["anyOf", "oneOf", "allOf", "not"] as const;

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

/** A tool input schema with a root combinator cannot be declared to the classifier. */
export function schemaHasRootCombinator(schema: Record<string, unknown> | null): boolean {
  return schema !== null && ROOT_COMBINATORS.some((key) => key in schema);
}

/** What a tool's classifier standing is read from. Connection reachability is not part of it. */
export type ClassifierStandingInput = Pick<
  ClassifierConnectionState,
  | "classifierEnabled"
  | "discoveredTools"
  | "enabledGroups"
  | "enabledTools"
  | "mutedTools"
  | "classifierPreparation"
  | "classifierSort"
  | "classifierKeptOutTools"
>;

type CurrentSortState = Extract<ClassifierToolSortState, { status: "current" }>;

type ToolStanding = { readonly tool: RiskInputSource } & (
  | {
      readonly state: "ready";
      readonly sort: CurrentSortState;
      readonly entry: ClassifierPreparationEntry;
    }
  | {
      readonly state: "failed";
      readonly sort: ClassifierToolSortState;
      readonly reason: ClassifierPreparationFailureReason;
      readonly failedAt: string;
    }
  | {
      readonly state: Exclude<IntegrationClassifierToolState, "ready" | "failed">;
      readonly sort: ClassifierToolSortState;
    }
);

/**
 * Each discovered tool's classifier standing, in discovered order. `ready` is exactly the
 * eligibility rule of spec 8.5 apart from the connection being enabled and reachable, so the page
 * and the gate cannot disagree. A tool with a root-combinator schema is never prepared, so it is
 * `not_used` unless an older preparation for its current definition already makes it ready.
 */
function toolStandings(state: ClassifierStandingInput): ToolStanding[] {
  const ordinaryEnabled = new Set(
    effectiveEnabledTools(state.discoveredTools, {
      enabledGroups: state.enabledGroups,
      enabledTools: state.enabledTools,
      mutedTools: state.mutedTools
    }).map((tool) => tool.name)
  );
  const keptOut = new Set(state.classifierKeptOutTools);
  return state.discoveredTools.map((tool): ToolStanding => {
    const sort = toolSortState(state.classifierSort, tool);
    if (!state.classifierEnabled) return { tool, sort, state: "off" };
    if (keptOut.has(tool.name)) return { tool, sort, state: "kept_out" };
    if (!ordinaryEnabled.has(tool.name)) return { tool, sort, state: "not_used" };

    // A sort that failed for want of a model fails the classifier the same way, so the page
    // explains the missing model and offers the fix.
    if (sort.status === "failed") {
      return sort.failure === "no_model"
        ? { tool, sort, state: "failed", reason: "no_model", failedAt: sort.failedAt }
        : { tool, sort, state: "not_used" };
    }
    const entry = preparationEntry(state.classifierPreparation, tool.name);

    // A changed tool is sorted again before it is prepared again; both read as preparing again.
    if (sort.status !== "current") {
      return { tool, sort, state: entry ? "preparing_again" : "preparing" };
    }

    const fingerprint = toolDefinitionFingerprint(tool);
    if (entry?.definitionFingerprint === fingerprint) return { tool, sort, state: "ready", entry };
    if (schemaHasRootCombinator(tool.inputSchema)) return { tool, sort, state: "not_used" };
    const failure = preparationFailure(state.classifierPreparation, tool.name);
    if (failure?.definitionFingerprint === fingerprint) {
      return { tool, sort, state: "failed", reason: failure.reason, failedAt: failure.failedAt };
    }
    return { tool, sort, state: entry ? "preparing_again" : "preparing" };
  });
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
  if (!state.enabled || state.lastError !== null) return [];
  const out: EligibleClassifierTool[] = [];
  for (const standing of toolStandings(state)) {
    if (standing.state !== "ready") continue;
    const { tool, sort, entry } = standing;
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

/**
 * The API view: each discovered tool's sort against its current risk inputs, whether it asks, and
 * where it stands with the classifier. A tool without a current sort shows the free rule's name.
 */
export function classifierSortView(
  state: ClassifierStandingInput & { readonly discoveredTools: readonly DiscoveredTool[] }
): IntegrationClassifierToolSort[] {
  const freeNames = readableToolNames(state.discoveredTools);
  const keptOut = new Set(state.classifierKeptOutTools);
  return toolStandings(state).map((standing) => {
    const { tool, sort } = standing;
    const current = sort.status === "current";
    return {
      toolName: tool.name,
      status: sort.status,
      risk: current ? sort.risk : null,
      failure: sort.status === "failed" ? sort.failure : null,
      sendWithoutAsking: current && sort.sendWithoutAsking,
      asksFirst: !sortRunsWithoutAsking(sort),
      readableName: current ? sort.readableName : (freeNames.get(tool.name) ?? tool.name),
      sortedAt: current ? sort.sortedAt : null,
      sortedBy: current ? sort.sortedBy : null,
      sortMethod: current ? sort.sortMethod : null,
      failedAt:
        standing.state === "failed"
          ? standing.failedAt
          : sort.status === "failed"
            ? sort.failedAt
            : null,
      keptOut: keptOut.has(tool.name),
      classifierState: standing.state,
      preparationFailure: standing.state === "failed" ? standing.reason : null,
      preparedAt: standing.state === "ready" ? standing.entry.reviewedAt : null
    };
  });
}
