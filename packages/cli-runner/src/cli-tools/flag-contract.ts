/**
 * #2689: every command-line flag Moss passes to a provider CLI, grouped by the subcommand that
 * receives it (spec 2026-09-25 section 5.1).
 *
 * The publisher runs each surface's help and blocks a toolset when a flag is gone. The engines
 * build their command lines as shell strings inside private methods, so this list is declared
 * here. `tests/unit/cli-tools-flag-contract.test.ts` scans the engine sources and fails when they
 * pass a flag this list does not name, so the two cannot drift apart.
 */

import type { CliToolsetId } from "./toolsets.js";

export interface CliFlagSurface {
  /** Human label for reports, e.g. "codex exec resume". */
  readonly label: string;
  /** Arguments placed before `--help`, e.g. ["exec", "resume"]. */
  readonly subcommand: readonly string[];
  /** Long and short flags that must appear in this surface's help. */
  readonly flags: readonly string[];
  /** Subcommands that must appear in this surface's help. */
  readonly commands?: readonly string[];
  /**
   * Flags the CLI accepts but leaves out of its help. Each is proven by running the probe
   * argv (flag included) and checking the CLI did not reject it as unknown.
   */
  readonly hiddenFlagProbes?: readonly {
    readonly flag: string;
    readonly argv: readonly string[];
  }[];
}

export interface CliFlagContract {
  readonly toolset: CliToolsetId;
  readonly surfaces: readonly CliFlagSurface[];
}

export const CLI_FLAG_CONTRACTS: readonly CliFlagContract[] = Object.freeze([
  {
    toolset: "anthropic",
    surfaces: [
      {
        // structured-claude-engine.ts, claude-persistent-runtime.ts, module-build-launch-commands.ts,
        // provider-probe.ts; setup-token is the login command (login-adapters.ts).
        label: "claude",
        subcommand: [],
        flags: [
          "-p",
          "--print",
          "--session-id",
          "--resume",
          "--permission-mode",
          "--mcp-config",
          "--settings",
          "--allowedTools",
          "--disallowedTools",
          "--tools",
          "--strict-mcp-config",
          "--model",
          "--input-format",
          "--output-format",
          "--include-partial-messages",
          "--verbose",
          "--no-session-persistence",
          "--json-schema"
        ],
        commands: ["setup-token"],
        hiddenFlagProbes: [
          {
            flag: "--append-system-prompt-file",
            argv: ["-p", "--append-system-prompt-file", "/nonexistent/moss-contract-probe"]
          }
        ]
      }
    ]
  },
  {
    toolset: "openai-compatible",
    surfaces: [
      {
        // Interactive launch (module-build-launch-commands.ts) and the login commands.
        label: "codex",
        subcommand: [],
        flags: ["-c", "--disable", "--sandbox", "--model", "-a"],
        commands: ["exec", "login"]
      },
      {
        // codex-persistent-runtime.ts first turn, module-build-codex-exec-session.ts.
        label: "codex exec",
        subcommand: ["exec"],
        flags: ["--json", "-c", "--model", "--skip-git-repo-check", "--disable", "--sandbox"],
        commands: ["resume"]
      },
      {
        // codex-persistent-runtime.ts later turns.
        label: "codex exec resume",
        subcommand: ["exec", "resume"],
        flags: [
          "--last",
          "--json",
          "-c",
          "--model",
          "--skip-git-repo-check",
          "--disable",
          "--sandbox"
        ]
      },
      {
        // login-adapters.ts and provider-probe.ts.
        label: "codex login",
        subcommand: ["login"],
        flags: ["--device-auth"],
        commands: ["status"]
      }
    ]
  },
  {
    toolset: "google",
    surfaces: [
      {
        // structured-gemini-engine.ts, module-build-launch-commands.ts, provider-probe.ts.
        label: "gemini",
        subcommand: [],
        flags: [
          "-p",
          "--prompt",
          "-o",
          "--output-format",
          "--approval-mode",
          "--skip-trust",
          "--session-id",
          "--resume",
          "--model"
        ]
      }
    ]
  }
]);

/** Output that means a CLI rejected a flag it does not know. */
export const UNKNOWN_FLAG_RE = /unknown option|unexpected argument|unknown argument/i;

/** True when `flag` appears as an option in help text (`--flag`, `-f,` or `-f `). */
export function helpMentionsFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,\\[(])${escaped}(?=$|[\\s,=\\])<])`, "m").test(help);
}

/** True when `command` appears as a subcommand line in help text. */
export function helpMentionsCommand(help: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s+${escaped}(\\s|$)`, "m").test(help);
}
