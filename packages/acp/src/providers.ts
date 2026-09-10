/**
 * One adapter row per provider kind (spec section 9, slice 1 task 2).
 *
 * Providers share the protocol but differ in login, model selection and which
 * built-ins can be switched off. A provider is offered for a profile only when
 * its row says so; "any provider works everywhere" is false. Launch commands
 * come from the public registry; Moss pins versions and bumps them on purpose,
 * never at run time. The launch text here is the record of what task 3
 * resolves and spawns; nothing in this package launches anything yet.
 */

import { launchOffList } from "./tool-table.js";

export type AcpProviderKind = "anthropic" | "openai" | "google" | "opencode";

export interface AcpProviderRow {
  readonly kind: AcpProviderKind;
  /** Registry agent id, e.g. `claude-acp`. */
  readonly agent: string;
  /** Pinned registry entry the launch command uses. */
  readonly registry: string;
  /** How the agent is launched (registry entry, run without a shell). */
  readonly launch: string;
  /** How login works for this provider. */
  readonly login: string;
  /** How the model choice reaches the agent. */
  readonly model: string;
  /** How the agent's own shell and file writes are switched off. */
  readonly offList: string;
  /** Offered for the chat profile in slice 1. */
  readonly chatReady: boolean;
  /** Why not, when `chatReady` is false. */
  readonly chatBlockReason?: string;
}

const ROWS: readonly AcpProviderRow[] = [
  {
    kind: "anthropic",
    agent: "claude-acp",
    registry: "@agentclientprotocol/claude-agent-acp@0.75.1",
    launch: "npx @agentclientprotocol/claude-agent-acp@0.75.1",
    login: "runner token store, CLAUDE_CODE_OAUTH_TOKEN in env",
    model: "configOptions model, set with session/set_config_option",
    offList: "_meta disallowed-tools list, confirmed in source",
    chatReady: true
  },
  {
    kind: "openai",
    agent: "codex-acp",
    registry: "@agentclientprotocol/codex-acp@1.10.0",
    launch: "npx @agentclientprotocol/codex-acp@1.10.0",
    login: "runner-owned login is copied into this user's isolated agent home before launch",
    model: "CODEX_CONFIG JSON at launch; configOptions model where advertised",
    offList: "INITIAL_AGENT_MODE=read-only",
    chatReady: true
  },
  {
    kind: "google",
    agent: "antigravity-acp",
    registry: "antigravity-acp (binary from the registry)",
    launch: "antigravity-acp binary from the registry",
    login:
      "no: session/new answers Authentication required even with the Google CLI logged in; it wants its own login over the protocol",
    model: "to verify (configOptions model)",
    offList: "no known switch; Workshop-only until one is found",
    chatReady: false,
    chatBlockReason:
      "the Google provider needs its own login over the protocol before it is offered anywhere (slice 2)"
  },
  {
    kind: "opencode",
    agent: "opencode",
    registry: "opencode@1.18.29",
    launch: "opencode acp (binary 1.18.29, the version Scout ran 2026-09-07)",
    login:
      "reads its own config file; account login reuse untested, no account logged in on the box",
    model: "session/set_config_option (switched to Muse Spark 1.3 free live, 2026-09-07)",
    offList:
      "settings file in the agent home with shell and file edits denied, written at spawn for chat",
    chatReady: true
  }
];

/** Row lookup by provider kind; throws on an unknown kind. */
export function getAcpProviderRow(kind: AcpProviderKind): AcpProviderRow {
  const row = ROWS.find((candidate) => candidate.kind === kind);
  if (!row) throw new Error(`Unknown ACP provider kind: ${kind}`);
  return row;
}

/**
 * OpenCode permission keys the chat profile denies, derived from the tool
 * table so launch and policy cannot drift: every shell or write row switched
 * off for chat contributes its tool name, and only names OpenCode actually
 * has are kept (it has no KillShell, MultiEdit or NotebookEdit).
 */
const OPENCODE_KNOWN_PERMISSION_KEYS = new Set(["bash", "edit", "write"]);

export function opencodeDenyPermissionKeys(): string[] {
  const keys = new Set<string>();
  for (const name of launchOffList("chat")) {
    const base = name.startsWith("mcp__acp__") ? name.slice("mcp__acp__".length) : name;
    const key = base.toLowerCase();
    if (OPENCODE_KNOWN_PERMISSION_KEYS.has(key)) keys.add(key);
  }
  return [...keys].sort();
}

/** All four rows, for the row-lookup test and future settings use. */
export function listAcpProviderRows(): readonly AcpProviderRow[] {
  return ROWS;
}
