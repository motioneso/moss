import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { isUuid } from "../../apps/api/src/computer/host-contract.js";
import { gatewayFields } from "../../apps/api/src/computer/gateway-channel.js";
import type { ComputerGatewayConfig } from "../../apps/api/src/computer/gateway-server.js";
import { assertComputerPrivateParent } from "../../apps/api/src/computer/private-endpoint.js";

export async function readComputerGatewayConfig(path: string): Promise<ComputerGatewayConfig> {
  await assertComputerPrivateParent(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 4096
    )
      throw new Error("Computer gateway unavailable");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("Computer gateway unavailable");
    return parseComputerGatewayConfig(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await file.close();
  }
}
export function parseComputerGatewayConfig(value: unknown): ComputerGatewayConfig {
  if (
    !gatewayFields(value, "authSocketPath,guestSocketPath,ownerUserId,socketPath") ||
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
    socketPath: path("socketPath")
  };
  if (new Set([result.authSocketPath, result.guestSocketPath, result.socketPath]).size !== 3)
    throw new Error("Computer gateway unavailable");
  return Object.freeze(result);
}
