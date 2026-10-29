import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  lifetimePath,
  parseComputerLifetime
} from "../../apps/api/src/computer/lifetime-protocol.js";
import { dirname, isAbsolute, normalize } from "node:path";
import { isUuid } from "../../apps/api/src/computer/host-contract.js";
import { gatewayFields } from "../../apps/api/src/computer/gateway-channel.js";
import type { ComputerGatewayConfig } from "../../apps/api/src/computer/gateway-server.js";
import { assertComputerPrivateParent } from "../../apps/api/src/computer/private-endpoint.js";

export async function readComputerGatewayConfig(path: string): Promise<ComputerGatewayConfig> {
  const parent = dirname(path);
  const directory = await lstat(parent);
  const rootDelivery =
    directory.uid === 0 && directory.gid === 1000 && (directory.mode & 0o7777) === 0o750;
  if (rootDelivery) {
    if (!isAbsolute(path) || normalize(path) !== path || (await realpath(parent)) !== parent)
      throw new Error("Computer gateway unavailable");
    for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
      const stat = await lstat(ancestor);
      if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0)
        throw new Error("Computer gateway unavailable");
      if (dirname(ancestor) === ancestor) break;
    }
  } else await assertComputerPrivateParent(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (rootDelivery
        ? stat.uid !== 0 || stat.gid !== 1000 || (stat.mode & 0o7777) !== 0o640
        : stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600) ||
      stat.nlink !== 1 ||
      stat.size > 4096
    )
      throw new Error("Computer gateway unavailable");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const published = await lstat(path);
    const currentParent = await lstat(parent);
    if (
      bytesRead > 4096 ||
      bytesRead !== stat.size ||
      !published.isFile() ||
      ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"].some(
        (key) => published[key as keyof typeof published] !== stat[key as keyof typeof stat]
      ) ||
      ["dev", "ino", "uid", "gid", "mode"].some(
        (key) =>
          currentParent[key as keyof typeof currentParent] !==
          directory[key as keyof typeof directory]
      ) ||
      (await realpath(parent)) !== parent
    )
      throw new Error("Computer gateway unavailable");
    return parseComputerGatewayConfig(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await file.close();
  }
}
export function parseComputerGatewayConfig(value: unknown): ComputerGatewayConfig {
  if (
    !gatewayFields(value, "authSocketPath,guestSocketPath,lifetime,ownerUserId,socketPath") ||
    !isUuid(value.ownerUserId)
  )
    throw new Error("Computer gateway unavailable");
  const path = (key: string): string => {
    const item = value[key];
    if (
      typeof item !== "string" ||
      !isAbsolute(item) ||
      normalize(item) !== item ||
      [...item].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new Error("Computer gateway unavailable");
    return item;
  };
  const result = {
    ownerUserId: value.ownerUserId,
    authSocketPath: path("authSocketPath"),
    guestSocketPath: path("guestSocketPath"),
    socketPath: path("socketPath"),
    lifetime: parseComputerLifetime(value.lifetime)
  };
  if (
    new Set([
      result.authSocketPath,
      result.guestSocketPath,
      result.socketPath,
      lifetimePath(result.socketPath)
    ]).size !== 4
  )
    throw new Error("Computer gateway unavailable");
  return Object.freeze(result);
}
