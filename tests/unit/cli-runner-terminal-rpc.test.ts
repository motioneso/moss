/**
 * Terminal RPC dispatch integration (#1059): drives `serveConnection` directly through an
 * in-memory FakeChannel (the repo precedent — see tests/unit/cli-runner-server.test.ts —
 * avoids Unix-socket flakiness) with a REAL `TerminalHost` (real node-pty PTY, no mocks).
 * Exercises the actual wire path: openTerminal → writeTerminal → real shell echo →
 * server-push `terminalData` frame, end to end.
 */
import { createHmac, randomBytes } from "node:crypto";
import * as os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  serveConnection,
  type ByteChannel,
  type ConnectionDeps
} from "../../packages/cli-runner/src/connection.js";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";
import type { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import {
  decodeFrame,
  encodeFrame,
  HELLO_PROOF_TAG_CLIENT,
  type RpcErr,
  type RpcHelloChallenge,
  type RpcOk,
  type RpcPush,
  type RpcPushTerminalData
} from "../../packages/chat/src/live/rpc-contract.js";

afterEach(() => vi.restoreAllMocks());

const RPC_SECRET = "terminal-rpc-test-secret";
const BOOT_ID = "boot-terminal-rpc-test";

function hmacClient(nonce: string): string {
  return createHmac("sha256", RPC_SECRET)
    .update(HELLO_PROOF_TAG_CLIENT + nonce)
    .digest("hex");
}

/** A scriptable in-memory ByteChannel that records what the server wrote (repo precedent —
 * see the identically-named helper in tests/unit/cli-runner-server.test.ts). */
class FakeChannel implements ByteChannel {
  readonly written: Buffer[] = [];
  closed = false;
  private dataListener?: (chunk: Buffer) => void;
  private closeListener?: () => void;
  private drainListener?: () => void;
  /** #1526 — when set, the NEXT write() call consumes this scripted outcome instead of
   * succeeding normally: "backpressure" returns false (bytes still recorded — a real
   * backpressured socket still accepted and buffered the write), "throw" throws (bytes NOT
   * recorded — a real thrown write never made it to the wire). */
  private nextWriteOutcome: "backpressure" | "throw" | undefined;
  private closeWaiters: Array<() => void> = [];

  write(buf: Buffer): boolean {
    if (this.closed) return true;
    if (this.nextWriteOutcome === "throw") {
      this.nextWriteOutcome = undefined;
      throw new Error("simulated EPIPE");
    }
    this.written.push(buf);
    if (this.nextWriteOutcome === "backpressure") {
      this.nextWriteOutcome = undefined;
      return false;
    }
    return true;
  }
  end(): void {
    this.closed = true;
    this.closeListener?.();
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const waiter of waiters) waiter();
  }
  /** Resolves the instant end() is called (or immediately if already closed) — event-driven,
   * so callers don't need to poll on a fixed interval/attempt budget. */
  waitForClose(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }
  on(event: "data" | "close" | "error" | "drain", listener: (chunk: Buffer) => void): void {
    if (event === "data") this.dataListener = listener;
    else if (event === "drain") this.drainListener = listener as () => void;
    else this.closeListener = listener as () => void;
  }
  feed(buf: Buffer): void {
    this.dataListener?.(buf);
  }
  /** Script the very next write() call to report backpressure or throw. */
  scriptNextWrite(outcome: "backpressure" | "throw"): void {
    this.nextWriteOutcome = outcome;
  }
  triggerDrain(): void {
    this.drainListener?.();
  }
  decodeAll(): unknown[] {
    let buf = Buffer.concat(this.written);
    const out: unknown[] = [];
    for (;;) {
      const res = decodeFrame(buf);
      if (res.kind !== "frame") break;
      out.push(JSON.parse(res.body.toString("utf8")));
      buf = buf.subarray(res.consumed);
    }
    return out;
  }
}

/** Drive the client side of the §3.6 handshake against a FakeChannel until authed. */
function authenticate(channel: FakeChannel): void {
  const clientNonce = randomBytes(32).toString("hex");
  channel.feed(encodeFrame({ t: "hello", clientNonce }));
  const challenge = channel
    .decodeAll()
    .find((f) => (f as { t?: string }).t === "hello-challenge") as RpcHelloChallenge;
  channel.feed(
    encodeFrame({ t: "hello-response", clientProof: hmacClient(challenge.serverNonce) })
  );
}

/** A minimal CliChatEngineHost stub — the terminal RPC path never calls into it, but
 * ConnectionDeps requires one. Every method throws if unexpectedly invoked. */
function makeStubHost(): CliChatEngineHost {
  const unexpected = (name: string) => () => {
    throw new Error(`unexpected host.${name} call in terminal-rpc test`);
  };
  return {
    startupSweep: vi.fn().mockResolvedValue(undefined),
    launch: unexpected("launch"),
    submit: unexpected("submit"),
    cancelSubmit: unexpected("cancelSubmit"),
    readNew: unexpected("readNew"),
    isAlive: unexpected("isAlive"),
    kill: unexpected("kill"),
    purgeTranscripts: unexpected("purgeTranscripts"),
    interrupt: unexpected("interrupt"),
    listLiveSessions: unexpected("listLiveSessions"),
    probeProvider: unexpected("probeProvider"),
    installProvider: unexpected("installProvider"),
    beginLogin: unexpected("beginLogin"),
    pollLogin: unexpected("pollLogin"),
    submitLoginToken: unexpected("submitLoginToken"),
    cancelLogin: unexpected("cancelLogin"),
    reapStaleLogins: vi.fn().mockResolvedValue(undefined),
    // #1554 Decision 2 — serveConnection now unconditionally registers a reap listener on
    // every connection; the terminal RPC path never triggers a reap, but the stub must still
    // satisfy the call.
    addSessionReapedListener: vi.fn().mockReturnValue(() => {}),
    notifySessionReaped: unexpected("notifySessionReaped")
  } as unknown as CliChatEngineHost;
}

describe("terminal RPC dispatch (#1059)", () => {
  it("open -> write(echo) -> real PTY -> terminalData push frame carrying the echoed bytes", async () => {
    const terminalHost = new TerminalHost({ homeBase: os.tmpdir(), toolsBinDir: "/usr/bin" });
    const channel = new FakeChannel();
    const deps: ConnectionDeps = {
      host: makeStubHost(),
      bootId: BOOT_ID,
      secret: RPC_SECRET,
      terminalHost
    };

    try {
      serveConnection(channel, deps);
      authenticate(channel);

      // openTerminal -> expect RpcOk carrying a string terminalId.
      channel.feed(
        encodeFrame({ t: "req", id: 1, method: "openTerminal", params: { cols: 80, rows: 24 } })
      );
      await new Promise((r) => setTimeout(r, 50));
      const openOk = channel.decodeAll().find((f) => (f as RpcOk).id === 1) as RpcOk;
      expect(openOk).toBeDefined();
      expect(openOk.t).toBe("ok");
      const terminalId = (openOk.result as { terminalId: string }).terminalId;
      expect(typeof terminalId).toBe("string");
      expect(terminalId.length).toBeGreaterThan(0);

      // writeTerminal("echo hi_1059\n") -> the real shell echoes it back asynchronously.
      channel.feed(
        encodeFrame({
          t: "req",
          id: 2,
          method: "writeTerminal",
          params: { terminalId, dataB64: Buffer.from("echo hi_1059\n").toString("base64") }
        })
      );

      // The PTY echo is async — poll for up to ~2s (matching TerminalSession's ~800ms
      // stable timing, with margin) rather than a single fixed sleep.
      let pushFrame: RpcPushTerminalData | undefined;
      for (let attempt = 0; attempt < 20 && !pushFrame; attempt++) {
        await new Promise((r) => setTimeout(r, 100));
        pushFrame = channel.decodeAll().find((f) => {
          const push = f as RpcPush;
          if (push.t !== "push" || push.channel !== "terminalData" || !push.dataB64) return false;
          return Buffer.from(push.dataB64, "base64").toString("utf8").includes("hi_1059");
        }) as RpcPushTerminalData | undefined;
      }
      expect(pushFrame).toBeDefined();
      expect(pushFrame!.bootId).toBe(BOOT_ID);
      expect(pushFrame!.terminalId).toBe(terminalId);

      // killTerminal — cleanup; the RpcOk assures dispatch handled the 4th method too.
      channel.feed(
        encodeFrame({ t: "req", id: 3, method: "killTerminal", params: { terminalId } })
      );
      await new Promise((r) => setTimeout(r, 20));
      const killOk = channel.decodeAll().find((f) => (f as RpcOk).id === 3) as RpcOk;
      expect(killOk).toBeDefined();
      expect(killOk.t).toBe("ok");
    } finally {
      // Belt-and-suspenders: ensure no orphan PTY survives this test regardless of assertion outcome.
      terminalHost.killAll();
    }
  }, 10_000);

  it("rejects openTerminal with non-integer cols/rows as bad_request, without opening a PTY", async () => {
    const terminalHost = new TerminalHost({ homeBase: os.tmpdir(), toolsBinDir: "/usr/bin" });
    const channel = new FakeChannel();
    const deps: ConnectionDeps = {
      host: makeStubHost(),
      bootId: BOOT_ID,
      secret: RPC_SECRET,
      terminalHost
    };

    try {
      serveConnection(channel, deps);
      authenticate(channel);

      channel.feed(
        encodeFrame({ t: "req", id: 1, method: "openTerminal", params: { cols: 0, rows: 24 } })
      );
      await new Promise((r) => setTimeout(r, 20));

      const err = channel.decodeAll().find((f) => (f as RpcErr).id === 1) as RpcErr;
      expect(err).toBeDefined();
      expect(err.t).toBe("err");
      expect(err.error.code).toBe("bad_request");
    } finally {
      terminalHost.killAll();
    }
  });

  it("a false write on the terminalData push does not close the connection or drop bytes, and a later drain does not throw (#1526)", async () => {
    const terminalHost = new TerminalHost({ homeBase: os.tmpdir(), toolsBinDir: "/usr/bin" });
    const channel = new FakeChannel();
    const deps: ConnectionDeps = {
      host: makeStubHost(),
      bootId: BOOT_ID,
      secret: RPC_SECRET,
      terminalHost
    };

    try {
      serveConnection(channel, deps);
      authenticate(channel);

      channel.feed(
        encodeFrame({ t: "req", id: 1, method: "openTerminal", params: { cols: 80, rows: 24 } })
      );
      await new Promise((r) => setTimeout(r, 50));
      const openOk = channel.decodeAll().find((f) => (f as RpcOk).id === 1) as RpcOk;
      const terminalId = (openOk.result as { terminalId: string }).terminalId;

      channel.feed(
        encodeFrame({
          t: "req",
          id: 2,
          method: "writeTerminal",
          params: { terminalId, dataB64: Buffer.from("echo hi_1526\n").toString("base64") }
        })
      );
      // Wait for the writeTerminal RpcOk so the scripted outcome below targets the
      // async terminalData push, not this synchronous response frame.
      let writeOk: RpcOk | undefined;
      for (let attempt = 0; attempt < 20 && !writeOk; attempt++) {
        await new Promise((r) => setTimeout(r, 20));
        writeOk = channel.decodeAll().find((f) => (f as RpcOk).id === 2) as RpcOk | undefined;
      }
      expect(writeOk).toBeDefined();
      channel.scriptNextWrite("backpressure");

      let pushFrame: RpcPushTerminalData | undefined;
      for (let attempt = 0; attempt < 20 && !pushFrame; attempt++) {
        await new Promise((r) => setTimeout(r, 100));
        pushFrame = channel.decodeAll().find((f) => {
          const push = f as RpcPush;
          if (push.t !== "push" || push.channel !== "terminalData" || !push.dataB64) return false;
          return Buffer.from(push.dataB64, "base64").toString("utf8").includes("hi_1526");
        }) as RpcPushTerminalData | undefined;
      }
      // The bytes still arrived (write() === false means "buffer full", not "dropped") and the
      // connection was not closed by the false return.
      expect(pushFrame).toBeDefined();
      expect(channel.closed).toBe(false);

      // A drain for the still-live terminal must not throw or misbehave.
      expect(() => channel.triggerDrain()).not.toThrow();

      channel.feed(
        encodeFrame({ t: "req", id: 3, method: "killTerminal", params: { terminalId } })
      );
      await new Promise((r) => setTimeout(r, 20));
      const killOk = channel.decodeAll().find((f) => (f as RpcOk).id === 3) as RpcOk;
      expect(killOk).toBeDefined();
      expect(killOk.t).toBe("ok");
    } finally {
      terminalHost.killAll();
    }
  }, 10_000);

  it("a thrown write on the terminalData push closes the connection and kills the connection-owned terminal (#1526)", async () => {
    // Explicit per-test timeout above the inner 10s wait-for-close race below — otherwise
    // vitest's default per-test timeout can also be ~10s, and on a slow CI runner the outer
    // timeout can fire first with a generic "test timed out" instead of the inner, clearer one.
    const terminalHost = new TerminalHost({ homeBase: os.tmpdir(), toolsBinDir: "/usr/bin" });
    const channel = new FakeChannel();
    const deps: ConnectionDeps = {
      host: makeStubHost(),
      bootId: BOOT_ID,
      secret: RPC_SECRET,
      terminalHost
    };

    try {
      serveConnection(channel, deps);
      authenticate(channel);

      channel.feed(
        encodeFrame({ t: "req", id: 1, method: "openTerminal", params: { cols: 80, rows: 24 } })
      );
      await new Promise((r) => setTimeout(r, 50));
      const openOk = channel.decodeAll().find((f) => (f as RpcOk).id === 1) as RpcOk;
      const terminalId = (openOk.result as { terminalId: string }).terminalId;

      channel.feed(
        encodeFrame({
          t: "req",
          id: 2,
          method: "writeTerminal",
          params: { terminalId, dataB64: Buffer.from("echo hi_1526_err\n").toString("base64") }
        })
      );
      let writeOk: RpcOk | undefined;
      for (let attempt = 0; attempt < 20 && !writeOk; attempt++) {
        await new Promise((r) => setTimeout(r, 20));
        writeOk = channel.decodeAll().find((f) => (f as RpcOk).id === 2) as RpcOk | undefined;
      }
      expect(writeOk).toBeDefined();
      channel.scriptNextWrite("throw");

      // Wait for the actual close event rather than polling on a fixed budget — the throw
      // happens on the async PTY echo, whenever the real shell gets around to it. The outer
      // timeout is just a backstop so a real regression still fails the test instead of hanging.
      await Promise.race([
        channel.waitForClose(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for connection close")), 10_000)
        )
      ]);
      expect(channel.closed).toBe(true);

      // The connection-owned terminal must be dead too — a further write is a no-op, proven by
      // no new terminalData push arriving for text sent after close.
      const beforeCount = channel.decodeAll().length;
      terminalHost.write({
        terminalId,
        dataB64: Buffer.from("echo should_not_echo\n").toString("base64")
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(channel.decodeAll().length).toBe(beforeCount);
    } finally {
      terminalHost.killAll();
    }
  }, 15_000);
});
