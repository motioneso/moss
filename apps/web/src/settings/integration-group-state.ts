import type { IntegrationDetail } from "@moss/shared";

type GroupedDetail = Pick<
  IntegrationDetail,
  "tools" | "groups" | "enabledGroups" | "enabledTools" | "mutedTools"
>;

/**
 * Mirrors the server rule in effectiveEnabledTools: a tool is on when it is not muted and is
 * either picked explicitly or belongs to a group the server reports as enabled. The server
 * reports a derived "Other" bucket as never enabled, so it is read from `groups`, not from
 * `enabledGroups`.
 */
export function isToolOn(detail: GroupedDetail, toolName: string, groupName: string): boolean {
  if (detail.mutedTools.includes(toolName)) return false;
  if (detail.enabledTools.includes(toolName)) return true;
  return detail.groups.find((g) => g.name === groupName)?.enabled ?? false;
}

/** A group switch is on only when every tool in the group is on. */
export function isGroupOn(detail: GroupedDetail, groupName: string): boolean {
  const members = detail.tools.filter((t) => t.group === groupName);
  return members.length > 0 && members.every((t) => isToolOn(detail, t.name, groupName));
}

/** Patch that turns every tool in the group on or off, whatever its current mix. */
export function groupTogglePatch(
  detail: GroupedDetail,
  groupName: string,
  on: boolean
): { enabledGroups: string[]; enabledTools: string[]; mutedTools: string[] } {
  const members = new Set(detail.tools.filter((t) => t.group === groupName).map((t) => t.name));
  const groups = new Set(detail.enabledGroups);
  const explicit = new Set(detail.enabledTools);
  const muted = new Set(detail.mutedTools);
  for (const name of members) {
    if (on) {
      explicit.add(name);
      muted.delete(name);
    } else {
      explicit.delete(name);
    }
  }
  if (on) groups.add(groupName);
  else groups.delete(groupName);
  return { enabledGroups: [...groups], enabledTools: [...explicit], mutedTools: [...muted] };
}
