/**
 * The outside-agent catalog for the per-surface agent settings (#2369 slice 1
 * phase 5). Display data only: the enforcement stays at adapter start
 * (`checkAgentCapabilities` in `@moss/acp`), which fails closed. An agent is
 * listed for a surface only when it passes that surface's capability row, so
 * adding a row here without a passing gate would offer a dead choice.
 */

export type AcpAgentSurface = "workshop" | "chat";

export interface AcpKnownAgent {
  readonly id: string;
  /** Label shown in the Assistant and AI admin pane. */
  readonly label: string;
  /** Surfaces whose capability row this agent passes. */
  readonly surfaces: readonly AcpAgentSurface[];
  /**
   * One sentence shown beside the choice when the agent needs it, or null
   * when there is nothing to say. CLI-backed agents share one household login.
   */
  readonly loginNote: string | null;
}

/** Today's answering engine. Always offered; never an outside agent. */
export const ACP_AGENT_DEFAULT = "default";
/** Claude Code reached through the ACP adapter. Passes the Workshop row only. */
export const ACP_AGENT_CLAUDE_CODE = "claude-code-acp";

export const ACP_KNOWN_AGENTS: readonly AcpKnownAgent[] = [
  {
    id: ACP_AGENT_CLAUDE_CODE,
    label: "Claude Code (outside agent)",
    surfaces: ["workshop"],
    loginNote: "Uses the household's shared Claude login."
  }
];

/** Outside agents offered for a surface, in display order. */
export function agentsForSurface(surface: AcpAgentSurface): readonly AcpKnownAgent[] {
  return ACP_KNOWN_AGENTS.filter((agent) => agent.surfaces.includes(surface));
}

/** True for values the admin may store in `workshop.agent` / `chat.agent`. */
export function isKnownAcpAgentId(value: unknown): boolean {
  return value === ACP_AGENT_DEFAULT || ACP_KNOWN_AGENTS.some((agent) => agent.id === value);
}
