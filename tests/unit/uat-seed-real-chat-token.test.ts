/**
 * #1121: tests/uat/seed/cli.ts's opt-in step — when the compose `seed` service receives
 * CLAUDE_CODE_OAUTH_TOKEN (only ever via its own opt-in env_file entry, see
 * infra/docker-compose.prod.yml + tests/uat/real-chat-env.ts's writeUatRealChatEnvFile), it
 * persists that token into the shared cli-auth volume so jarv1s's chat launch can read it back.
 * Absent env var ⇒ no-op, default/CI seed behavior unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProviderToken } from "../../packages/cli-runner/src/provider-token-store.js";
import { maybePersistRealChatToken } from "../../tests/uat/seed/cli.js";

describe("maybePersistRealChatToken", () => {
  const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  let homeBase: string;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
    rmSync(homeBase, { force: true, recursive: true });
  });

  it("is a no-op when CLAUDE_CODE_OAUTH_TOKEN is unset", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    homeBase = mkdtempSync(join(tmpdir(), "jarv1s-uat-seed-token-"));
    await maybePersistRealChatToken(homeBase);
    await expect(readProviderToken(homeBase, "anthropic")).resolves.toBeUndefined();
  });

  it("persists the token when CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "uat-synthetic-not-real";
    homeBase = mkdtempSync(join(tmpdir(), "jarv1s-uat-seed-token-"));
    await maybePersistRealChatToken(homeBase);
    await expect(readProviderToken(homeBase, "anthropic")).resolves.toBe("uat-synthetic-not-real");
  });
});
