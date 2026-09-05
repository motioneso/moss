import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("truthful chat settings UI", () => {
  it("does not expose fake chat controls and folds response style into Assistant & AI", () => {
    const subviewsSource = readFileSync(
      "apps/web/src/settings/settings-module-subviews.tsx",
      "utf8"
    );
    const aiSource = readFileSync("apps/web/src/settings/settings-ai-pane.tsx", "utf8");

    expect(subviewsSource).not.toContain("ChatSettingsView");
    expect(aiSource).not.toContain("Chat settings aren't saved or applied yet.");
    expect(aiSource).not.toContain("Stream responses");
    expect(aiSource).not.toContain("Suggested actions");
    expect(aiSource).not.toContain("Remember across conversations");
    expect(aiSource).toContain("Response style");
    expect(aiSource).not.toContain("Coming soon");
  });

  it("uses the real chat settings API client", () => {
    const client = readFileSync("apps/web/src/api/client.ts", "utf8");
    const queryKeys = readFileSync("apps/web/src/api/query-keys.ts", "utf8");

    expect(client).toContain("getChatSettings");
    expect(client).toContain("putChatSettings");
    expect(client).toContain("/api/chat/settings");
    expect(queryKeys).toContain('settings: ["chat", "settings"] as const');
  });
});
