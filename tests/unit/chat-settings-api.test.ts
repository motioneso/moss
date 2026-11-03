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
      responseStyle: "concise",
      frontDoorGuardedDevices: false,
      frontDoorDisabled: false
    });
    expect(normalizeChatSettings({ responseStyle: "detailed" })).toEqual({
      responseStyle: "detailed",
      frontDoorGuardedDevices: false,
      frontDoorDisabled: false
    });
  });

  it("drops a legacy OpenCode model value saved by an older version", () => {
    expect(
      normalizeChatSettings({ responseStyle: "balanced", openCodeModel: "muse-spark-1.3-free" })
    ).toEqual({
      responseStyle: "balanced",
      frontDoorGuardedDevices: false,
      frontDoorDisabled: false
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

  it("keeps the personal off switch even when the response style is damaged", () => {
    expect(
      normalizeChatSettings({ responseStyle: "x", frontDoorDisabled: true }).frontDoorDisabled
    ).toBe(true);
    expect(
      normalizeChatSettings({ responseStyle: "concise", frontDoorDisabled: "yes" })
        .frontDoorDisabled
    ).toBe(false);
  });

  it("keeps the front-door switch only when it is exactly true", () => {
    expect(
      normalizeChatSettings({ responseStyle: "balanced", frontDoorGuardedDevices: true })
    ).toEqual({
      responseStyle: "balanced",
      frontDoorGuardedDevices: true,
      frontDoorDisabled: false
    });
    expect(
      normalizeChatSettings({ responseStyle: "balanced", frontDoorGuardedDevices: "yes" })
        .frontDoorGuardedDevices
    ).toBe(false);
  });
});
