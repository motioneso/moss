/**
 * The one table of tools the outside agent may have and what each may do
 * (#2380). Both the launch-time tool list (phase 5) and the use-time policy
 * derive from these rows, so the two cannot drift apart again. Names are the
 * real tool identifiers from adapter platform code — never display titles.
 */

import type { AcpProfile } from "./capabilities.js";

export type AcpToolFamily =
  | "read"
  | "web"
  | "harmless"
  | "write"
  | "shell"
  | "mode"
  | "not-offered"
  | "moss";

export interface AcpToolRow {
  readonly name: string;
  readonly family: Exclude<AcpToolFamily, "moss">;
  readonly chat: boolean;
  readonly workshop: boolean;
}

/** Prefix the adapter puts on its own bridged file and shell tool names. */
const ACP_TOOL_PREFIX = "mcp__acp__";
/** Prefix of Moss's own tools when they appear as agent tool calls. */
export const ACP_MOSS_TOOL_PREFIX = "mcp__moss__";

function rowsFor(
  names: readonly string[],
  family: AcpToolRow["family"],
  chat: boolean,
  workshop: boolean
): AcpToolRow[] {
  return names.map((name) => ({ name, family, chat, workshop }));
}

/**
 * Exactly the names the adapter defines: bare built-ins plus the six bridged
 * `mcp__acp__` file and shell tools (adapter dist/tools.js). Nothing invented.
 */
const ACP_TOOL_TABLE: readonly AcpToolRow[] = [
  ...rowsFor(["Read", "NotebookRead", "LS", "Glob", "Grep"], "read", true, true),
  ...rowsFor([`${ACP_TOOL_PREFIX}Read`], "read", true, true),
  ...rowsFor(["WebFetch", "WebSearch"], "web", true, true),
  ...rowsFor(["TodoWrite", "BashOutput", `${ACP_TOOL_PREFIX}BashOutput`], "harmless", true, true),
  ...rowsFor(["Write", "Edit", "MultiEdit", "NotebookEdit"], "write", false, true),
  ...rowsFor([`${ACP_TOOL_PREFIX}Write`, `${ACP_TOOL_PREFIX}Edit`], "write", false, true),
  ...rowsFor(["Bash", "KillShell"], "shell", false, false),
  ...rowsFor([`${ACP_TOOL_PREFIX}Bash`, `${ACP_TOOL_PREFIX}KillShell`], "shell", false, false),
  ...rowsFor(["ExitPlanMode", "EnterPlanMode"], "mode", false, false),
  ...rowsFor(["Task", "Skill", "SlashCommand", "AskUserQuestion"], "not-offered", false, false)
];

/** Family for a real tool name, "moss" for our own tools, else unknown. */
export function lookupAcpToolFamily(name: string): AcpToolFamily | "unknown" {
  const row = ACP_TOOL_TABLE.find((candidate) => candidate.name === name);
  if (row) return row.family;
  if (name.startsWith(ACP_MOSS_TOOL_PREFIX) && name.length > ACP_MOSS_TOOL_PREFIX.length) {
    return "moss";
  }
  return "unknown";
}

/** Tool names switched off at launch for a profile; phase 5 passes these on. */
export function launchOffList(surface: AcpProfile): string[] {
  // `unattended` has no column yet (slice 2); fail closed with everything off
  // until then. The profile gate rejects it before this is consulted.
  if (surface === "unattended") return ACP_TOOL_TABLE.map((row) => row.name);
  return ACP_TOOL_TABLE.filter((row) => !row[surface]).map((row) => row.name);
}

/** Names in the given families, for card seriousness and launch agreement. */
export function acpToolNamesIn(...families: readonly AcpToolFamily[]): Set<string> {
  return new Set(
    ACP_TOOL_TABLE.filter((row) => families.includes(row.family)).map((row) => row.name)
  );
}
