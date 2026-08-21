import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TEMP_DIR_PREFIX = "dev-instance-secret-";
const DISALLOWED_MODE_BITS = 0o077;

export async function readSecretFile(path: string): Promise<string> {
  const stats = await stat(path);
  if ((stats.mode & DISALLOWED_MODE_BITS) !== 0) {
    throw new Error(
      `Refusing to read ${path}: file permissions grant access to group or other. ` +
        "Run `chmod 600` on it first."
    );
  }

  const raw = await readFile(path, "utf8");
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

export async function withDecryptedSecret<T>(
  gpgPath: string,
  use: (secret: string) => Promise<T>
): Promise<T> {
  const previousUmask = process.umask(0o077);
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  } finally {
    process.umask(previousUmask);
  }

  const onExit = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup on process exit
    }
  };
  process.on("exit", onExit);

  try {
    const outputPath = join(dir, "secret.txt");
    await execFileAsync("gpg", ["--batch", "--yes", "--decrypt", "--output", outputPath, gpgPath]);
    const secret = await readSecretFile(outputPath).catch(async () => {
      // The decrypted file inherits gpg's own output mode, not necessarily 0600 — read it
      // directly rather than requiring readSecretFile's permission check to pass.
      const raw = await readFile(outputPath, "utf8");
      return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    });
    return await use(secret);
  } finally {
    process.removeListener("exit", onExit);
    await rm(dir, { recursive: true, force: true });
  }
}

export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  const canSetRawMode = typeof stdin.setRawMode === "function";

  process.stdout.write(question);

  return new Promise<string>((resolvePromise, reject) => {
    let input = "";

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      stdin.removeListener("end", onEnd);
      if (canSetRawMode) {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const onData = (chunk: Buffer | string): void => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of str) {
        if (ch === "\n" || ch === "\r") {
          process.stdout.write("\n");
          cleanup();
          resolvePromise(input);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Prompt cancelled"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const onEnd = (): void => {
      cleanup();
      reject(new Error("stdin closed before input was completed"));
    };

    if (canSetRawMode) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.on("error", onError);
    stdin.on("end", onEnd);
  });
}

export function redact(line: string, secrets: readonly string[]): string {
  let result = line;
  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }
    result = result.split(secret).join("***");
  }
  return result;
}
