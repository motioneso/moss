import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { parseApiKeyChatSeed } from "./api-key-chat.js";

const KEY = "ada-uat-key-0001";
const FULL = {
  MOSS_UAT_API_KEY_CHAT_KIND: "openai-compatible",
  MOSS_UAT_API_KEY_CHAT_BASE_URL: "http://proxy.test",
  MOSS_UAT_API_KEY_CHAT_MODEL: "ada-model",
  MOSS_UAT_API_KEY_CHAT_KEY_FILE: ""
};

describe("parseApiKeyChatSeed (#3410)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "uat-seed-key-"));
    FULL.MOSS_UAT_API_KEY_CHAT_KEY_FILE = join(dir, "key");
    await writeFile(FULL.MOSS_UAT_API_KEY_CHAT_KEY_FILE, `${KEY}\n`, { mode: 0o600 });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it("is off when every value is empty, as the seed hook sends them", async () => {
    await expect(
      parseApiKeyChatSeed({
        MOSS_UAT_API_KEY_CHAT_KIND: "",
        MOSS_UAT_API_KEY_CHAT_BASE_URL: "",
        MOSS_UAT_API_KEY_CHAT_MODEL: "",
        MOSS_UAT_API_KEY_CHAT_KEY_FILE: ""
      })
    ).resolves.toBeUndefined();
  });

  it("returns the seed when all four are set", async () => {
    await expect(parseApiKeyChatSeed(FULL)).resolves.toEqual({
      providerKind: "openai-compatible",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      apiKey: KEY
    });
  });

  it("refuses a partial set without echoing any value", async () => {
    let message = "";
    try {
      await parseApiKeyChatSeed({ ...FULL, MOSS_UAT_API_KEY_CHAT_MODEL: "" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/together/);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("http://proxy.test");
  });

  it("refuses a kind chat cannot drive", async () => {
    await expect(
      parseApiKeyChatSeed({ ...FULL, MOSS_UAT_API_KEY_CHAT_KIND: "google" })
    ).rejects.toThrow(/anthropic or openai-compatible/);
  });
  it("refuses empty and broadly readable key files", async () => {
    await writeFile(FULL.MOSS_UAT_API_KEY_CHAT_KEY_FILE, "\n");
    await expect(parseApiKeyChatSeed(FULL)).rejects.toThrow(/is empty/);
    await writeFile(FULL.MOSS_UAT_API_KEY_CHAT_KEY_FILE, KEY);
    await chmod(FULL.MOSS_UAT_API_KEY_CHAT_KEY_FILE, 0o644);
    await expect(parseApiKeyChatSeed(FULL)).rejects.toThrow(/permissions/);
  });
});
