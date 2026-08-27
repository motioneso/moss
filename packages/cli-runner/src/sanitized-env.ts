/**
 * §7.2 cli-runner sanitized-env ALLOWLIST. The cli-runner spawns the multiplexer (and
 * through it the provider CLIs) with a CLEAN, allowlisted environment — never the
 * cli-runner SERVER's env. Everything not on the allowlist (and especially every app
 * secret, the socket path, and the RPC secret) is EXCLUDED.
 *
 * This is layer (2) of the §7.2 defense-in-depth (layer (1) is the compose service
 * getting no app env_file, owned by Lane C). Process env-stripping alone is not enough
 * because mounts are container-level — hence the sidecar — but stripping the child env
 * is still required so a CLI never sees a secret that leaked into the server env.
 */

/** Exact env keys allowed into the CLI-subprocess env (§7.2). */
const ALLOWED_KEYS: readonly string[] = [
  "HOME",
  "PATH",
  "NPM_CONFIG_PREFIX",
  // JARVIS_CLI_TOOLS_PREFIX, JARVIS_HOST_UID, JARVIS_HOST_GID are Moss-rename Tier C
  // carve-outs (docs/superpowers/specs/2026-08-06-moss-rename-tier-c-carveout.md) — never
  // renamed to MOSS_*, so only the JARVIS_ spelling is allowlisted for them.
  "JARVIS_CLI_TOOLS_PREFIX",
  // JARVIS_CLI_HOME / _HOME_BASE and JARVIS_CLI_NEUTRAL_BASE are in scope for the #1443
  // dual-read shim. This filter is a plain passthrough (not a resolver, R6 above), so both
  // spellings are allowlisted here — whichever one the cli-runner server process actually
  // has set is the one that reaches the child.
  "JARVIS_CLI_HOME",
  "MOSS_CLI_HOME",
  "JARVIS_CLI_HOME_BASE",
  "MOSS_CLI_HOME_BASE",
  "JARVIS_CLI_NEUTRAL_BASE",
  "MOSS_CLI_NEUTRAL_BASE",
  "JARVIS_HOST_UID",
  "JARVIS_HOST_GID",
  "TERM",
  "LANG",
  "TMPDIR",
  // §A.3.7 self-update-disable (NAMED non-secret control, not a wildcard): the
  // anthropic/claude recipe's kind:"env" selfUpdateDisable key. MUST equal
  // PROVIDER_CATALOG.anthropic.recipe.selfUpdateDisable.key ("DISABLE_AUTOUPDATER").
  // Allowlisting alone is a NO-OP (this builder is a passthrough FILTER, not a setter,
  // R6) — Lane A MUST boot-source `DISABLE_AUTOUPDATER=1` into the cli-runner
  // process.env in main.ts BEFORE createSanitizedTmuxIo() so this passthrough delivers
  // it to the forked tmux server + every launched CLI.
  "DISABLE_AUTOUPDATER",
  // (#2027) NO_BROWSER — a NAMED non-secret control telling gemini not to try to open a browser,
  // so it prints the authorization URL and waits for the pasted code (the only flow that works in
  // a headless container). Same R6 trap as DISABLE_AUTOUPDATER above: allowlisting the name is a
  // NO-OP on its own; buildCliRunnerChildEnv SETS the value alongside the HOME override.
  "NO_BROWSER"
];

/** Key prefixes allowed (locale basics — `LC_*`, §7.2). */
const ALLOWED_PREFIXES: readonly string[] = ["LC_"];

// The one folder tests/uat/provisioner.ts ever writes into JARVIS_UAT_SCRIPTED_PROVIDER_BIN.
// This is a value pin, not a mode flag: a marker env var (e.g. "is this a UAT run?") travels
// into a production container by the exact same conduit as the setting it would gate, so it
// authorizes nothing an attacker couldn't set themselves. Pinning to this literal path means the
// var is only ever useful for pointing at the fixture binary that already ships at this path —
// never a lever an attacker can turn to point production PATH-resolution at their own program.
const UAT_SCRIPTED_PROVIDER_BIN = "/app/tests/uat/fixtures/scripted-provider/bin";

/**
 * Build the allowlisted CLI-subprocess env from a source env (defaults to
 * `process.env`). Only the §7.2 keys/prefixes survive; every secret — including
 * JARVIS_CLI_RUNNER_SOCKET, JARVIS_CLI_RUNNER_RPC_SECRET,
 * JARVIS_CLI_RUNNER_SINGLE_USER, BETTER_AUTH_SECRET, JARVIS_AI_SECRET_KEY,
 * JARVIS_CONNECTOR_SECRET_KEY, POSTGRES_PASSWORD, every *_DATABASE_URL /
 * role password, and any JARVIS_VAULT_* — is dropped.
 */
export function buildSanitizedCliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALLOWED_KEYS.includes(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }

  // JARVIS_UAT_SCRIPTED_PROVIDER_BIN names a folder the Dockerfile puts first on PATH for every
  // login shell — the same image runs in production, so only the one fixed value the UAT
  // fixture ever needs is honored; anything else (including a real attacker-chosen path) is
  // dropped. JARVIS_UAT_SEED_CHAT_SCRIPT has no PATH effect, but only travels alongside a
  // genuine, recognized fixture-bin value for the same reason.
  if (source.JARVIS_UAT_SCRIPTED_PROVIDER_BIN === UAT_SCRIPTED_PROVIDER_BIN) {
    out.JARVIS_UAT_SCRIPTED_PROVIDER_BIN = UAT_SCRIPTED_PROVIDER_BIN;
    if (source.JARVIS_UAT_SEED_CHAT_SCRIPT !== undefined) {
      out.JARVIS_UAT_SEED_CHAT_SCRIPT = source.JARVIS_UAT_SEED_CHAT_SCRIPT;
    }
  }

  return out;
}
