import { describe, expect, it } from "vitest";

import {
  CHAT_SETTINGS_PREFERENCE_KEY,
  DEFAULT_CHAT_SETTINGS,
  normalizeChatSettings,
  renderChatResponseStyleInstruction
} from "@moss/shared";

describe("chat settings api", () => {
  it("normalizes missing and malformed settings to balanced", () => {
    expect(normalizeChatSettings(null)).toEqual(DEFAULT_CHAT_SETTINGS);
    expect(normalizeChatSettings({ responseStyle: "fast" })).toEqual(DEFAULT_CHAT_SETTINGS);
  });

  it("accepts supported response styles only", () => {
    expect(normalizeChatSettings({ responseStyle: "concise" })).toEqual({
      responseStyle: "concise"
    });
    expect(normalizeChatSettings({ responseStyle: "detailed" })).toEqual({
      responseStyle: "detailed"
    });
  });

  it("keeps the saved OpenCode ACP model with chat settings", () => {
    expect(
      normalizeChatSettings({ responseStyle: "balanced", openCodeModel: "muse-spark-1.3-free" })
    ).toEqual({ responseStyle: "balanced", openCodeModel: "muse-spark-1.3-free" });
    expect(normalizeChatSettings({ responseStyle: "balanced", openCodeModel: "other" })).toEqual({
      responseStyle: "balanced"
    });
  });

  it("exports a shared preference key", () => {
    expect(CHAT_SETTINGS_PREFERENCE_KEY).toBe("chat.settings.v1");
  });

  it("renders runtime prompt instruction for saved style", () => {
    expect(renderChatResponseStyleInstruction("concise")).toContain("concise");
    expect(renderChatResponseStyleInstruction("balanced")).toContain("balanced");
    expect(renderChatResponseStyleInstruction("detailed")).toBe(
      "Default response style: detailed. Include useful context, reasoning, and next steps."
    );
  });
});
