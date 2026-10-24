import { afterEach, describe, expect, it, vi } from "vitest";
import { once, EventEmitter } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifetimeChannel } from "../../apps/api/src/computer/lifetime-channel.js";
import { ComputerLifetimeReceiver } from "../../apps/api/src/computer/lifetime-receiver.js";
import { ComputerRootLifetime } from "../../scripts/computer-watchdog/lifetime.js";
import {
  lifetimeNow,
  lifetimeNonce,
  lifetimeHeader,
  parseComputerLifetime,
  signLifetime,
  verifyLifetime,
  type LifetimeProof
} from "../../apps/api/src/computer/lifetime-protocol.js";
import { lifetimeConfiguration } from "./computer-lifetime-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function sockets(accept: (socket: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), "computer-lifetime-"));
  await chmod(root, 0o700);
  const path = join(root, "lifetime.sock");
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    accept(socket);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return path;
}
async function receiver(now = lifetimeNow) {
  const config = lifetimeConfiguration();
  const retire = vi.fn();
  const active = vi.fn();
  const path = await sockets((socket) => {
    const receiver = new ComputerLifetimeReceiver(socket, config, active, retire, now);
    cleanups.push(async () => receiver.close());
  });
  const socket = createConnection(path);
  const messages: unknown[] = [];
  const events = new EventEmitter();
  const channel = new LifetimeChannel(
    socket,
    (proof) => {
      messages.push(proof);
      events.emit("message");
    },
    () => {}
  );
  cleanups.push(async () => channel.close());
  await once(socket, "connect");
  let offset = 0;
  return {
    socket,
    config,
    retire,
    active,
    channel,
    async next() {
      while (offset >= messages.length) await once(events, "message");
      return verifyLifetime(config, messages[offset++]);
    },
    async hello(rootNonce = lifetimeNonce()) {
      channel.send({ type: "hello", version: 1, rootNonce });
      const proof = await this.next();
      if (proof.type !== "challenge" || !("counter" in proof))
        throw new Error("Expected challenge");
      return proof;
    }
  };
}

describe("authenticated native Unix Computer lifetime", () => {
  it("activates only an exact signed response and retires before a nonce-bound fenced acknowledgement", async () => {
    const f = await receiver();
    const challenge = await f.hello();
    expect(f.active).not.toHaveBeenCalled();
    f.channel.send(signLifetime(f.config, { ...challenge, type: "alive" }));
    expect((await f.next()).type).toBe("active");
    expect(f.active).toHaveBeenCalledTimes(1);
    const stop: LifetimeProof = {
      type: "stop",
      version: 1,
      rootNonce: challenge.rootNonce,
      sessionNonce: challenge.sessionNonce,
      stopNonce: lifetimeNonce()
    };
    f.channel.send(signLifetime(f.config, stop));
    expect(await f.next()).toEqual(signLifetime(f.config, { ...stop, type: "fenced" }));
    expect(f.retire).toHaveBeenCalled();
  });
  it("accepts a coalesced renewal and terminal stop without dropping the stop", async () => {
    const f = await receiver();
    const challenge = await f.hello();
    const stop: LifetimeProof = {
      type: "stop",
      version: 1,
      rootNonce: challenge.rootNonce,
      sessionNonce: challenge.sessionNonce,
      stopNonce: lifetimeNonce()
    };
    f.socket.write(
      [signLifetime(f.config, { ...challenge, type: "alive" }), signLifetime(f.config, stop)]
        .map((v) => JSON.stringify(v) + "\n")
        .join("")
    );
    expect((await f.next()).type).toBe("active");
    expect((await f.next()).type).toBe("fenced");
    expect(f.retire).toHaveBeenCalled();
  });
  it.each(["mac", "binding", "type", "root", "session", "counter", "extra"])(
    "retires on %s forgery or replay",
    async (kind) => {
      const f = await receiver();
      const challenge = await f.hello();
      let proof: unknown = signLifetime(f.config, { ...challenge, type: "alive" });
      if (kind === "mac") proof = { ...(proof as object), mac: "0".repeat(64) };
      if (kind === "binding")
        proof = signLifetime(
          { ...f.config, binding: { ...f.config.binding, requestGeneration: 4 } },
          { ...challenge, type: "alive" }
        );
      if (kind === "type") proof = challenge;
      if (kind === "root")
        proof = signLifetime(f.config, { ...challenge, type: "alive", rootNonce: lifetimeNonce() });
      if (kind === "session")
        proof = signLifetime(f.config, {
          ...challenge,
          type: "alive",
          sessionNonce: lifetimeNonce()
        });
      if (kind === "counter" && "counter" in challenge)
        proof = signLifetime(f.config, { ...challenge, type: "alive", counter: 2 });
      if (kind === "extra") proof = { ...(proof as object), extra: true };
      const closed = once(f.socket, "close");
      f.channel.send(proof);
      await closed;
      expect(f.retire).toHaveBeenCalled();
      expect(f.active).not.toHaveBeenCalled();
    }
  );
  it("expires at equality before accepting a queued alive response", async () => {
    let clock = 0;
    const f = await receiver(() => clock);
    const challenge = await f.hello();
    clock = 1000;
    const closed = once(f.socket, "close");
    f.channel.send(signLifetime(f.config, { ...challenge, type: "alive" }));
    await closed;
    expect(f.active).not.toHaveBeenCalled();
    expect(f.retire).toHaveBeenCalled();
  });
  it("root EOF synchronously retires the receiver", async () => {
    const f = await receiver();
    await f.hello();
    f.channel.close();
    await expect.poll(() => f.retire.mock.calls.length).toBeGreaterThan(0);
  });
  it("a silent root loses its outstanding challenge within one second", async () => {
    const f = await receiver();
    await f.hello();
    await once(f.socket, "close");
    expect(f.retire).toHaveBeenCalled();
    expect(f.active).not.toHaveBeenCalled();
  });
  it.each(["chunk", "line", "frames", "partial"])("bounds %s ingress", async (kind) => {
    const f = await receiver();
    const closed = once(f.socket, "close");
    if (kind === "chunk") f.socket.write(Buffer.alloc(4097, 120));
    if (kind === "line") f.socket.write("x".repeat(1025));
    if (kind === "frames") f.socket.write("{}\n".repeat(5));
    if (kind === "partial") f.socket.write("{");
    await closed;
    expect(f.retire).toHaveBeenCalled();
  });
  it("bounds actual outgoing backlog before write", async () => {
    const path = await sockets(() => {});
    const socket = createConnection(path);
    await once(socket, "connect");
    const channel = new LifetimeChannel(
      socket,
      () => {},
      () => {}
    );
    cleanups.push(async () => channel.close());
    Object.defineProperty(socket, "writableLength", { value: 4096 });
    expect(() => channel.send({ type: "hello" })).toThrow("Computer lifetime unavailable");
  });
  it.each(["silent", "replayed"])(
    "root bounds %s first challenge without exposing its secret",
    async (kind) => {
      const config = lifetimeConfiguration();
      const failed = vi.fn();
      const seen: unknown[] = [];
      const path = await sockets((socket) => {
        const channel = new LifetimeChannel(
          socket,
          (hello) => {
            seen.push(hello);
            if (kind === "replayed")
              channel.send(
                signLifetime(config, {
                  type: "challenge",
                  version: 1,
                  rootNonce: lifetimeNonce(),
                  sessionNonce: lifetimeNonce(),
                  challengeNonce: lifetimeNonce(),
                  counter: 1
                })
              );
          },
          () => {}
        );
      });
      const root = new ComputerRootLifetime({
        configuration: config,
        socketPath: path,
        now: lifetimeNow,
        healthy: () => true,
        failed
      });
      cleanups.push(() => root.stop());
      root.start();
      await expect.poll(() => failed.mock.calls.length, { timeout: 3000 }).toBe(1);
      expect(seen).toHaveLength(1); // No alive proof may answer a replayed root challenge.
      expect(JSON.stringify(seen)).not.toContain(config.secret);
      expect(await root.stop()).toBe(false);
    }
  );
  it("strictly validates and freezes exact configuration", () => {
    const input = lifetimeConfiguration();
    const parsed = parseComputerLifetime(input);
    expect(Object.isFrozen(parsed.binding)).toBe(true);
    expect(() => parseComputerLifetime({ ...input, extra: true })).toThrow();
    expect(() => parseComputerLifetime({ ...input, secret: "x" })).toThrow();
    expect(() =>
      parseComputerLifetime({ ...input, binding: { ...input.binding, desktopGeneration: 4 } })
    ).toThrow();
    expect(() =>
      parseComputerLifetime({
        ...input,
        binding: { ...input.binding, gatewayId: input.binding.desktopId }
      })
    ).toThrow();
  });
  it("bounds four valid frames per event and rejects the fifth without dispatching it", async () => {
    const receive = vi.fn();
    const path = await sockets((socket) => {
      new LifetimeChannel(socket, receive, () => {});
    });
    const socket = createConnection(path);
    socket.on("error", () => {});
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write("{}\n".repeat(5));
    await expect.poll(() => receive.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(receive).toHaveBeenCalledTimes(4);
    socket.destroy();
    await closed;
  });
  it("partial-line equality expiry does not renew on trickled bytes", async () => {
    let clock = 0;
    let channel!: LifetimeChannel;
    let received!: () => void;
    const partial = new Promise<void>((resolve) => {
      received = resolve;
    });
    const dispatch = vi.fn();
    const path = await sockets((socket) => {
      channel = new LifetimeChannel(
        socket,
        dispatch,
        () => {},
        () => clock
      );
      socket.once("data", received);
    });
    const socket = createConnection(path);
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write("{");
    await partial;
    clock = 2000;
    const closed = once(socket, "close");
    socket.write("}\n");
    await expect.poll(() => socket.destroyed || dispatch.mock.calls.length > 0).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    socket.destroy();
    await closed;
    channel.close();
  });
  it.each(["ack", "idle"])(
    "root bounds %s silence after signed possession proof",
    async (phase) => {
      const config = lifetimeConfiguration();
      const failed = vi.fn();
      const path = await sockets((socket) => {
        const channel = new LifetimeChannel(
          socket,
          (value) => {
            if (lifetimeHeader(value))
              channel.send(
                signLifetime(config, {
                  type: "challenge",
                  version: 1,
                  rootNonce: value.rootNonce,
                  sessionNonce: lifetimeNonce(),
                  challengeNonce: lifetimeNonce(),
                  counter: 1
                })
              );
            else {
              const proof = verifyLifetime(config, value);
              if (proof.type === "alive" && phase === "idle")
                channel.send(signLifetime(config, { ...proof, type: "active" }));
            }
          },
          () => {}
        );
      });
      const root = new ComputerRootLifetime({
        configuration: config,
        socketPath: path,
        now: lifetimeNow,
        healthy: () => true,
        failed
      });
      cleanups.push(() => root.stop());
      root.start();
      await expect.poll(() => failed.mock.calls.length, { timeout: 3000 }).toBe(1);
      expect(await root.stop()).toBe(false);
    }
  );
  it("root rejects challenge equality expiry before responding, without comparing peer clocks", async () => {
    const config = lifetimeConfiguration();
    let clock = 0;
    const failed = vi.fn();
    const replies: unknown[] = [];
    const path = await sockets((socket) => {
      const channel = new LifetimeChannel(
        socket,
        (value) => {
          replies.push(value);
          if (lifetimeHeader(value)) {
            clock = 2000;
            channel.send(
              signLifetime(config, {
                type: "challenge",
                version: 1,
                rootNonce: value.rootNonce,
                sessionNonce: lifetimeNonce(),
                challengeNonce: lifetimeNonce(),
                counter: 1
              })
            );
          }
        },
        () => {}
      );
    });
    const root = new ComputerRootLifetime({
      configuration: config,
      socketPath: path,
      now: () => clock,
      healthy: () => true,
      failed
    });
    cleanups.push(() => root.stop());
    root.start();
    await expect.poll(() => failed.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(replies).toHaveLength(1);
    expect(await root.stop()).toBe(false);
  });
  it.each(["nonce", "mac"])(
    "a replaced endpoint cannot forge a %s fencing acknowledgement",
    async (kind) => {
      const config = lifetimeConfiguration();
      let active!: () => void;
      const activation = new Promise<void>((resolve) => {
        active = resolve;
      });
      const path = await sockets((socket) => {
        const channel = new LifetimeChannel(
          socket,
          (value) => {
            if (lifetimeHeader(value))
              channel.send(
                signLifetime(config, {
                  type: "challenge",
                  version: 1,
                  rootNonce: value.rootNonce,
                  sessionNonce: lifetimeNonce(),
                  challengeNonce: lifetimeNonce(),
                  counter: 1
                })
              );
            else {
              const proof = verifyLifetime(config, value);
              if (proof.type === "alive")
                channel.send(signLifetime(config, { ...proof, type: "active" }));
              if (proof.type === "stop" && "stopNonce" in proof)
                channel.send(
                  signLifetime(kind === "mac" ? { ...config, secret: "0".repeat(64) } : config, {
                    ...proof,
                    type: "fenced",
                    stopNonce: kind === "nonce" ? lifetimeNonce() : proof.stopNonce
                  })
                );
            }
          },
          () => {}
        );
      });
      const root = new ComputerRootLifetime({
        configuration: config,
        socketPath: path,
        now: lifetimeNow,
        healthy: () => true,
        failed: () => {},
        activated: active
      });
      cleanups.push(() => root.stop());
      root.start();
      await activation;
      expect(await root.stop()).toBe(false);
    }
  );
});
