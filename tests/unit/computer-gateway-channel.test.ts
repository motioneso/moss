import { once } from "node:events";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdtemp, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectComputerGatewayViewer } from "../../apps/api/src/computer/gateway-client.js";
import { GatewayChannel } from "../../apps/api/src/computer/gateway-channel.js";
import {
  parseComputerGatewayConfig,
  readComputerGatewayConfig
} from "../../scripts/computer-gateway/config.js";
import { OWNER } from "./computer-auth-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(accept: (socket: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), "moss-gw-ipc-"));
  const path = join(root, "s");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    accept(socket);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, path };
}

describe("private Computer gateway framing and configuration", () => {
  it.each(["wrong correlation", "unknown fields", "pipelined reply"])(
    "retires the actual client on %s",
    async (kind) => {
      const f = await fixture((socket) =>
        socket.once("data", () => {
          const response =
            kind === "wrong correlation"
              ? { type: "ok", requestId: 2 }
              : kind === "unknown fields"
                ? { type: "ok", requestId: 1, extra: true }
                : { type: "ok", requestId: 1 };
          socket.write(
            JSON.stringify(response) +
              "\n" +
              (kind === "pipelined reply" ? JSON.stringify(response) + "\n" : "")
          );
        })
      );
      await expect(
        connectComputerGatewayViewer({ socketPath: f.path, viewerId: OWNER })
      ).rejects.toThrow();
    }
  );

  it("refuses to enqueue a corked outgoing command above the actual byte cap", async () => {
    let channel: GatewayChannel | undefined;
    const f = await fixture((socket) => {
      channel = new GatewayChannel(
        socket,
        () => {},
        () => {}
      );
      socket.cork();
    });
    const client = createConnection(f.path);
    client.on("error", () => {});
    await once(client, "connect");
    await new Promise((resolve) => setImmediate(resolve));
    let refused = false;
    try {
      for (let i = 0; i < 200; i++) channel!.send({ type: "test", value: "x".repeat(500) });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(channel!.socket.writableLength).toBeLessThanOrEqual(65_536);
    client.destroy();
  });

  it("requires exact fixed config, private regular file and canonical private parent", async () => {
    const f = await fixture((socket) => socket.destroy());
    const config = {
      ownerUserId: OWNER,
      guestSocketPath: join(f.root, "guest"),
      authSocketPath: join(f.root, "auth"),
      socketPath: join(f.root, "gateway")
    };
    const path = join(f.root, "config.json");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    expect(await readComputerGatewayConfig(path)).toEqual(config);
    expect(() =>
      parseComputerGatewayConfig({ ...config, guestSocketPath: config.socketPath })
    ).toThrow();
    expect(() => parseComputerGatewayConfig({ ...config, extra: true })).toThrow();
    expect(() => parseComputerGatewayConfig({ ...config, authSocketPath: "relative" })).toThrow();
    const alias = join(f.root, "alias");
    await symlink(path, alias);
    await expect(readComputerGatewayConfig(alias)).rejects.toThrow();
    await chmod(path, 0o644);
    await expect(readComputerGatewayConfig(path)).rejects.toThrow();
  });
});
