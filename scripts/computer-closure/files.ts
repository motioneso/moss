import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { supervisorError, sha256 } from "../computer-watchdog/trust.js";

export interface ClosureFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly dev: number;
  readonly ino: number;
  readonly hash: string;
}

/** Private regular files only. Never follows a final link or blocks opening a FIFO. */
export async function closureFile(path: string, limit: number): Promise<ClosureFile> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > limit
    )
      throw supervisorError();
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const actual = await lstat(path);
    if (
      offset !== stat.size ||
      offset > limit ||
      actual.dev !== stat.dev ||
      actual.ino !== stat.ino ||
      !actual.isFile() ||
      actual.uid !== stat.uid ||
      actual.mode !== stat.mode ||
      actual.nlink !== 1 ||
      actual.size !== stat.size
    )
      throw supervisorError();
    const bytes = buffer.subarray(0, offset);
    return { path, bytes, dev: stat.dev, ino: stat.ino, hash: sha256(bytes) };
  } finally {
    await file.close();
  }
}

export async function recheckClosureFile(file: ClosureFile): Promise<void> {
  const current = await closureFile(file.path, file.bytes.length);
  if (current.dev !== file.dev || current.ino !== file.ino || !current.bytes.equals(file.bytes))
    throw supervisorError();
}
