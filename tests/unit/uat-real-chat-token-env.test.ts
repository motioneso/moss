/**
 * #1121 (Coordinator constraint 1): the opt-in real-chat token env file must contain EXACTLY
 * one nonempty key, CLAUDE_CODE_OAUTH_TOKEN — reject extra keys or malformed content, fail
 * closed. Never log the token/decrypted content anywhere, including in assertion failure
 * messages here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  validateSingleTokenEnvContent,
  writeUatRealChatEnvFile
} from "../../tests/uat/real-chat-env.js";

describe("validateSingleTokenEnvContent", () => {
  it("throws on an extra key", () => {
    expect(() =>
      validateSingleTokenEnvContent("CLAUDE_CODE_OAUTH_TOKEN=abc\nOTHER_KEY=def\n")
    ).toThrow(/exactly one/i);
  });

  it("throws when the only key is not the allowed one", () => {
    expect(() => validateSingleTokenEnvContent("SOME_OTHER_TOKEN=abc\n")).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/
    );
  });

  it("throws on empty content", () => {
    expect(() => validateSingleTokenEnvContent("")).toThrow(/empty/i);
    expect(() => validateSingleTokenEnvContent("\n\n  \n")).toThrow(/empty/i);
  });

  it("throws on a malformed line with no '='", () => {
    expect(() => validateSingleTokenEnvContent("not-a-valid-line\n")).toThrow(/malformed/i);
  });

  it("throws when the allowed key's value is empty", () => {
    expect(() => validateSingleTokenEnvContent("CLAUDE_CODE_OAUTH_TOKEN=\n")).toThrow(/empty/i);
  });

  it("accepts exactly one CLAUDE_CODE_OAUTH_TOKEN key with a nonempty value", () => {
    expect(() =>
      validateSingleTokenEnvContent("CLAUDE_CODE_OAUTH_TOKEN=uat-synthetic-not-real\n")
    ).not.toThrow();
  });
});

describe("writeUatRealChatEnvFile", () => {
  const originalTriggerEnv = process.env.JARVIS_UAT_REAL_CHAT_TOKEN_FILE;
  const originalGnupgHome = process.env.GNUPGHOME;
  const originalResultEnv = process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE;
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    if (originalTriggerEnv === undefined) delete process.env.JARVIS_UAT_REAL_CHAT_TOKEN_FILE;
    else process.env.JARVIS_UAT_REAL_CHAT_TOKEN_FILE = originalTriggerEnv;
    if (originalResultEnv === undefined) delete process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE;
    else process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE = originalResultEnv;
    while (cleanups.length > 0) cleanups.pop()!();
  });

  it("is a no-op (returns undefined, sets nothing) when the trigger env var is absent", async () => {
    delete process.env.JARVIS_UAT_REAL_CHAT_TOKEN_FILE;
    const result = await writeUatRealChatEnvFile();
    expect(result).toBeUndefined();
    expect(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE).toBeUndefined();
  });

  describe("with a real ephemeral GPG keypair", () => {
    let gnupgHome: string;

    beforeAll(() => {
      // Ephemeral, passphrase-less test-only keypair — never the operator's real key.
      gnupgHome = mkdtempSync(join(tmpdir(), "jarv1s-uat-test-gnupghome-"));
      process.env.GNUPGHOME = gnupgHome;
      const paramFile = join(gnupgHome, "keyparams.txt");
      writeFileSync(
        paramFile,
        [
          "%no-protection",
          "Key-Type: eddsa",
          "Key-Curve: ed25519",
          "Subkey-Type: ecdh",
          "Subkey-Curve: cv25519",
          "Name-Real: UAT Test",
          "Name-Email: uat-test@example.invalid",
          "Expire-Date: 0",
          "%commit"
        ].join("\n")
      );
      execFileSync("gpg", ["--batch", "--gen-key", paramFile], { stdio: "ignore" });
    });

    afterAll(() => {
      rmSync(gnupgHome, { force: true, recursive: true });
      if (originalGnupgHome === undefined) delete process.env.GNUPGHOME;
      else process.env.GNUPGHOME = originalGnupgHome;
    });

    function encryptToTempFile(content: string): string {
      const dir = mkdtempSync(join(tmpdir(), "jarv1s-uat-test-encsrc-"));
      cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
      const plainPath = join(dir, "plain.env");
      const encPath = join(dir, "token.env.gpg");
      writeFileSync(plainPath, content);
      execFileSync(
        "gpg",
        [
          "--batch",
          "--yes",
          "--recipient",
          "uat-test@example.invalid",
          "--output",
          encPath,
          "--encrypt",
          plainPath
        ],
        { stdio: "ignore" }
      );
      return encPath;
    }

    it("decrypts, validates, and returns a path with mode 0600 in a 0700 dir on the happy path", async () => {
      process.env.JARVIS_UAT_REAL_CHAT_TOKEN_FILE = encryptToTempFile(
        "CLAUDE_CODE_OAUTH_TOKEN=uat-synthetic-not-real\n"
      );
      const result = await writeUatRealChatEnvFile();
      expect(result).toBeDefined();
      cleanups.push(() => result!.cleanup());
      expect(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE).toBe(result!.path);
      expect(statSync(result!.path).mode & 0o777).toBe(0o600);
      const dir = join(result!.path, "..");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    });

    it("fails closed and cleans up when the decrypted content has an extra key", async () => {
      process.env.JARVIS_UAT_REAL_CHAT_TOKEN_FILE = encryptToTempFile(
        "CLAUDE_CODE_OAUTH_TOKEN=uat-synthetic-not-real\nEXTRA_KEY=nope\n"
      );
      await expect(writeUatRealChatEnvFile()).rejects.toThrow(/exactly one/i);
      expect(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE).toBeUndefined();
    });
  });
});
