import { describe, expect, it } from "vitest";
import { dataContextBrand } from "@moss/db";
import {
  ACP_AGENT_CLAUDE_CODE,
  ACP_AGENT_DEFAULT,
  agentsForSurface,
  isKnownAcpAgentId
} from "@moss/shared";
import {
  readChatAgentSetting,
  readWorkshopAgentSetting
} from "../packages/settings/src/agent-settings.js";

/** A scoped db whose instance-settings lookup returns one canned row. */
function scopedDbWithSetting(value: unknown) {
  return {
    [dataContextBrand]: true as const,
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => (value === undefined ? undefined : { value: { value } })
          })
        })
      })
    }
  };
}

describe("outside-agent catalog", () => {
  it("offers Claude Code on the Workshop surface only", () => {
    const ids = agentsForSurface("workshop").map((agent) => agent.id);
    expect(ids).toContain(ACP_AGENT_CLAUDE_CODE);
    expect(agentsForSurface("chat")).toHaveLength(0);
  });

  it("shows the shared-login sentence beside the CLI-backed agent", () => {
    for (const agent of agentsForSurface("workshop")) {
      expect(agent.loginNote).toMatch(/shared/i);
    }
  });

  it("accepts only the default engine and catalog ids as stored values", () => {
    expect(isKnownAcpAgentId(ACP_AGENT_DEFAULT)).toBe(true);
    expect(isKnownAcpAgentId(ACP_AGENT_CLAUDE_CODE)).toBe(true);
    expect(isKnownAcpAgentId("gemini-cli")).toBe(false);
    expect(isKnownAcpAgentId("")).toBe(false);
    expect(isKnownAcpAgentId(undefined)).toBe(false);
  });
});

describe("agent setting reads", () => {
  it("reads the stored Workshop agent id", async () => {
    const db = scopedDbWithSetting(ACP_AGENT_CLAUDE_CODE);
    await expect(readWorkshopAgentSetting(db as never)).resolves.toBe(ACP_AGENT_CLAUDE_CODE);
  });

  it("falls back to the default engine when unset, empty, or unknown", async () => {
    for (const value of [undefined, "", "gemini-cli", 42]) {
      const db = scopedDbWithSetting(value);
      await expect(readWorkshopAgentSetting(db as never)).resolves.toBe(ACP_AGENT_DEFAULT);
      await expect(readChatAgentSetting(db as never)).resolves.toBe(ACP_AGENT_DEFAULT);
    }
  });
});
