import { INTEGRATION_LIVE_TOOL_THRESHOLD } from "@moss/shared";
import type { IntegrationToolDescriptor } from "@moss/shared";

export interface CurationState {
  readonly enabledGroups: readonly string[];
  readonly enabledTools: readonly string[];
  readonly mutedTools: readonly string[];
}

export function isGroupOptIn(tools: readonly Pick<IntegrationToolDescriptor, "group">[]): boolean {
  if (tools.length <= INTEGRATION_LIVE_TOOL_THRESHOLD) return false;
  return tools.some((t) => t.group !== "");
}

export function effectiveEnabledTools(
  tools: readonly IntegrationToolDescriptor[],
  state: CurationState
): IntegrationToolDescriptor[] {
  const muted = new Set(state.mutedTools);
  if (!isGroupOptIn(tools)) {
    return tools.filter((t) => !muted.has(t.name));
  }
  const groups = new Set(state.enabledGroups);
  const explicit = new Set(state.enabledTools);
  return tools.filter((t) => (groups.has(t.group) || explicit.has(t.name)) && !muted.has(t.name));
}
