/**
 * provider-first-run (#342 chat) — seed a provider CLI's FIRST-RUN state in the cli-auth
 * volume so the interactive chat REPL launches ready-to-chat instead of stopping on its
 * onboarding wizard.
 *
 * claude (anthropic): a fresh `~/.claude.json` makes the `claude` TUI run its first-run flow
 * — login-method selection (which blocks even with a valid CLAUDE_CODE_OAUTH_TOKEN), theme,
 * and a per-folder trust dialog — none of which the engine drives, so the chat turn times out.
 * Seeding `hasCompletedOnboarding`/theme (global) + `hasTrustDialogAccepted` (per working dir)
 * mirrors a completed first-run, so the token-authenticated REPL goes straight to the prompt.
 *
 * codex (openai-compatible): on first launch in a working dir codex prompts
 * `Do you trust the contents of this directory?`, which the engine cannot drive and which
 * blocks the chat turn. Pre-trusting the neutral chat dir in `~/.codex/config.toml`
 * (`[projects."<dir>"] trust_level = "trusted"`) skips the prompt. The installer already
 * wrote `check_for_update_on_startup = false` there; the trust writer preserves it.
 *
 * Per-provider by nature — dispatched from {@link ensureProviderLaunchReady}.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderKind } from "@moss/ai";

const CLAUDE_CONFIG = ".claude.json";
const GEMINI_CONFIG_DIR = ".gemini";
const GEMINI_CONFIG = path.join(GEMINI_CONFIG_DIR, "settings.json");
const CODEX_CONFIG_DIR = ".codex";
const CODEX_CONFIG = path.join(CODEX_CONFIG_DIR, "config.toml");

type ClaudeConfig = Record<string, unknown> & {
  projects?: Record<string, Record<string, unknown>>;
};

async function readClaudeConfig(homeBase: string): Promise<ClaudeConfig> {
  try {
    return JSON.parse(await readFile(path.join(homeBase, CLAUDE_CONFIG), "utf8")) as ClaudeConfig;
  } catch {
    return {};
  }
}

async function writeClaudeConfig(homeBase: string, cfg: ClaudeConfig): Promise<void> {
  await mkdir(homeBase, { recursive: true });
  await writeFile(path.join(homeBase, CLAUDE_CONFIG), JSON.stringify(cfg, null, 2), {
    mode: 0o600
  });
}

/**
 * Mark claude's global first-run as complete so the REPL skips the login-method + theme prompts.
 * Idempotent; preserves every other key claude maintains. Safe pre-launch (claude is not running
 * for this session yet, and the §4.1.0a gate serializes launches).
 */
export async function ensureClaudeOnboarded(homeBase: string): Promise<void> {
  const cfg = await readClaudeConfig(homeBase);
  let changed = false;
  if (cfg.hasCompletedOnboarding !== true) {
    cfg.hasCompletedOnboarding = true;
    changed = true;
  }
  if (cfg.bypassPermissionsModeAccepted !== true) {
    cfg.bypassPermissionsModeAccepted = true;
    changed = true;
  }
  if (cfg.theme === undefined) {
    cfg.theme = "dark";
    changed = true;
  }
  if (changed) await writeClaudeConfig(homeBase, cfg);
}

/** Pre-trust a session's working dir so claude's REPL skips the per-folder trust dialog. */
export async function trustClaudeProject(homeBase: string, dir: string): Promise<void> {
  const cfg = await readClaudeConfig(homeBase);
  const projects = (cfg.projects ??= {});
  const proj = (projects[dir] ??= {});
  if (proj.hasTrustDialogAccepted !== true) {
    proj.hasTrustDialogAccepted = true;
    await writeClaudeConfig(homeBase, cfg);
  }
}

/**
 * Pre-trust a session's working dir so codex's REPL skips its directory-trust prompt. Writes a
 * `[projects."<dir>"]` section with `trust_level = "trusted"` into `~/.codex/config.toml`.
 *
 * Narrow line-based appender (no full TOML parser dep): reads the existing config (the installer
 * wrote `check_for_update_on_startup = false`), appends the project section only when this dir's
 * section is absent, and never duplicates an existing section. Idempotent. Parent dirs are created
 * `0700`; the config is written `0600`.
 */
export async function trustCodexProject(homeBase: string, dir: string): Promise<void> {
  const configPath = path.join(homeBase, CODEX_CONFIG);
  let existing = "";
  try {
    existing = await readFile(configPath, "utf8");
  } catch {
    // missing config — the installer may not have run yet; we still seed trust.
  }

  const sectionHeader = `[projects.${JSON.stringify(dir)}]`;
  // Idempotency: a section for this exact dir already exists → no-op.
  if (existing.includes(sectionHeader)) return;

  const lines = existing.split("\n");
  // Trim a trailing blank line so the appended section is tight.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();

  const section = `${sectionHeader}\ntrust_level = "trusted"\n`;
  const merged = lines.length > 0 ? `${lines.join("\n")}\n${section}` : section;

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, merged, { encoding: "utf8", mode: 0o600 });
}

/**
 * (#2027) Answer gemini's sign-in-method question ahead of time, so the login flow reaches the
 * "visit this URL" step instead of stopping on a menu nothing drives.
 *
 * The tool only asks which sign-in method to use when `security.auth.selectedType` is unset;
 * seeding it to `oauth-personal` skips the question. Deliberately seeds nothing else: the tool
 * only objects to a theme that is set and unknown, and sign-in happens before the main screen is
 * drawn, so a seeded theme would be a value to keep correct across upgrades for no benefit.
 *
 * MERGE, NEVER OVERWRITE. The #2026 installer owns two keys in this SAME file
 * (`general.enableAutoUpdate` / `general.enableAutoUpdateNotification`) that stop the tool
 * replacing its own pinned bytes. A whole-file write here would silently undo that. Idempotent:
 * a no-op once the value is already right. Dir `0700`, file `0600`.
 */
export async function ensureGeminiOnboarded(homeBase: string): Promise<void> {
  const configPath = path.join(homeBase, GEMINI_CONFIG);
  let cfg: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    // Only an object is mergeable; anything else (array, scalar, corrupt) starts fresh rather
    // than throwing on the login path.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      cfg = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or unparseable config — the installer may not have run yet; seed from scratch.
  }

  const existingSecurity = cfg.security;
  const security: Record<string, unknown> =
    existingSecurity !== null &&
    typeof existingSecurity === "object" &&
    !Array.isArray(existingSecurity)
      ? { ...(existingSecurity as Record<string, unknown>) }
      : {};
  const existingAuth = security.auth;
  const auth: Record<string, unknown> =
    existingAuth !== null && typeof existingAuth === "object" && !Array.isArray(existingAuth)
      ? { ...(existingAuth as Record<string, unknown>) }
      : {};

  // Never overwrite a method the user (or a future step) already chose.
  if (auth.selectedType !== undefined && auth.selectedType !== null) return;
  auth.selectedType = "oauth-personal";
  security.auth = auth;
  cfg.security = security;

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

/**
 * Seed whatever first-run state a provider's CLI needs before the engine launches it in `dir`.
 * Generic entry point called on every launch; per-provider specifics live here. gemini needs its
 * sign-in-method question answered (#2027) but no per-folder trust — the tool asks about folder
 * trust only after sign-in, on a screen the engine does not reach here.
 */
export async function ensureProviderLaunchReady(
  homeBase: string,
  provider: ProviderKind,
  dir: string
): Promise<void> {
  if (provider === "anthropic") {
    await ensureClaudeOnboarded(homeBase);
    await trustClaudeProject(homeBase, dir);
  } else if (provider === "openai-compatible") {
    await trustCodexProject(homeBase, dir);
  } else if (provider === "google") {
    await ensureGeminiOnboarded(homeBase);
  }
}
