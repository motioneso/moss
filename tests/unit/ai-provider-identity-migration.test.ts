import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { aiModuleManifest } from "../../packages/ai/src/manifest.js";

const migration = readFileSync(
  new URL("../../packages/ai/sql/0244_ai_provider_acp_agent_id.sql", import.meta.url),
  "utf8"
);

describe("AI provider ACP identity migration", () => {
  it("registers the additive migration", () => {
    expect(aiModuleManifest.database.migrations).toContain("sql/0244_ai_provider_acp_agent_id.sql");
  });

  it("backfills known CLI identities and retains other legacy CLI rows unresolved", () => {
    expect(migration).toMatch(/WHEN 'anthropic' THEN 'claude-acp'/);
    expect(migration).toMatch(/WHEN 'openai-compatible' THEN 'codex-acp'/);
    expect(migration).toMatch(/WHEN 'google' THEN 'antigravity-acp'/);
    expect(migration).toMatch(/ELSE NULL\s+END\s+WHERE auth_method = 'cli'/);

    // The data update only changes the new identity column, preserving legacy credentials/models.
    const backfill = migration.match(/UPDATE app\.ai_provider_configs[\s\S]*?;/)?.[0];
    expect(backfill).toContain("SET acp_agent_id = CASE provider_kind");
    expect(backfill).not.toMatch(/encrypted_credential|ai_configured_models/);
  });

  it("allows an unsupported legacy CLI row with no identity while requiring supported CLI identities", () => {
    expect(migration).toMatch(
      /provider_kind IN \('anthropic', 'openai-compatible', 'google'\) AND acp_agent_id IS NOT NULL/
    );
    expect(migration).toMatch(
      /provider_kind NOT IN \('anthropic', 'openai-compatible', 'google'\) AND acp_agent_id IS NULL/
    );
  });
});
