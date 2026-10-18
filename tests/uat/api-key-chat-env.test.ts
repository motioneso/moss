import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  API_KEY_CHAT_UAT_ENV,
  API_KEY_CHAT_CONTAINER_KEY_FILE,
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
const checkFile = async () => {};

describe("API-key chat UAT settings (#3410)", () => {
  it("is off when none of the four variables is set", async () => {
    expect(apiKeyChatUatConfigured({})).toBe(false);
    await expect(readApiKeyChatUatProvider({}, checkFile)).resolves.toBeUndefined();
  });

  it("reads all four without loading the key on the host", async () => {
    expect(apiKeyChatUatConfigured(FULL)).toBe(true);
    await expect(readApiKeyChatUatProvider(FULL, checkFile)).resolves.toEqual({
      providerKind: "openai-compatible",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      keyFile: FULL[API_KEY_CHAT_UAT_ENV.keyFile]
    });
  });

  it("names the missing variables, never the values, when only some are set", async () => {
    const partial = { ...FULL, [API_KEY_CHAT_UAT_ENV.model]: "" };
    expect(apiKeyChatUatConfigured(partial)).toBe(false);

    const error = await readApiKeyChatUatProvider(partial, checkFile).catch((e: unknown) => e);

    expect((error as Error).message).toContain(API_KEY_CHAT_UAT_ENV.model);
    expect((error as Error).message).not.toContain("http://proxy.test");
    expect((error as Error).message).not.toContain("/tmp/ada-uat-key");
  });

  it("refuses a kind chat cannot drive", async () => {
    await expect(
      readApiKeyChatUatProvider({ ...FULL, [API_KEY_CHAT_UAT_ENV.kind]: "google" }, checkFile)
    ).rejects.toThrow(/anthropic or openai-compatible/);
  });

  it("refuses an address that is not http or https", async () => {
    await expect(
      readApiKeyChatUatProvider(
        { ...FULL, [API_KEY_CHAT_UAT_ENV.baseUrl]: "proxy.test" },
        checkFile
      )
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it("accepts a restricted file and refuses group-readable files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uat-key-settings-"));
    const keyFile = join(dir, "key");
    try {
      await writeFile(keyFile, KEY, { mode: 0o600 });
      const env = { ...FULL, [API_KEY_CHAT_UAT_ENV.keyFile]: keyFile };
      await expect(readApiKeyChatUatProvider(env)).resolves.toMatchObject({ keyFile });
      await chmod(keyFile, 0o640);
      await expect(readApiKeyChatUatProvider(env)).rejects.toThrow(/owner-only/);
      await expect(
        readApiKeyChatUatProvider({ ...env, [API_KEY_CHAT_UAT_ENV.keyFile]: dir })
      ).rejects.toThrow(/regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("mounts the file read-only and passes only its container path", () => {
    const seed = {
      providerKind: "anthropic",
      baseUrl: "http://proxy.test",
      model: "ada-model",
      keyFile: FULL[API_KEY_CHAT_UAT_ENV.keyFile]
    } as const;
    expect(apiKeyChatSeedArgs(seed)).toEqual([
      "--volume",
      `${seed.keyFile}:${API_KEY_CHAT_CONTAINER_KEY_FILE}:ro`,
      "-e",
      "MOSS_UAT_API_KEY_CHAT_KIND=anthropic",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_BASE_URL=http://proxy.test",
      "-e",
      "MOSS_UAT_API_KEY_CHAT_MODEL=ada-model",
      "-e",
      `MOSS_UAT_API_KEY_CHAT_KEY_FILE=${API_KEY_CHAT_CONTAINER_KEY_FILE}`
    ]);
  });

  it("removes an inherited plaintext key and does not mount anything when off", () => {
    const base = { MOSS_UAT_API_KEY_CHAT_KEY: KEY, PATH: "/usr/bin" };
    expect(apiKeyChatSeedProcessEnv(base)).toEqual({ PATH: "/usr/bin" });
    expect(base.MOSS_UAT_API_KEY_CHAT_KEY).toBe(KEY);
    expect(apiKeyChatSeedArgs(undefined)).toContain("MOSS_UAT_API_KEY_CHAT_KEY_FILE=");
    expect(apiKeyChatSeedArgs(undefined)).not.toContain("--volume");
  });
});
