import { describe, expect, it } from "vitest";

import {
  API_KEY_CHAT_UAT_ENV,
  apiKeyChatSeedArgs,
  apiKeyChatSeedProcessEnv,
  apiKeyChatUatConfigured,
  readApiKeyChatUatProvider
} from "./api-key-chat-env.js";

const KEY = "ada-uat-key-0001";
const FULL = {
  [API_KEY_CHAT_UAT_ENV.kind]: "openai-compatible",
  [API_KEY_CHAT_UAT_ENV.baseUrl]: "http://proxy.test",
  [API_KEY_CHAT_UAT_ENV.model]: "ada-model",
  [API_KEY_CHAT_UAT_ENV.keyFile]: "/tmp/ada-uat-key"
};
const readKey = async () => `${KEY}\n`;

describe("API-key chat UAT settings (#3410)", () => {
  it("is off when none of the four variables is set", async () => {
    expect(apiKeyChatUatConfigured({})).toBe(false);
    await expect(readApiKeyChatUatProvider({}, readKey)).resolves.toBeUndefined();
  });

  it("reads all four and trims the key", async () => {
    expect(apiKeyChatUatConfigured(FULL)).toBe(true);
    await expect(readApiKeyChatUatProvider(FULL, readKey)).resolves.toEqual({
      providerKind: "openai-compatible",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      apiKey: KEY
    });
  });

  it("names the missing variables, never the values, when only some are set", async () => {
    const partial = { ...FULL, [API_KEY_CHAT_UAT_ENV.model]: "" };
    expect(apiKeyChatUatConfigured(partial)).toBe(false);

    const error = await readApiKeyChatUatProvider(partial, readKey).catch((e: unknown) => e);

    expect((error as Error).message).toContain(API_KEY_CHAT_UAT_ENV.model);
    expect((error as Error).message).not.toContain("http://proxy.test");
    expect((error as Error).message).not.toContain("/tmp/ada-uat-key");
  });

  it("refuses a kind chat cannot drive", async () => {
    await expect(
      readApiKeyChatUatProvider({ ...FULL, [API_KEY_CHAT_UAT_ENV.kind]: "google" }, readKey)
    ).rejects.toThrow(/anthropic or openai-compatible/);
  });

  it("refuses an address that is not http or https", async () => {
    await expect(
      readApiKeyChatUatProvider({ ...FULL, [API_KEY_CHAT_UAT_ENV.baseUrl]: "proxy.test" }, readKey)
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it("refuses an empty key file", async () => {
    await expect(readApiKeyChatUatProvider(FULL, async () => "\n")).rejects.toThrow(/is empty/);
  });

  it("builds seed args that carry the key by name only", () => {
    const seed = {
      providerKind: "anthropic",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      apiKey: KEY
    } as const;

    const args = apiKeyChatSeedArgs(seed);

    expect(args).toEqual([
      "-e",
      "MOSS_UAT_API_KEY_CHAT_KIND=anthropic",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_BASE_URL=http://proxy.test",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_MODEL=ada-model",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_KEY"
    ]);
    expect(apiKeyChatSeedProcessEnv(seed, {}).MOSS_UAT_API_KEY_CHAT_KEY).toBe(KEY);
  });

  it("blanks the seed key when not opted in, even if the base env has one", () => {
    expect(
      apiKeyChatSeedProcessEnv(undefined, { MOSS_UAT_API_KEY_CHAT_KEY: "stray" })
        .MOSS_UAT_API_KEY_CHAT_KEY
    ).toBe("");
    expect(apiKeyChatSeedArgs(undefined)).toContain("MOSS_UAT_API_KEY_CHAT_KIND=");
  });
});
