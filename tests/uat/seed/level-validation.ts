import { UAT_CHAT_SCRIPTS, UAT_SEED_CHUNKS, UAT_SEED_LEVELS } from "./types.js";
import type { UatChatScript, UatSeedChunk, UatSeedLevel } from "./types.js";

/**
 * #1087 finding 5: JARVIS_UAT_SEED_LEVEL / JARVIS_UAT_SEED_EXCLUDE_CHUNKS were
 * cast unvalidated (`as UatSeedLevel` / accepting any non-empty string) in
 * tests/uat/seed/cli.ts, so a typo like "solo_admin" silently fell through and
 * seeded FULL admin+data (max data, exit 0) instead of failing loudly. These
 * two pure parsers are the single fail-closed gate — both tests/uat/seed/cli.ts
 * and tests/uat/provisioner.ts's own main() call them before any DB work or
 * seeding happens. Kept in their own side-effect-free module (rather than
 * inline in cli.ts) so they're unit-testable without triggering cli.ts's
 * top-level `main().catch(...)` call.
 */
export function parseUatSeedLevel(raw: string): UatSeedLevel {
  if (!(UAT_SEED_LEVELS as readonly string[]).includes(raw)) {
    throw new Error(
      `unknown UAT seed level "${raw}" — refusing to seed (fail-closed, #1087 finding 5); ` +
        `expected one of: ${UAT_SEED_LEVELS.join(", ")}`
    );
  }
  return raw as UatSeedLevel;
}

export function parseUatExcludeChunks(raw: string): UatSeedChunk[] {
  const chunks = raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
  const invalidChunk = chunks.find(
    (chunk) => !(UAT_SEED_CHUNKS as readonly string[]).includes(chunk)
  );
  if (invalidChunk !== undefined) {
    throw new Error(
      `unknown UAT seed excludeChunks entry "${invalidChunk}" — refusing to seed (fail-closed, ` +
        `#1087 finding 5); expected one of: ${UAT_SEED_CHUNKS.join(", ")}`
    );
  }
  return chunks as UatSeedChunk[];
}

export function parseUatChatScript(raw: string): UatChatScript | undefined {
  if (raw === "") return undefined;
  if (!(UAT_CHAT_SCRIPTS as readonly string[]).includes(raw)) {
    throw new Error(
      `unknown UAT chat script "${raw}" — refusing to seed (fail-closed); ` +
        `expected one of: ${UAT_CHAT_SCRIPTS.join(", ")}`
    );
  }
  return raw as UatChatScript;
}
