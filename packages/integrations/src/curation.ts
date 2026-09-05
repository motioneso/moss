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
 * True exactly when withDerivedGroups will actually derive (not no-op): over threshold and
 * every tool arrived with no service-supplied group. Used to tell an algorithm-derived "Other"
 * bucket apart from a group a service literally named "Other" (OpenAPI's untagged-operation
 * fallback, openapi-convert.ts) -- only the derived bucket is a display-only, non-opt-in-able
 * unit; a service's own "Other" group is an ordinary group.
 */
export function willDeriveGroups(
  tools: readonly Pick<IntegrationToolDescriptor, "group">[]
): boolean {
  return tools.length > INTEGRATION_LIVE_TOOL_THRESHOLD && tools.every((t) => t.group === "");
}

/**
 * Attaches derived group names when a connection is over the threshold and the
 * service supplied no groups of its own. No-op (returns tools unchanged)
 * otherwise. Idempotent -- safe to call more than once on the same tools.
 */
export function withDerivedGroups<T extends Pick<IntegrationToolDescriptor, "name" | "group">>(
  tools: readonly T[]
): T[] {
  if (!willDeriveGroups(tools)) return [...tools];
  const derived = deriveGroups(tools.map((t) => t.name));
  return tools.map((t, i) => ({ ...t, group: derived[i] }));
}

export function effectiveEnabledTools(
  tools: readonly IntegrationToolDescriptor[],
  state: CurationState
): IntegrationToolDescriptor[] {
  const muted = new Set(state.mutedTools);
  const isDerivedOther = willDeriveGroups(tools);
  const withGroups = withDerivedGroups(tools);
  if (!isGroupOptIn(withGroups)) {
    return withGroups.filter((t) => !muted.has(t.name));
  }
  const groups = new Set(state.enabledGroups);
  const explicit = new Set(state.enabledTools);
  // Other is display-only and never an opt-in unit -- but only when it's the bucket this
  // algorithm invented (isDerivedOther). A service can also literally name a group "Other"
  // (OpenAPI's untagged-operation fallback); that's an ordinary group and keeps the ordinary
  // groups.has() check, or a pre-PR connection's already-flipped "Other" silently loses tools it
  // had live. Fable's ruling, #2175 comment 5513612338.
  return withGroups.filter((t) => {
    if (muted.has(t.name)) return false;
    if (explicit.has(t.name)) return true;
    if (isDerivedOther && t.group === OTHER_GROUP) return false;
    return groups.has(t.group);
  });
}
