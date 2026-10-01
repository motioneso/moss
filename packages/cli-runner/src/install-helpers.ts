import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

/** Small file, hash and message helpers shared by the install service and its candidate module. */

/** A short random token for staging dirs / release dirs / temp symlinks. */
export function randToken(): string {
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 16);
}

/** SHA512 (lowercase hex) of a file's exact bytes. */
export async function sha512OfFile(file: string): Promise<string> {
  const h = createHash("sha512");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

/**
 * SHA512 of the binary the path resolves TO (dereferencing a `.bin` symlink / the
 * `current` symlink chain). Node stat/readStream already follow symlinks, so this hashes
 * the real target bytes — the §A.3.4 promote-target hash.
 */
export async function sha512OfResolved(file: string): Promise<string> {
  return sha512OfFile(file);
}

export function hashEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function isExecutable(file: string): Promise<boolean> {
  try {
    const st = await stat(file);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export async function isPublishedNpmRelease(release: string): Promise<boolean> {
  try {
    const st = await lstat(release);
    return st.isDirectory() && (st.mode & 0o777) === 0o755;
  } catch {
    return false;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Redact an npm stderr blob (it can echo a registry URL with credentials). */
export function redactNpm(s: string): string {
  return s.replace(/\/\/[^@\s/]+:[^@\s/]+@/g, "//<redacted>@").slice(0, 1500);
}

/** Convert any caught error to a short, non-secret message. */
export function redactInstallMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactNpm(raw);
}
