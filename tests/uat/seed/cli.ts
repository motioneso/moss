import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { persistProviderToken } from "@moss/cli-runner";
import { resolveMossEnv } from "@moss/db";
import { createMigrationOwnerDb } from "./connections.js";
import { assertTargetIsEphemeral } from "./guard.js";
import {
  parseUatChatScript,
  parseUatExcludeChunks,
  parseUatSeedLevel
} from "./level-validation.js";
import { seedLevel } from "./levels.js";

// #1121: same fallback chain packages/cli-runner/src/main.ts uses for the cli-auth mount —
// seed's compose block doesn't set JARVIS_CLI_HOME_BASE/JARVIS_CLI_HOME explicitly, so this
// must match jarv1s's default exactly or a persisted token would land somewhere jarv1s never
// reads.
const DEFAULT_CLI_HOME_BASE = "/data/cli-auth";

/**
 * #1121 (Coordinator constraint 1, opt-in only): if the `seed` service's opt-in real-chat env
 * file (infra/docker-compose.prod.yml + tests/uat/real-chat-env.ts's writeUatRealChatEnvFile)
 * populated CLAUDE_CODE_OAUTH_TOKEN, persist it into the shared cli-auth volume so jarv1s's chat
 * launch can read it back via readProviderCredentialEnv. Absent env var ⇒ no-op — default/CI
 * seed behavior is unchanged. Never logs the token.
 */
export async function maybePersistRealChatToken(
  homeBase = resolveMossEnv(process.env, "JARVIS_CLI_HOME_BASE") ??
    resolveMossEnv(process.env, "JARVIS_CLI_HOME") ??
    DEFAULT_CLI_HOME_BASE
): Promise<void> {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    return;
  }
  await persistProviderToken(homeBase, "anthropic", token);
}

/**
 * #1025: entrypoint for the new `seed` ops-profile compose service (see
 * infra/docker-compose.prod.yml) — runs inside the compose network since
 * postgres publishes no host port, so this can never be invoked as a plain
 * host-side script (see plan's "Architecture decisions" section).
 */
async function main(): Promise<void> {
  // #1025/#1000 (Coordinator ruling, binding): hard-refuse unless the caller
  // proves this is the ephemeral UAT compose stack. composeSeedHook is the
  // ONLY caller that sets this token (Task 7 Step 3) — a real prod deploy
  // never does, so a stray `docker compose --profile ops run seed` against a
  // prod-shaped stack fails closed instead of seeding fixture data into it.
  if (process.env.JARVIS_UAT_SEED_CONFIRM !== "1") {
    throw new Error(
      "[uat-seed] refusing to run: JARVIS_UAT_SEED_CONFIRM=1 not set — this entrypoint only runs " +
        "inside the ephemeral UAT compose stack (see tests/uat/provisioner.ts composeSeedHook)"
    );
  }

  // #1082: the env token is necessary-not-sufficient. Inspect the target itself
  // before any fixture write so an exported token cannot turn this CLI into a
  // production bootstrap-owner backdoor.
  const db = createMigrationOwnerDb();
  try {
    await assertTargetIsEphemeral(db);
  } finally {
    await db.destroy();
  }

  // #1121: strictly after the ephemeral-target guard above, never before — opt-in, no-op
  // unless the seed service's own env_file entry populated the token.
  await maybePersistRealChatToken();

  // #1087 finding 5: fail closed on an unrecognized level/chunk name rather than
  // silently falling through — a typo like "solo_admin" used to cast clean and
  // seed FULL admin+data (max data, exit 0). Runs after the #1082 ephemeral-target
  // guard above (never reorder/remove that guard); wasting its DB round-trip on a
  // request we're about to reject anyway is an acceptable cost for keeping the
  // guard first.
  const level = parseUatSeedLevel(process.env.JARVIS_UAT_SEED_LEVEL ?? "bare");
  const excludeChunks = parseUatExcludeChunks(process.env.JARVIS_UAT_SEED_EXCLUDE_CHUNKS ?? "");
  const withoutNewsJsonBinding =
    resolveMossEnv(process.env, "JARVIS_UAT_WITHOUT_NEWS_JSON_BINDING") === "1";
  // N42/#57: empty string (unset — composeSeedHook always passes the var) reads as absent, same
  // as every other optional docker -e value here.
  const jobSearchAiProviderBaseUrl =
    resolveMossEnv(process.env, "JARVIS_UAT_JOB_SEARCH_AI_BASE_URL") || undefined;
  const sportsPublicSourceFixtures =
    resolveMossEnv(process.env, "JARVIS_UAT_SPORTS_PUBLIC_SOURCE_FIXTURES") === "1";
  const chatScript = parseUatChatScript(
    resolveMossEnv(process.env, "JARVIS_UAT_SEED_CHAT_SCRIPT") ?? ""
  );

  await seedLevel({
    level,
    excludeChunks,
    withoutNewsJsonBinding,
    jobSearchAiProviderBaseUrl,
    sportsPublicSourceFixtures,
    chatScript
  });
  console.log(
    `[uat-seed] seeded level "${level}"${excludeChunks.length ? ` (excluding: ${excludeChunks.join(", ")})` : ""}`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error("[uat-seed] failed:", error);
    process.exitCode = 1;
  });
}
