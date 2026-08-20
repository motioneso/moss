import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  promptHidden,
  readSecretFile,
  redact,
  withDecryptedSecret
} from "../../scripts/dev-instance/secrets.js";

const execFileAsync = promisify(execFile);

describe("dev-instance secrets (#1258)", () => {
  describe("readSecretFile", () => {
    it("rejects a file whose mode grants group or other any bit", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dev-instance-secrets-"));
      try {
        const path = join(dir, "secret");
        await writeFile(path, "sekrit\n");
        await chmod(path, 0o644);

        await expect(readSecretFile(path)).rejects.toThrow();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("accepts a file with mode 0600 and strips exactly one trailing newline", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dev-instance-secrets-"));
      try {
        const path = join(dir, "secret");
        await writeFile(path, "sekrit\n\n");
        await chmod(path, 0o600);

        await expect(readSecretFile(path)).resolves.toBe("sekrit\n");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("redact", () => {
    it("replaces every occurrence of every supplied secret", () => {
      const line = "token=abc123 and again token=abc123, other=xyz789";
      expect(redact(line, ["abc123", "xyz789"])).toBe("token=*** and again token=***, other=***");
    });

    it("redacts a secret that is a substring of a line printed twice", () => {
      const secret = "sekrit";
      const line = `first ${secret} second ${secret}`;
      const result = redact(line, [secret]);
      expect(result).not.toContain(secret);
      expect(result).toBe("first *** second ***");
    });
  });

  describe("withDecryptedSecret", () => {
    const RECIPIENT = "dev-instance-test@example.com";
    let gnupgHome: string;
    let cipherPath: string;

    beforeAll(async () => {
      gnupgHome = await mkdtemp(join(tmpdir(), "dev-instance-gnupg-"));
      await chmod(gnupgHome, 0o700);

      await execFileAsync(
        "gpg",
        [
          "--batch",
          "--passphrase",
          "",
          "--quick-generate-key",
          RECIPIENT,
          "default",
          "default",
          "never"
        ],
        { env: { ...process.env, GNUPGHOME: gnupgHome } }
      );

      const plainDir = await mkdtemp(join(tmpdir(), "dev-instance-secrets-plain-"));
      const plainPath = join(plainDir, "plain.txt");
      await writeFile(plainPath, "sentinel-secret-value\n");
      cipherPath = join(plainDir, "cipher.gpg");
      await execFileAsync(
        "gpg",
        [
          "--batch",
          "--yes",
          "--trust-model",
          "always",
          "-e",
          "-r",
          RECIPIENT,
          "-o",
          cipherPath,
          plainPath
        ],
        { env: { ...process.env, GNUPGHOME: gnupgHome } }
      );
    });

    afterAll(async () => {
      await rm(gnupgHome, { recursive: true, force: true });
    });

    it("passes the decrypted plaintext to use and removes its temp directory even when use throws", async () => {
      const before = await readdir(tmpdir());
      const beforeCount = before.filter((name) => name.startsWith("dev-instance-secret-")).length;

      const originalGnupgHome = process.env.GNUPGHOME;
      process.env.GNUPGHOME = gnupgHome;
      try {
        let observedSecret: string | undefined;
        await expect(
          withDecryptedSecret(cipherPath, async (secret) => {
            observedSecret = secret;
            throw new Error("use failed");
          })
        ).rejects.toThrow("use failed");
        expect(observedSecret).toBe("sentinel-secret-value");
      } finally {
        process.env.GNUPGHOME = originalGnupgHome;
      }

      const after = await readdir(tmpdir());
      const afterCount = after.filter((name) => name.startsWith("dev-instance-secret-")).length;
      expect(afterCount).toBe(beforeCount);
    });

    it("returns use's return value on success", async () => {
      const originalGnupgHome = process.env.GNUPGHOME;
      process.env.GNUPGHOME = gnupgHome;
      try {
        const result = await withDecryptedSecret(cipherPath, async (secret) =>
          secret.toUpperCase()
        );
        expect(result).toBe("SENTINEL-SECRET-VALUE");
      } finally {
        process.env.GNUPGHOME = originalGnupgHome;
      }
    });
  });

  describe("promptHidden", () => {
    it("restores the terminal's original echo state even when the read rejects", async () => {
      const stdin = process.stdin as unknown as {
        isTTY?: boolean;
        setRawMode?: (mode: boolean) => void;
      };
      const originalIsTTY = stdin.isTTY;
      const originalSetRawMode = stdin.setRawMode;
      const setRawModeCalls: boolean[] = [];

      stdin.isTTY = true;
      stdin.setRawMode = (mode: boolean): void => {
        setRawModeCalls.push(mode);
      };

      try {
        const promise = promptHidden("Password: ");
        // Let promptHidden's listeners attach before the stream ends.
        await new Promise((resolve) => setImmediate(resolve));
        process.stdin.emit("end");

        await expect(promise).rejects.toThrow();
        expect(setRawModeCalls[0]).toBe(true);
        expect(setRawModeCalls[setRawModeCalls.length - 1]).toBe(false);
      } finally {
        stdin.isTTY = originalIsTTY;
        stdin.setRawMode = originalSetRawMode;
      }
    });
  });
});
