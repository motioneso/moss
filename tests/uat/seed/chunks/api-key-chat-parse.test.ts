import { describe, expect, it } from "vitest";

import { parseApiKeyChatSeed } from "./api-key-chat.js";

const KEY = "ada-uat-key-0001";
const FULL = {
  MOSS_UAT_API_KEY_CHAT_KIND: "openai-compatible",
  MOSS_UAT_API_KEY_CHAT_BASE_URL: "http://proxy.test",
  MOSS_UAT_API_KEY_CHAT_MODEL: "ada-model",
  MOSS_UAT_API_KEY_CHAT_KEY: KEY
};

describe("parseApiKeyChatSeed (#3410)", () => {
  it("is off when every value is empty, as the seed hook sends them", () => {
    expect(
      parseApiKeyChatSeed({
        MOSS_UAT_API_KEY_CHAT_KIND: "",
        MOSS_UAT_API_KEY_CHAT_BASE_URL: "",
        MOSS_UAT_API_KEY_CHAT_MODEL: "",
        MOSS_UAT_API_KEY_CHAT_KEY: ""
      })
    ).toBeUndefined();
  });

  it("returns the seed when all four are set", () => {
    expect(parseApiKeyChatSeed(FULL)).toEqual({
      providerKind: "openai-compatible",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      apiKey: KEY
    });
  });

  it("refuses a partial set without echoing any value", () => {
    let message = "";
    try {
      parseApiKeyChatSeed({ ...FULL, MOSS_UAT_API_KEY_CHAT_MODEL: "" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/together/);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("http://proxy.test");
  });

  it("refuses a kind chat cannot drive", () => {
    expect(() => parseApiKeyChatSeed({ ...FULL, MOSS_UAT_API_KEY_CHAT_KIND: "google" })).toThrow(
      /anthropic or openai-compatible/
    );
  });
});
