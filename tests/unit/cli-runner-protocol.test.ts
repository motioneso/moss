/**
 * cli-runner wire-protocol tests (§3): length-prefixed framing round-trip across
 * fragmented reads, the §3.6 mutual challenge-response hello (good secret connects,
 * bad/absent secret closes), and §3.7 malformed-frame-closes vs bad_request-stays-open.
 */
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  HELLO_PROOF_TAG_CLIENT,
  HELLO_PROOF_TAG_SERVER,
  MAX_FRAME_BYTES,
  type RpcErr,
  type RpcHelloChallenge,
  type RpcOk
} from "../../packages/chat/src/live/rpc-contract.js";
import {
  stepHelloServer,
  isHandshakeFrame,
  type HelloServerState
} from "../../packages/cli-runner/src/hello.js";
import {
  serveConnection,
  type ByteChannel,
  type ConnectionDeps
} from "../../packages/cli-runner/src/connection.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";
import { VerifiedSubmitError } from "../../packages/chat/src/live/cli-chat-engine.js";

const SECRET = "test-rpc-secret";
const BOOT = "boot-uuid-1";

function hmac(tag: string, nonce: string): string {
  return createHmac("sha256", SECRET)
    .update(tag + nonce)
    .digest("hex");
}

// ─── §3.2 framing ────────────────────────────────────────────────────────────────
describe("framing (§3.2)", () => {
  it("round-trips a multi-line body and reassembles across fragmented reads", () => {
    const frame = { t: "ok", id: 1, bootId: BOOT, result: { text: "line1\nline2\nline3" } };
    const encoded = encodeFrame(frame as RpcOk);

    // Feed the buffer one byte at a time; decodeFrame returns "incomplete" until the
    // full prefix + body are present, then the exact frame.
    let buf = Buffer.alloc(0);
    let decodedBody: Buffer | null = null;
    for (const byte of encoded) {
      buf = Buffer.concat([buf, Buffer.from([byte])]);
      const res = decodeFrame(buf);
      if (res.kind === "frame") {
        decodedBody = res.body;
        buf = buf.subarray(res.consumed);
      }
    }
    expect(decodedBody).not.toBeNull();
    expect(JSON.parse(decodedBody!.toString("utf8"))).toEqual(frame);
  });

  it("flags an oversize declared length (caller closes)", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const res = decodeFrame(header);
    expect(res.kind).toBe("oversize");
  });

  it("isHandshakeFrame only accepts the three hello discriminants", () => {
    expect(isHandshakeFrame({ t: "hello", clientNonce: "x" })).toBe(true);
    expect(isHandshakeFrame({ t: "req", id: 1 })).toBe(false);
    expect(isHandshakeFrame(null)).toBe(false);
  });
});

// ─── §3.6 hello state machine ─────────────────────────────────────────────────────
describe("hello handshake (§3.6)", () => {
  it("a correct mutual proof authenticates", () => {
    const state: HelloServerState = { phase: "await-hello", serverNonce: "" };
    const clientNonce = randomBytes(32).toString("hex");

    const step1 = stepHelloServer(state, { t: "hello", clientNonce }, SECRET);
    expect(step1.kind).toBe("send");
    const challenge = (step1 as { frame: RpcHelloChallenge }).frame;
    // Server proves it holds the secret over the client's nonce.
    expect(challenge.serverProof).toBe(hmac(HELLO_PROOF_TAG_SERVER, clientNonce));

    const clientProof = hmac(HELLO_PROOF_TAG_CLIENT, challenge.serverNonce);
    const step2 = stepHelloServer(state, { t: "hello-response", clientProof }, SECRET);
    expect(step2.kind).toBe("authenticated");
  });

  it("a wrong client proof closes (no error frame)", () => {
    const state: HelloServerState = { phase: "await-hello", serverNonce: "" };
    stepHelloServer(state, { t: "hello", clientNonce: "abc" }, SECRET);
    const step = stepHelloServer(state, { t: "hello-response", clientProof: "wrong" }, SECRET);
    expect(step.kind).toBe("close");
  });

  it("an unset secret always closes", () => {
    const state: HelloServerState = { phase: "await-hello", serverNonce: "" };
    expect(stepHelloServer(state, { t: "hello", clientNonce: "abc" }, undefined).kind).toBe(
      "close"
    );
  });

  it("a non-hello first frame closes", () => {
    const state: HelloServerState = { phase: "await-hello", serverNonce: "" };
    expect(stepHelloServer(state, { t: "hello-response", clientProof: "x" }, SECRET).kind).toBe(
      "close"
    );
  });
});

// ─── full connection: handshake → dispatch over a fake ByteChannel ────────────────

/** A scriptable in-memory ByteChannel that records what the server wrote. */
class FakeChannel implements ByteChannel {
  readonly written: Buffer[] = [];
  closed = false;
  private dataListener?: (chunk: Buffer) => void;
  private closeListener?: () => void;
  private drainListener?: () => void;

  write(buf: Buffer): void {
    if (this.closed) return;
    this.written.push(buf);
  }
  end(): void {
    this.closed = true;
    this.closeListener?.();
  }
  on(event: "data" | "close" | "error" | "drain", listener: (chunk: Buffer) => void): void {
    if (event === "data") this.dataListener = listener;
    else if (event === "drain") this.drainListener = listener as () => void;
    else this.closeListener = listener as () => void;
  }
  /** Push bytes "from the client". */
  feed(buf: Buffer): void {
    this.dataListener?.(buf);
  }
  /** Simulate the underlying socket firing "drain" after backpressure clears. */
  triggerDrain(): void {
    this.drainListener?.();
  }
  // #1059 [N2] — simulate the underlying socket firing "close" (e.g. the peer disconnected),
  // as distinct from `end()` which is the SERVER voluntarily ending the channel. serveConnection
  // registers the same `close` handler for both the socket's "close" and "error" events, so
  // invoking it here exercises exactly the connection-drop path the regression test needs.
  triggerClose(): void {
    this.closeListener?.();
  }
  /** Decode every complete frame the server has written so far. */
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

function fakeHost(): CliChatEngineHost {
  // A host whose listLiveSessions is stubbed; we only exercise dispatch routing here.
  const host = new CliChatEngineHost({
    io: {
      run: vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "" }),
      readFile: vi.fn().mockResolvedValue(""),
      writeFile: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined)
    },
    neutralBase: "/tmp/neutral-base",
    singleUser: true,
    cliPresent: async () => false
  });
  return host;
}

/** Run the client side of the handshake against a FakeChannel, returning once authed. */
function authenticate(channel: FakeChannel): void {
  const clientNonce = randomBytes(32).toString("hex");
  channel.feed(encodeFrame({ t: "hello", clientNonce }));
  // The server replied with the challenge; pull serverNonce and answer.
  const challenge = channel.decodeAll().find((f) => (f as { t?: string }).t === "hello-challenge");
  const serverNonce = (challenge as RpcHelloChallenge).serverNonce;
  channel.feed(
    encodeFrame({ t: "hello-response", clientProof: hmac(HELLO_PROOF_TAG_CLIENT, serverNonce) })
  );
}

describe("serveConnection (§3.4/§3.7)", () => {
  function deps(host = fakeHost()): ConnectionDeps {
    // #1059 — ConnectionDeps now requires terminalHost; this suite is scoped to the
    // pre-existing chat protocol methods, so a plain never-opened instance satisfies
    // the type without adding terminal-RPC behavior to these tests.
    return {
      host,
      bootId: BOOT,
      secret: SECRET,
      terminalHost: new TerminalHost({ homeBase: "/tmp", toolsBinDir: "/usr/bin" })
    };
  }

  it("listLiveSessions round-trips after a successful handshake", async () => {
    const host = fakeHost();
    vi.spyOn(host, "listLiveSessions").mockResolvedValue(["alice"]);
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);

    channel.feed(encodeFrame({ t: "req", id: 7, method: "listLiveSessions", params: {} }));
    await new Promise((r) => setTimeout(r, 5));

    const ok = channel.decodeAll().find((f) => (f as RpcOk).id === 7) as RpcOk;
    expect(ok.t).toBe("ok");
    expect(ok.bootId).toBe(BOOT);
    expect(ok.result).toEqual({ sessionKeys: ["alice"] });
  });

  // #2208: the model-list verb is non-session (no sessionKey) and every non-ok outcome is a normal
  // RpcOk result; only an unknown provider kind is a bad_request.
  it("listProviderModels dispatches non-session and returns the host's result verbatim", async () => {
    const host = fakeHost();
    const spy = vi
      .spyOn(host, "listProviderModels")
      .mockResolvedValue({ status: "ok", models: [{ id: "claude-fable-5-1" }] });
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);

    channel.feed(
      encodeFrame({
        t: "req",
        id: 21,
        method: "listProviderModels",
        params: { provider: "anthropic" }
      })
    );
    await new Promise((r) => setTimeout(r, 5));

    const ok = channel.decodeAll().find((f) => (f as RpcOk).id === 21) as RpcOk;
    expect(ok.t).toBe("ok");
    expect(ok.result).toEqual({ status: "ok", models: [{ id: "claude-fable-5-1" }] });
    expect(spy).toHaveBeenCalledWith("anthropic");

    channel.feed(
      encodeFrame({ t: "req", id: 22, method: "listProviderModels", params: { provider: "agy" } })
    );
    await new Promise((r) => setTimeout(r, 5));
    const err = channel.decodeAll().find((f) => (f as RpcErr).id === 22) as RpcErr;
    expect(err.error.code).toBe("bad_request");
    expect(channel.closed).toBe(false);
  });

  it("a readNew with an out-of-range afterOffset returns bad_request WITHOUT closing", async () => {
    const channel = new FakeChannel();
    serveConnection(channel, deps());
    authenticate(channel);

    channel.feed(
      encodeFrame({
        t: "req",
        id: 9,
        method: "readNew",
        sessionKey: "u1",
        params: { afterOffset: -1 }
      })
    );
    await new Promise((r) => setTimeout(r, 5));

    const err = channel.decodeAll().find((f) => (f as RpcErr).id === 9) as RpcErr;
    expect(err.t).toBe("err");
    expect(err.error.code).toBe("bad_request");
    expect(channel.closed).toBe(false); // connection stays open (§3.7)
  });

  it("a session method with a missing sessionKey returns bad_request (stays open)", async () => {
    const channel = new FakeChannel();
    serveConnection(channel, deps());
    authenticate(channel);

    channel.feed(encodeFrame({ t: "req", id: 11, method: "submit", params: { text: "hi" } }));
    await new Promise((r) => setTimeout(r, 5));

    const err = channel.decodeAll().find((f) => (f as RpcErr).id === 11) as RpcErr;
    expect(err.error.code).toBe("bad_request");
    expect(channel.closed).toBe(false);
  });

  it("rejects submit without a stable attemptId but keeps the connection open", async () => {
    const channel = new FakeChannel();
    serveConnection(channel, deps());
    authenticate(channel);

    channel.feed(
      encodeFrame({ t: "req", id: 12, method: "submit", sessionKey: "u1", params: { text: "hi" } })
    );
    await new Promise((r) => setTimeout(r, 5));

    const err = channel.decodeAll().find((f) => (f as RpcErr).id === 12) as RpcErr;
    expect(err.error.code).toBe("bad_request");
    expect(channel.closed).toBe(false);
  });

  it("dispatches cancelSubmit outside host serialization and returns ok", async () => {
    const host = fakeHost();
    const cancel = vi.spyOn(host, "cancelSubmit").mockResolvedValue(undefined);
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);
    const attemptId = "11111111-1111-4111-8111-111111111111";

    channel.feed(
      encodeFrame({
        t: "req",
        id: 13,
        method: "cancelSubmit",
        sessionKey: "u1",
        params: { attemptId }
      })
    );
    await new Promise((r) => setTimeout(r, 5));

    expect(cancel).toHaveBeenCalledWith("u1", { attemptId });
    const ok = channel.decodeAll().find((f) => (f as RpcOk).id === 13) as RpcOk;
    expect(ok.result).toEqual({ ok: true });
  });

  it("maps a post-Enter verified submit failure to delivery_unknown", async () => {
    const host = fakeHost();
    vi.spyOn(host, "submit").mockRejectedValue(new VerifiedSubmitError("delivery_unknown", true));
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);

    channel.feed(
      encodeFrame({
        t: "req",
        id: 14,
        method: "submit",
        sessionKey: "u1",
        params: {
          attemptId: "22222222-2222-4222-8222-222222222222",
          text: "hi"
        }
      })
    );
    await new Promise((r) => setTimeout(r, 5));

    const err = channel.decodeAll().find((f) => (f as RpcErr).id === 14) as RpcErr;
    expect(err.error.code).toBe("delivery_unknown");
  });

  it("requires replayAttemptId exactly when launch carries non-empty replay", async () => {
    const channel = new FakeChannel();
    serveConnection(channel, deps());
    authenticate(channel);

    channel.feed(
      encodeFrame({
        t: "req",
        id: 15,
        method: "launch",
        sessionKey: "u1",
        params: { provider: "anthropic", personaText: "persona", replayBatch: "history" }
      })
    );
    channel.feed(
      encodeFrame({
        t: "req",
        id: 16,
        method: "launch",
        sessionKey: "u1",
        params: {
          provider: "anthropic",
          personaText: "persona",
          replayAttemptId: "33333333-3333-4333-8333-333333333333"
        }
      })
    );
    await new Promise((r) => setTimeout(r, 5));

    const frames = channel.decodeAll() as RpcErr[];
    expect(frames.find((frame) => frame.id === 15)?.error.code).toBe("bad_request");
    expect(frames.find((frame) => frame.id === 16)?.error.code).toBe("bad_request");
  });

  it("an unauthenticated request frame (no hello) closes the connection", () => {
    const channel = new FakeChannel();
    serveConnection(channel, deps());
    // Skip the handshake; send a request immediately → malformed first frame (§3.7).
    channel.feed(encodeFrame({ t: "req", id: 1, method: "listLiveSessions", params: {} }));
    expect(channel.closed).toBe(true);
  });

  it("a malformed (non-JSON) frame body closes the connection", () => {
    const channel = new FakeChannel();
    serveConnection(channel, deps());
    authenticate(channel);
    // Hand-craft a frame whose body is not valid JSON.
    const body = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    channel.feed(Buffer.concat([header, body]));
    expect(channel.closed).toBe(true);
  });
});

// ─── #1554 Decision 2 — sessionReaped push (RPC topology's server → client reap notice) ──────────
describe("serveConnection sessionReaped push (#1554 Decision 2)", () => {
  function deps(host: CliChatEngineHost): ConnectionDeps {
    return {
      host,
      bootId: BOOT,
      secret: SECRET,
      terminalHost: new TerminalHost({ homeBase: "/tmp", toolsBinDir: "/usr/bin" })
    };
  }

  // Plan test case 2 (RPC topology): the pool's `onReap` fires host-side via
  // `host.notifySessionReaped` (task #5 wires the pool itself; here we simulate that call
  // directly, mirroring the registry's own contract) — asserts an
  // `RpcPush{channel:"sessionReaped"}` frame was written to a live connection. Fails against an
  // impl that reaps locally in cli-runner without ever notifying the API side.
  it("a connected client receives a sessionReaped push when the host notifies a reap", async () => {
    const host = fakeHost();
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);

    host.notifySessionReaped("sess-1", "idle-timeout");

    const push = channel
      .decodeAll()
      .find((f) => (f as { t?: string; channel?: string }).channel === "sessionReaped") as {
      t: string;
      bootId: string;
      channel: string;
      sessionKey: string;
      reapReason: string;
    };
    expect(push).toBeDefined();
    expect(push.t).toBe("push");
    expect(push.bootId).toBe(BOOT);
    expect(push.sessionKey).toBe("sess-1");
    expect(push.reapReason).toBe("idle-timeout");
  });

  it("a closed connection's reap listener is unregistered — a later notify writes nothing to it", async () => {
    const host = fakeHost();
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);
    const framesBeforeClose = channel.written.length;

    channel.triggerClose();
    host.notifySessionReaped("sess-2", "shutdown");

    // No NEW sessionReaped push should have been written after close — the listener was
    // deregistered symmetrically with `ownedTerminalId`'s close-time teardown.
    const pushesAfter = channel
      .decodeAll()
      .slice(framesBeforeClose)
      .filter((f) => (f as { channel?: string }).channel === "sessionReaped");
    expect(pushesAfter.length).toBe(0);
  });
});

// ─── #1059 [N2] — connection-scoped terminal kill on close ────────────────────────
//
// TerminalHost is a process-wide singleton shared across every connection (constructed once
// in main.ts/server.ts). Before this fix, connection.ts's close() called `terminalHost.killAll()`
// unconditionally, so ANY connection dropping — a stale socket, a close-and-reopen race, a
// second admin's tab closing — tore down whichever terminal happened to be live, even if it
// belonged to a completely different connection. This suite drives two `serveConnection`
// instances against ONE shared (fake-session, no real PTY) TerminalHost to prove close() now
// scopes its kill to only the terminal THIS connection opened.
function fakeSession(id: string) {
  const listeners: Array<(b: Buffer) => void> = [];
  return {
    id,
    killed: false,
    onData: (cb: (b: Buffer) => void) => listeners.push(cb),
    onExit: (_: (c: number) => void) => {},
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(function (this: { killed: boolean }) {
      this.killed = true;
    }),
    _emit: (s: string) => listeners.forEach((l) => l(Buffer.from(s)))
  };
}

describe("connection-scoped terminal kill on close (#1059 [N2])", () => {
  it("closing connection A kills only A's terminal; B's live terminal survives until B closes", async () => {
    const made: ReturnType<typeof fakeSession>[] = [];
    const terminalHost = new TerminalHost({
      homeBase: "/tmp",
      toolsBinDir: "/usr/bin",
      makeSession: (o) => {
        const s = fakeSession(o.id);
        made.push(s);
        return s as never;
      }
    });
    const killSpy = vi.spyOn(terminalHost, "kill");
    const killAllSpy = vi.spyOn(terminalHost, "killAll");

    const channelA = new FakeChannel();
    const channelB = new FakeChannel();
    const depsFor = (): ConnectionDeps => ({
      host: fakeHost(),
      bootId: BOOT,
      secret: SECRET,
      terminalHost
    });
    serveConnection(channelA, depsFor());
    serveConnection(channelB, depsFor());
    authenticate(channelA);
    authenticate(channelB);

    channelA.feed(
      encodeFrame({ t: "req", id: 1, method: "openTerminal", params: { cols: 80, rows: 24 } })
    );
    await new Promise((r) => setTimeout(r, 5));
    const openA = channelA.decodeAll().find((f) => (f as RpcOk).id === 1) as RpcOk;
    const terminalIdA = (openA.result as { terminalId: string }).terminalId;

    // B's open EVICTS A via TerminalHost.open's own internal killAll — that eviction-on-open
    // behavior is unchanged by this fix (only close-time teardown becomes per-connection).
    channelB.feed(
      encodeFrame({ t: "req", id: 1, method: "openTerminal", params: { cols: 80, rows: 24 } })
    );
    await new Promise((r) => setTimeout(r, 5));
    const openB = channelB.decodeAll().find((f) => (f as RpcOk).id === 1) as RpcOk;
    const terminalIdB = (openB.result as { terminalId: string }).terminalId;

    const sessionA = made[0];
    const sessionB = made[1];
    if (!sessionA || !sessionB) throw new Error("expected two fake sessions to have been made");

    expect(sessionA.killed).toBe(true); // A's session, evicted by B's open (unchanged behavior)
    expect(sessionB.killed).toBe(false); // B's session — the current live one

    const killAllCallsBeforeCloses = killAllSpy.mock.calls.length;

    // A's connection drops (e.g. socket close/error). Its close() must scope its kill to A's
    // OWN terminalId — which is already evicted/stale, so this is a safe no-op — and must NOT
    // call killAll() (which would tear down B's live session).
    channelA.triggerClose();
    expect(killSpy).toHaveBeenCalledWith({ terminalId: terminalIdA });
    expect(killAllSpy.mock.calls.length).toBe(killAllCallsBeforeCloses); // no new killAll call
    expect(sessionB.killed).toBe(false); // B's live session survives A's close

    // B's connection now drops — its close() kills ITS OWN (still-live) terminal.
    channelB.triggerClose();
    expect(killSpy).toHaveBeenCalledWith({ terminalId: terminalIdB });
    expect(killAllSpy.mock.calls.length).toBe(killAllCallsBeforeCloses); // still no killAll call
    expect(sessionB.killed).toBe(true);
  });

  it("a connection that never opened a terminal calls neither kill() nor killAll() on close", () => {
    const terminalHost = new TerminalHost({ homeBase: "/tmp", toolsBinDir: "/usr/bin" });
    const killSpy = vi.spyOn(terminalHost, "kill");
    const killAllSpy = vi.spyOn(terminalHost, "killAll");
    const channel = new FakeChannel();
    serveConnection(channel, { host: fakeHost(), bootId: BOOT, secret: SECRET, terminalHost });
    authenticate(channel);

    channel.triggerClose();

    expect(killSpy).not.toHaveBeenCalled();
    expect(killAllSpy).not.toHaveBeenCalled();
  });
});
