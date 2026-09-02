import { INTEGRATION_LIVE_TOOL_THRESHOLD } from "@moss/shared";
import type { IntegrationToolDescriptor } from "@moss/shared";
import { deriveGroups, OTHER_GROUP } from "./derive-groups.js";

export interface CurationState {
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
}

export function isGroupOptIn(tools: { length: number }): boolean {
  return tools.length > INTEGRATION_LIVE_TOOL_THRESHOLD;
}

/**
 * Attaches derived group names when a connection is over the threshold and the
 * service supplied no groups of its own. No-op (returns tools unchanged)
 * otherwise. Idempotent -- safe to call more than once on the same tools.
 */
export function withDerivedGroups<T extends Pick<IntegrationToolDescriptor, "name" | "group">>(
  tools: readonly T[]
): T[] {
  if (tools.length <= INTEGRATION_LIVE_TOOL_THRESHOLD) return [...tools];
  if (!tools.every((t) => t.group === "")) return [...tools];
  const derived = deriveGroups(tools.map((t) => t.name));
  return tools.map((t, i) => ({ ...t, group: derived[i] }));
}

export function effectiveEnabledTools(
  tools: readonly IntegrationToolDescriptor[],
  state: CurationState
): IntegrationToolDescriptor[] {
  const muted = new Set(state.mutedTools);
  const withGroups = withDerivedGroups(tools);
  if (!isGroupOptIn(withGroups)) {
    return withGroups.filter((t) => !muted.has(t.name));
  }
  const groups = new Set(state.enabledGroups);
  const explicit = new Set(state.enabledTools);
  // Other is display-only and never an opt-in unit: enabledGroups containing
  // "Other" matches nothing there; an Other tool only enables by its own name
  // being explicitly listed in enabledTools. Fable's ruling, #2175 comment
  // 5513612338.
  return withGroups.filter((t) => {
    if (muted.has(t.name)) return false;
    if (explicit.has(t.name)) return true;
    if (t.group === OTHER_GROUP) return false;
    return groups.has(t.group);
  });
}
