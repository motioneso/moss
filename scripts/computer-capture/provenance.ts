import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { HostStateStore } from "../computer-host/state.js";
import { assertFencedComputerState } from "../computer-watchdog/observe.js";
import {
  revalidateDeployment,
  sha256,
  supervisorError,
  type SupervisorDeployment
} from "../computer-watchdog/trust.js";
import { captureNamespaceAnchors } from "./cgroups.js";

const keys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"] as const;
const metadata = (stat: Stats) => Object.fromEntries(keys.map((key) => [key, stat[key]]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Metadata and bytes observed through the same bounded regular-file descriptor. */
async function pinnedFile(path: string, limit: number, mode?: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      (mode !== undefined && (stat.mode & 0o7777) !== mode) ||
      stat.size > limit
    )
      throw supervisorError();
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (
      offset !== stat.size ||
      !same(metadata(stat), metadata(await file.stat())) ||
      !same(metadata(stat), metadata(await lstat(path)))
    )
      throw supervisorError();
    return { path, metadata: metadata(stat), hash: sha256(bytes.subarray(0, offset)) };
  } finally {
    await file.close();
  }
}

export async function captureProvenance(deployment: SupervisorDeployment, store: HostStateStore) {
  await revalidateDeployment(deployment, false);
  await store.assertRoots();
  await store.assertLaunchable();
  await assertFencedComputerState(deployment, store.state);
  const { configuration: config } = deployment;
  const files = await Promise.all([
    pinnedFile(deployment.configPath, 16384, 0o600),
    pinnedFile(deployment.artifactPath, 2 * 1024 ** 2),
    pinnedFile(deployment.nodePath, 128 * 1024 ** 2),
    pinnedFile(join(config.host.stateDir, "state.json"), 16384, 0o600),
    pinnedFile(join(config.host.stateDir, "identity.json"), 16384, 0o600)
  ]);
  if (files[0]!.hash !== deployment.configSha256 || files[1]!.hash !== config.artifactSha256)
    throw supervisorError();
  const socket = await lstat(config.host.dockerSocket);
  if (!socket.isSocket()) throw supervisorError();
  return {
    files,
    socket: metadata(socket),
    lock: await store.ownedLock(),
    roots: deployment.roots,
    bootId: config.bootId,
    namespaces: { ...config.namespaces, ...(await captureNamespaceAnchors()) }
  };
}
