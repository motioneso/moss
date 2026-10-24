import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { isRecord, isUuid } from "../../apps/api/src/computer/host-contract.js";

export const COMPUTER_IMAGE =
  "sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf";
export const ROLES = ["gateway", "desktop"] as const;
export type ComputerRole = (typeof ROLES)[number];
export const DIRECTORY_KEYS = [
  "stateDir",
  "controlDir",
  "homeDir",
  "guestSocketDir",
  "gatewayDir",
  "authDir",
  "gatewayConfigDir"
] as const;
export type DirectoryKey = (typeof DIRECTORY_KEYS)[number];
export type HostConfig = Readonly<Record<DirectoryKey, string>> & {
  readonly instanceId: string;
  readonly ownerUserId: string;
  readonly dockerSocket: string;
  readonly gatewayImage: string | null;
};
export function parseHostConfig(value: unknown): HostConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      [...DIRECTORY_KEYS, "instanceId", "ownerUserId", "dockerSocket", "gatewayImage"]
        .sort()
        .join(",") ||
    !isUuid(value.instanceId) ||
    !isUuid(value.ownerUserId) ||
    !(
      value.gatewayImage === null ||
      (typeof value.gatewayImage === "string" && /^sha256:[0-9a-f]{64}$/.test(value.gatewayImage))
    ) ||
    ![...DIRECTORY_KEYS, "dockerSocket"].every(
      (key) =>
        typeof value[key] === "string" &&
        isAbsolute(value[key]) &&
        !value[key].includes(":") &&
        [...value[key]].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
        )
    )
  )
    throw new Error("Invalid Computer host configuration");
  return Object.freeze(value as unknown as HostConfig);
}
export interface RootIdentity {
  path: string;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  mode: number;
}

export async function inspectRoots(config: HostConfig): Promise<RootIdentity[]> {
  const roots: RootIdentity[] = [];
  const uid = process.getuid!();
  for (const key of DIRECTORY_KEYS) {
    const path = config[key];
    const stat = await lstat(path);
    if (!stat.isDirectory() || (await realpath(path)) !== path)
      throw new Error("Unsafe Computer root");
    if (
      (key === "stateDir" && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700)) ||
      (key === "controlDir" && (stat.uid !== uid || (stat.mode & 0o027) !== 0)) ||
      (stat.mode & 0o002) !== 0
    )
      throw new Error("Unsafe Computer root permissions");
    let parent = dirname(path);
    for (;;) {
      const ancestor = await lstat(parent);
      // A root-owned sticky /tmp is acceptable; another user's writable ancestor is not.
      if (
        ![0, uid].includes(ancestor.uid) ||
        ((ancestor.mode & 0o022) !== 0 && !(ancestor.uid === 0 && (ancestor.mode & 0o1000) !== 0))
      )
        throw new Error("Unsafe Computer ancestor");
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    roots.push({
      path,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode
    });
  }
  for (const left of roots)
    for (const right of roots) {
      if (left === right) continue;
      const rel = relative(left.path, right.path);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
        throw new Error("Overlapping Computer roots");
    }
  return roots;
}
