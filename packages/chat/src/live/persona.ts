/**
 * Per-(actor, surface) neutral-directory + persona context-file renderer.
 *
 * The chat CLI runs in a neutral working directory OUTSIDE the repo (so it can't
 * see the codebase). This module resolves that directory — scoped by session key,
 * not just actor (#1259: a second surface's launch must not clobber the first's
 * persona file) — and writes the persona into the provider-specific context
 * filename so the CLI auto-loads it on launch — and reloads it after `/clear`.
 *
 * Filesystem I/O is injected via the small `PersonaFs` seam so this is
 * unit-testable without touching the real disk.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderKind } from "@moss/ai";
import { sanitizePersonaName } from "@moss/shared";

import { resolveChatHome } from "./chat-home.js";
import { sanitizeSessionKey } from "./cli-session-lifecycle.js";

/** Minimal filesystem seam — injected so tests can avoid real disk writes. */
export interface PersonaFs {
  /** Create a directory and any missing parents (recursive), with an optional mode. */
  mkdir(path: string, mode?: number): Promise<void>;
  /** Write file content, overwriting if it exists. */
  writeFile(path: string, content: string): Promise<void>;
}

export interface RenderPersonaInput {
  /** Surface-scoped session key (#1259) — the neutral dir is per (actorUserId, surface). */
  readonly sessionKey: string;
  readonly userName: string;
  readonly provider: ProviderKind;
  /** Override the base dir; else JARVIS_CHAT_HOME or <homedir>/.jarvis/chat. */
  readonly baseDir?: string;
  /** Persona text; any `{{userName}}` token is replaced with input.userName. */
  readonly persona: string;
}

/**
 * Sanitize a user-controlled display name before it is substituted into the
 * persona system-prompt file (#136).
 *
 * The persona text is written verbatim into the CLI's context file
 * (CLAUDE.md/AGENTS.md/GEMINI.md) and auto-loaded as system instructions, so a
 * crafted display name containing newlines or markup could inject its own
 * instructions into the persona. Collapse every control/whitespace run to a
 * single space, drop characters that could open markup/headings/emphasis, and
 * cap the length so the name can only ever be a short inline token. Falls back
 * to a neutral token if nothing printable survives.
 */
export function sanitizeUserName(rawName: string): string {
  return sanitizePersonaName(rawName);
}

/** Provider → CLI context filename auto-loaded from the working directory. */
const CONTEXT_FILENAME: Record<ProviderKind, string> = {
  anthropic: "CLAUDE.md",
  "openai-compatible": "AGENTS.md",
  google: "GEMINI.md"
};

/**
 * Ensure the user's neutral dir exists and write the persona into the
 * provider's context filename. Returns the resolved dir and file path.
 */
export async function renderPersona(
  fs: PersonaFs,
  input: RenderPersonaInput
): Promise<{ neutralDir: string; personaPath: string }> {
  const neutralDir = join(resolveChatHome(input.baseDir), sanitizeSessionKey(input.sessionKey));
  const personaPath = join(neutralDir, CONTEXT_FILENAME[input.provider]);
  const content = input.persona.replaceAll("{{userName}}", sanitizeUserName(input.userName));

  await fs.mkdir(neutralDir, 0o700);
  await fs.writeFile(personaPath, content);

  return { neutralDir, personaPath };
}

/** Real filesystem implementation backed by node:fs/promises. */
export function createRealPersonaFs(): PersonaFs {
  return {
    mkdir: async (path: string, mode?: number) => {
      await mkdir(path, { recursive: true, mode });
    },
    writeFile: async (path: string, content: string) => {
      await writeFile(path, content, "utf8");
    }
  };
}
