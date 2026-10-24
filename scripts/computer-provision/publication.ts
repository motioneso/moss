import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { RootIdentity } from "../computer-host/config.js";
import { openRoot, assertRoot, descriptorPath } from "../computer-watchdog/linux-files.js";
import { sha256, supervisorError } from "../computer-watchdog/trust.js";

export async function assertEmptyOutput(root: RootIdentity): Promise<void> {
  const directory = await openRoot(root);
  try {
    const iterator = await opendir(descriptorPath(directory), { bufferSize: 1 });
    try {
      if (await iterator.read()) throw supervisorError();
    } finally {
      await iterator.close();
    }
    await assertRoot(root);
  } finally {
    await directory.close();
  }
}

/** Exact exclusive publication; failures retain partial files and never overwrite or unlink. */
export class ProvisionPublication {
  private constructor(
    readonly root: RootIdentity,
    readonly name: string,
    readonly bytes: Buffer,
    readonly mode: number,
    readonly gid: number,
    readonly dev: number,
    readonly ino: number
  ) {}
  get path() {
    return join(this.root.path, this.name);
  }
  get hash() {
    return sha256(this.bytes);
  }
  static async create(
    root: RootIdentity,
    name:
      | "supervisor.json"
      | "gateway.json"
      | "prepared.json"
      | "capture.json"
      | "closure-key.pem"
      | "installation.json",
    value: unknown,
    mode: number,
    gid: number,
    check: () => Promise<void>,
    current: () => void
  ): Promise<ProvisionPublication> {
    if ((name === "closure-key.pem") !== Buffer.isBuffer(value)) throw supervisorError();
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    if (
      bytes.length >
      (name === "capture.json"
        ? 65536
        : name === "gateway.json" || name === "closure-key.pem"
          ? 4096
          : 16384)
    )
      throw supervisorError();
    const directory = await openRoot(root);
    try {
      await check();
      current();
      const file = await open(
        `${descriptorPath(directory)}/${name}`,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      );
      let result: ProvisionPublication;
      try {
        await file.writeFile(bytes);
        await file.chown(root.uid, gid);
        await file.chmod(mode);
        await file.sync();
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== root.uid ||
          stat.gid !== gid ||
          (stat.mode & 0o7777) !== mode ||
          stat.nlink !== 1 ||
          stat.size !== bytes.length
        )
          throw supervisorError();
        result = new ProvisionPublication(root, name, bytes, mode, gid, stat.dev, stat.ino);
      } finally {
        await file.close();
      }
      await directory.sync();
      await check();
      current();
      await result.assertPublished();
      return result;
    } finally {
      await directory.close();
    }
  }
  async assertPublished(): Promise<void> {
    const directory = await openRoot(this.root);
    try {
      const path = `${descriptorPath(directory)}/${this.name}`;
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== this.root.uid ||
          stat.gid !== this.gid ||
          (stat.mode & 0o7777) !== this.mode ||
          stat.nlink !== 1 ||
          stat.size !== this.bytes.length ||
          stat.dev !== this.dev ||
          stat.ino !== this.ino
        )
          throw supervisorError();
        const bytes = Buffer.alloc(this.bytes.length + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        const published = await lstat(path);
        if (
          bytesRead !== this.bytes.length ||
          !bytes.subarray(0, bytesRead).equals(this.bytes) ||
          !published.isFile() ||
          ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].some(
            (key) => published[key as keyof typeof published] !== stat[key as keyof typeof stat]
          )
        )
          throw supervisorError();
        await assertRoot(this.root);
      } finally {
        await file.close();
      }
    } finally {
      await directory.close();
    }
  }
}
