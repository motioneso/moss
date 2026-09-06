/**
 * Unit tests for the api-side RPC client (#342, Lane A): length-prefixed framing encode/decode,
 * id-matching over one connection, the §3.6 mutual challenge-response hello, §5.6 bootId-change
 * reconciliation, malformed-frame-closes vs bad_request-stays-open (§3.7), and the §3.1 realpath
 * rejection of a socket outside /run/jarv1s.
 *
 * The hello + round-trip tests run against a tiny in-process Unix-socket FAKE SERVER that speaks the
 * frozen wire protocol. Because the realpath guard (§3.1) requires the socket to live under
 * /run/jarv1s — which is not writable in a unit-test sandbox — those tests construct the
 * RpcConnection with the guard relaxed by pointing it at a real temp socket and asserting the guard
 * separately. The pure framing/error tests need no socket at all.
 */
import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
  FRAME_HEADER_BYTES,
  HELLO_PROOF_TAG_CLIENT,
  HELLO_PROOF_TAG_SERVER,
  type RpcFrame
} from "../../packages/chat/src/live/rpc-contract.js";
import {
  ChatEngineRpcClient,
  RpcConnection,
  mapRpcError,
  SOCKET_ALLOWED_DIR
} from "../../packages/chat/src/live/chat-engine-rpc-client.js";
import {
  CliChatDeliveryUnknownError,
  CliChatUnavailableError
} from "../../packages/chat/src/live/errors.js";

function submitParams(text: string) {
  return { attemptId: "99999999-9999-4999-8999-999999999999", text };
}

// ──────────────────────────────────────────────────────────────────────────────
// §3.2 framing encode/decode
// ──────────────────────────────────────────────────────────────────────────────

describe("rpc framing (§3.2)", () => {
  it("round-trips a frame through encode → decode", () => {
    const frame: RpcFrame = {
      t: "req",
      id: 7,
      method: "submit",
      sessionKey: "u1",
      params: { text: "hi" }
    };
    const buf = encodeFrame(frame);
    expect(buf.readUInt32BE(0)).toBe(buf.length - FRAME_HEADER_BYTES);

    const decoded = decodeFrame(buf);
    expect(decoded.kind).toBe("frame");
    if (decoded.kind !== "frame") throw new Error("unreachable");
    expect(JSON.parse(decoded.body.toString("utf8"))).toEqual(frame);
    expect(decoded.consumed).toBe(buf.length);
  });

  it("round-trips multi-line transcript text without delimiter ambiguity", () => {
    const text = 'line one\nline two\n\twith tabs\n{"json":true}\nend';
    const frame: RpcFrame = {
      t: "ok",
      id: 1,
      bootId: "boot-a",
      result: { records: [{ kind: "reply", text }], offset: 42, complete: true }
    };
    const decoded = decodeFrame(encodeFrame(frame));
    if (decoded.kind !== "frame") throw new Error("expected a frame");
    const parsed = JSON.parse(decoded.body.toString("utf8")) as {
      result: { records: { text: string }[] };
    };
    expect(parsed.result.records[0]?.text).toBe(text);
  });

  it("returns incomplete until the full prefix + body are buffered (fragmentation)", () => {
    const buf = encodeFrame({
      t: "kill",
      id: 1,
      bootId: "b",
      result: undefined
    } as unknown as RpcFrame);
    // Only the first 2 header bytes → incomplete.
    expect(decodeFrame(buf.subarray(0, 2)).kind).toBe("incomplete");
    // Header present but body truncated → incomplete.
    expect(decodeFrame(buf.subarray(0, FRAME_HEADER_BYTES + 1)).kind).toBe("incomplete");
    // Whole frame → frame.
    expect(decodeFrame(buf).kind).toBe("frame");
  });

  it("decodes two concatenated frames one at a time", () => {
    const a = encodeFrame({ t: "req", id: 1, method: "isAlive", sessionKey: "u", params: {} });
    const b = encodeFrame({ t: "req", id: 2, method: "kill", sessionKey: "u", params: {} });
    let buf = Buffer.concat([a, b]);

    const first = decodeFrame(buf);
    if (first.kind !== "frame") throw new Error("expected first frame");
    expect(JSON.parse(first.body.toString("utf8")).id).toBe(1);
    buf = buf.subarray(first.consumed);

    const second = decodeFrame(buf);
    if (second.kind !== "frame") throw new Error("expected second frame");
    expect(JSON.parse(second.body.toString("utf8")).id).toBe(2);
    expect(buf.subarray(second.consumed).length).toBe(0);
  });

  // Review B4 follow-up — the two new one-shot structured-call methods, plus "launch" carrying the
  // new optional schema field, round-trip through the same length-prefixed wire format as every
  // other method.
  it("round-trips a submitStructured request frame through encode → decode", () => {
    const frame: RpcFrame = {
      t: "req",
      id: 5,
      method: "submitStructured",
      sessionKey: "u1",
      params: { text: "extract the signals" }
    };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded.kind).toBe("frame");
    if (decoded.kind !== "frame") throw new Error("unreachable");
    expect(JSON.parse(decoded.body.toString("utf8"))).toEqual(frame);
  });

  it("round-trips a readStructured request and result frame through encode → decode", () => {
    const reqFrame: RpcFrame = {
      t: "req",
      id: 6,
      method: "readStructured",
      sessionKey: "u1",
      params: { afterOffset: 12 }
    };
    const reqDecoded = decodeFrame(encodeFrame(reqFrame));
    expect(reqDecoded.kind).toBe("frame");
    if (reqDecoded.kind !== "frame") throw new Error("unreachable");
    expect(JSON.parse(reqDecoded.body.toString("utf8"))).toEqual(reqFrame);

    const resultFrame: RpcFrame = {
      t: "ok",
      id: 6,
      bootId: "boot-a",
      result: { text: '{"confidence":1}', offset: 30, complete: true }
    };
    const resultDecoded = decodeFrame(encodeFrame(resultFrame));
    expect(resultDecoded.kind).toBe("frame");
    if (resultDecoded.kind !== "frame") throw new Error("unreachable");
    expect(JSON.parse(resultDecoded.body.toString("utf8"))).toEqual(resultFrame);
  });

  it("round-trips a launch request carrying the structured-call schema field", () => {
    const frame: RpcFrame = {
      t: "req",
      id: 7,
      method: "launch",
      sessionKey: "u1",
      params: {
        neutralDir: "/unused",
        personaPath: "/unused/persona.md",
        schema: { type: "object", properties: { confidence: { type: "number" } } }
      }
    } as unknown as RpcFrame;
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded.kind).toBe("frame");
    if (decoded.kind !== "frame") throw new Error("unreachable");
    expect(JSON.parse(decoded.body.toString("utf8"))).toEqual(frame);
  });

  it("reports oversize when the declared length exceeds MAX_FRAME_BYTES (§3.7 → close)", () => {
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const decoded = decodeFrame(header);
    expect(decoded.kind).toBe("oversize");
    if (decoded.kind === "oversize") expect(decoded.declaredLength).toBe(MAX_FRAME_BYTES + 1);
  });

  it("encodeFrame throws on an un-framable oversize body", () => {
    const huge = "x".repeat(MAX_FRAME_BYTES + 10);
    expect(() =>
      encodeFrame({ t: "submit", id: 1, bootId: "b", result: { huge } } as unknown as RpcFrame)
    ).toThrow();
  });
});

describe("verified-submit RPC client", () => {
  it("maps delivery_unknown to a distinct non-retryable error", () => {
    expect(mapRpcError("delivery_unknown", "unknown")).toBeInstanceOf(CliChatDeliveryUnknownError);
  });

  it("generates an attempt UUID above transport for each logical engine submit", async () => {
    const submit = vi.fn().mockResolvedValue({ ok: true });
    const client = new ChatEngineRpcClient("anthropic", "u1", {
      submit
    } as unknown as RpcConnection);

    await client.submit("hello");

    expect(submit).toHaveBeenCalledWith("u1", {
      attemptId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      text: "hello"
    });
  });

  it("generates a replay attempt UUID exactly when launch carries replay", async () => {
    const launch = vi.fn().mockResolvedValue({ offset: 4 });
    const client = new ChatEngineRpcClient("anthropic", "u1", {
      launch
    } as unknown as RpcConnection);

    await client.launch({
      neutralDir: "/unused",
      personaPath: "/unused/persona.md",
      personaText: "persona",
      replayBatch: "history"
    });

    expect(launch).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        replayBatch: "history",
        replayAttemptId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        )
      })
    );
  });

  // #1554 — the api half of the live-reload channel: the cli-runner has no DB access, so every
  // launch must carry a FRESH read of the three persistent-runtime settings (plan, "Settings &
  // flags"). A settings read that throws must degrade the launch to persistent-off, never fail it.
  it("carries a fresh read of the persistent-runtime settings on every launch", async () => {
    const launch = vi.fn().mockResolvedValue({ offset: 0 });
    let enabled = true;
    const client = new ChatEngineRpcClient(
      "anthropic",
      "u1",
      { launch } as unknown as RpcConnection,
      "interactive",
      async () => ({ enabled, poolCap: 6, idleReapMinutes: 15 })
    );

    await client.launch({ neutralDir: "/unused", personaPath: "/unused/p.md", personaText: "p" });
    expect(launch).toHaveBeenLastCalledWith(
      "u1",
      expect.objectContaining({
        persistentRuntimeEnabled: true,
        persistentPoolCap: 6,
        persistentIdleReapMinutes: 15
      })
    );

    enabled = false; // operator flips the setting off — no restart
    await client.launch({ neutralDir: "/unused", personaPath: "/unused/p.md", personaText: "p" });
    expect(launch).toHaveBeenLastCalledWith(
      "u1",
      expect.objectContaining({ persistentRuntimeEnabled: false })
    );
  });

  it("falls back to persistent-off when the settings read throws", async () => {
    const launch = vi.fn().mockResolvedValue({ offset: 0 });
    const client = new ChatEngineRpcClient(
      "anthropic",
      "u1",
      { launch } as unknown as RpcConnection,
      "interactive",
      async () => {
        throw new Error("db down");
      }
    );

    await client.launch({ neutralDir: "/unused", personaPath: "/unused/p.md", personaText: "p" });

    expect(launch).toHaveBeenLastCalledWith(
      "u1",
      expect.objectContaining({ persistentRuntimeEnabled: false })
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// §4.7 error mapping
// ──────────────────────────────────────────────────────────────────────────────

describe("rpc error mapping (§4.7)", () => {
  it("maps unavailable + not_launched to a retryable CliChatUnavailableError", () => {
    expect(mapRpcError("unavailable", "down")).toBeInstanceOf(CliChatUnavailableError);
    expect(mapRpcError("not_launched", "no engine")).toBeInstanceOf(CliChatUnavailableError);
  });

  it("maps bad_request + internal to a plain Error", () => {
    expect(mapRpcError("bad_request", "bad offset")).toBeInstanceOf(Error);
    expect(mapRpcError("bad_request", "bad offset")).not.toBeInstanceOf(CliChatUnavailableError);
    expect(mapRpcError("internal", "boom")).not.toBeInstanceOf(CliChatUnavailableError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// §3.1 realpath rejection of an out-of-dir socket path
// ──────────────────────────────────────────────────────────────────────────────

describe("rpc socket realpath guard (§3.1)", () => {
  it("exposes the allowed dir", () => {
    expect(SOCKET_ALLOWED_DIR).toBe("/run/jarv1s");
  });

  it("rejects (CliChatUnavailableError, no connect) a socket path outside /run/jarv1s", async () => {
    const conn = new RpcConnection({
      socketPath: "/tmp/evil/cli-runner.sock",
      rpcSecret: "secret",
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    await expect(conn.ensureConnected()).rejects.toBeInstanceOf(CliChatUnavailableError);
    conn.close();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// §3.6 hello + §3.4 id-matching + §5.6 bootId — against an in-process fake server
// ──────────────────────────────────────────────────────────────────────────────

const HMAC = (secret: string, msg: string): string =>
  createHmac("sha256", secret).update(msg, "utf8").digest("hex");

interface FakeServerOpts {
  /** Override the bootId returned for the Nth (0-based) ok response. Lets a test flip bootId mid-stream. */
  readonly bootIdFor?: (callIndex: number) => string;
  /** If set, the server returns a wrong serverProof (imposter) so the client must abort the hello. */
  readonly imposter?: boolean;
  /**
   * If set, the server completes the §3.6 hello but NEVER answers a post-handshake request — it reads
   * the frame and drops it. Models the #445 hang: a cli-runner that accepted a submit/readNew frame
   * but whose provider CLI wedged, so no response ever returns and the socket stays open.
   */
  readonly swallowRequests?: boolean;
  /** Per-request handler → the `result` to return (or a thrown {code,message} for an err frame). */
  readonly onRequest?: (req: { method: string; id: number; params: unknown }) => unknown;
}

/**
 * A minimal in-process cli-runner server speaking the frozen protocol: it performs the server side of
 * the §3.6 hello, then answers each RpcRequest with an RpcOk (or RpcErr) carrying a bootId.
 */
function startFakeServer(
  socketPath: string,
  secret: string,
  opts: FakeServerOpts = {}
): Promise<Server> {
  let callIndex = 0;
  const server = createServer((sock: Socket) => {
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let handshook = false;
    let clientNonce = "";

    // Ignore write races: the client may close/destroy the socket mid-handshake (e.g. the
    // §3.6 imposter-abort test), so a later server write would emit an UNHANDLED EPIPE and fail
    // the run even though every assertion passed. Handle the socket error + guard the write so the
    // fake server never crashes the process on a closed peer. (Pre-existing intermittent flake.)
    sock.on("error", () => {});
    const send = (frame: unknown): void => {
      if (sock.destroyed || !sock.writable) return;
      sock.write(encodeFrame(frame as RpcFrame));
    };

    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const decoded = decodeFrame(buf);
        if (decoded.kind !== "frame") return;
        buf = buf.subarray(decoded.consumed);
        const frame = JSON.parse(decoded.body.toString("utf8"));

        if (!handshook) {
          if (frame.t === "hello") {
            clientNonce = frame.clientNonce;
            const serverNonce = randomBytes(32).toString("hex");
            const serverProof = opts.imposter
              ? "00".repeat(32)
              : HMAC(secret, HELLO_PROOF_TAG_SERVER + clientNonce);
            send({ t: "hello-challenge", serverProof, serverNonce });
            (sock as unknown as { _serverNonce: string })._serverNonce = serverNonce;
          } else if (frame.t === "hello-response") {
            const serverNonce = (sock as unknown as { _serverNonce: string })._serverNonce;
            const expected = HMAC(secret, HELLO_PROOF_TAG_CLIENT + serverNonce);
            if (frame.clientProof !== expected) {
              sock.destroy();
              return;
            }
            handshook = true;
          }
          continue;
        }

        // Post-handshake: answer the request — unless the test wants the request SWALLOWED (no
        // response ever sent), modelling the #445 hang the per-call deadline exists to break.
        if (opts.swallowRequests) {
          callIndex += 1;
          continue;
        }
        const bootId = opts.bootIdFor ? opts.bootIdFor(callIndex) : "boot-fixed";
        callIndex += 1;
        try {
          const result = opts.onRequest
            ? opts.onRequest({ method: frame.method, id: frame.id, params: frame.params })
            : { ok: true };
          send({ t: "ok", id: frame.id, bootId, result });
        } catch (e) {
          const err = e as { code?: string; message?: string };
          send({
            t: "err",
            id: frame.id,
            bootId,
            error: { code: err.code ?? "internal", message: err.message ?? "err" }
          });
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

describe("RpcConnection hello + id-matching + bootId (in-process socket)", () => {
  const servers: Server[] = [];
  const conns: RpcConnection[] = [];

  afterEach(async () => {
    for (const c of conns.splice(0)) c.close();
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  function tmpSocket(): string {
    return join(mkdtempSync(join(tmpdir(), "jarv1s-rpc-")), "cli-runner.sock");
  }

  /**
   * The §3.1 realpath guard requires the socket under /run/jarv1s, which is not writable in a unit
   * sandbox. The guard is verified independently in the realpath test above; here we subclass to relax
   * it so the socket-backed tests can bind a temp socket and exercise the hello + framing + bootId.
   */
  class TestConn extends RpcConnection {
    protected async assertSocketUnderRunDir(): Promise<void> {
      // Intentionally skipped for socket-backed tests (guard covered separately).
    }
  }

  it("completes the §3.6 hello with the correct secret and round-trips submit (id-matched)", async () => {
    const secret = "shared-secret";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {
      onRequest: ({ method, params }) => {
        if (method === "submit") {
          expect((params as { attemptId: string; text: string }).text).toBe("hello");
          expect((params as { attemptId: string }).attemptId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          );
          return { ok: true };
        }
        return { ok: true };
      }
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const res = await conn.submit("u1", {
      attemptId: "33333333-3333-4333-8333-333333333333",
      text: "hello"
    });
    expect(res).toEqual({ ok: true });
  });

  it("aborts the hello (no token sent) when the server proof is wrong (imposter peer, §3.6)", async () => {
    const secret = "shared-secret";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, { imposter: true });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    // The client verifies serverProof BEFORE replying; a mismatch closes and the connect retries
    // forever against the imposter, so ensureConnected never resolves — assert it times out pending.
    const settled = await Promise.race([
      conn
        .ensureConnected()
        .then(() => "connected")
        .catch(() => "rejected"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 150))
    ]);
    expect(settled).toBe("pending");
  });

  it("matches out-of-order responses by id over one connection (§3.4)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {
      onRequest: ({ method }) => (method === "isAlive" ? { alive: true } : { ok: true })
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const [a, b] = await Promise.all([conn.isAlive("u1"), conn.kill("u2")]);
    expect(a).toEqual({ alive: true });
    expect(b).toEqual({ ok: true });
  });

  it("fires reconciliation on a §5.6 bootId change", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    let reconciles = 0;
    // First response carries boot-1; every later response carries boot-2 (silent restart).
    const server = await startFakeServer(socketPath, secret, {
      bootIdFor: (i) => (i === 0 ? "boot-1" : "boot-2")
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      onReconcile: async () => {
        reconciles += 1;
      }
    });
    conns.push(conn);

    // First call connects (reconcile #1 fires on connect) and records boot-1.
    await conn.isAlive("u1");
    const afterConnect = reconciles;
    // Second call returns boot-2 → bootId change → reconcile fires again.
    await conn.isAlive("u1");
    // Give the async reconcile microtask a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(reconciles).toBeGreaterThan(afterConnect);
  });

  it("reconciliation hook can drive listLiveSessions()+kill() over the same connection without self-deadlocking (§5.3)", async () => {
    // Regression for the reconcile self-deadlock: while `reconciling` is true, every NORMAL call()
    // rejects with CliChatUnavailableError ("cli-runner reconciling after restart"). But the real
    // §5.3 routine MUST issue listLiveSessions() (step 1) and kill() (step 4) FROM INSIDE the hook.
    // Those must bypass the guard via the RpcReconcileDriver handed to onReconcile — otherwise the
    // routine can never gather liveKeys or reap orphaned mux sessions and reconciliation wedges.
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {
      // First response carries boot-1; every later one boot-2 → a silent restart → reconcile.
      bootIdFor: (i) => (i === 0 ? "boot-1" : "boot-2"),
      onRequest: ({ method }) => {
        if (method === "listLiveSessions") return { sessionKeys: ["orphan-key"] };
        if (method === "kill") return { ok: true };
        if (method === "isAlive") return { alive: true };
        return { ok: true };
      }
    });
    servers.push(server);

    let reconcileResolved = false;
    let liveKeysSeen: string[] | null = null;
    let killedKey: string | null = null;
    let reconcileError: unknown = null;

    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      onReconcile: async (driver) => {
        try {
          // §5.3 step 1: enumerate the live keys (would throw "reconciling after restart" if the
          // driver did NOT bypass the guard — the deadlock this test guards against).
          const { sessionKeys } = await driver.listLiveSessions();
          liveKeysSeen = sessionKeys;
          // §5.3 step 4: reap an api-unknown orphaned mux session by name.
          await driver.kill(sessionKeys[0]!);
          killedKey = sessionKeys[0]!;
          reconcileResolved = true;
        } catch (err) {
          reconcileError = err;
          throw err;
        }
      }
    });
    conns.push(conn);

    // First call connects → reconcile #1 fires on connect (records boot-1) and drives the hook.
    await conn.isAlive("u1");
    // A second call returns boot-2 → bootId change → a second reconcile fires.
    await conn.isAlive("u1");
    // Let the async reconcile (and its own RPCs) settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileError).toBeNull();
    expect(reconcileResolved).toBe(true);
    expect(liveKeysSeen).toEqual(["orphan-key"]);
    expect(killedKey).toBe("orphan-key");

    // After reconciliation completes, the guard is cleared and normal calls flow again.
    await expect(conn.isAlive("u1")).resolves.toEqual({ alive: true });
  });

  it("rejects an in-flight call with CliChatUnavailableError when the server returns unavailable (§4.7)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {
      onRequest: () => {
        throw { code: "unavailable", message: "multiplexer down" };
      }
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const params = submitParams("x");
    const cancel = vi.spyOn(conn, "cancelSubmit").mockResolvedValue({ ok: true });
    await expect(conn.submit("u1", params)).rejects.toBeInstanceOf(CliChatUnavailableError);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith("u1", { attemptId: params.attemptId });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // §A.2 installProvider — non-session verb; error-RESULT (not RpcErr) vs transport RpcErr
  // ──────────────────────────────────────────────────────────────────────────

  it("installProvider round-trips a terminal `installed` result over the shared socket (§A.2)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {
      onRequest: ({ method, params }) => {
        expect(method).toBe("installProvider");
        // §A.2: a NON-SESSION verb — the request carries no sessionKey, only { provider }.
        expect((params as { provider: string }).provider).toBe("anthropic");
        return { state: "installed", version: "1.2.3", alreadyInstalled: false };
      }
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const res = await conn.installProvider({ provider: "anthropic" });
    expect(res).toEqual({ state: "installed", version: "1.2.3", alreadyInstalled: false });
  });

  it("installProvider RESOLVES (does NOT throw) on a FAILED install — RpcOk{state:'error'}, not an RpcErr (§A.2.3)", async () => {
    // The single biggest §A.2.3 correctness fix: a failed install is a normal terminal OUTCOME
    // returned as an RpcOk with result.state==="error" + a redacted message — NOT a transport RpcErr.
    // The client must RESOLVE with the error result so the api can persist `error` + surface a retry;
    // modelling it as a throw would conflate "the install failed" with "the socket/RPC failed".
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {
      onRequest: ({ method }) => {
        expect(method).toBe("installProvider");
        // An RpcOk (the fake's default success frame) carrying an `error` RESULT — not a thrown RpcErr.
        return { state: "error", message: "verify failed: sha512 mismatch (redacted)" };
      }
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const res = await conn.installProvider({ provider: "anthropic" });
    expect(res.state).toBe("error");
    expect(res.message).toContain("sha512 mismatch");
    // It must NOT be the version-present success shape.
    expect(res.version).toBeUndefined();
  });

  it("installProvider THROWS a plain Error on a transport RpcErr bad_request (catalog-blocked, §A.2.3)", async () => {
    // The OTHER path: a malformed/blocked input (not-a-kind, catalog-blocked, already-in-progress)
    // crosses as an RpcErr `bad_request`, which call()/mapRpcError turn into a thrown plain Error
    // (→ HTTP 500). This is distinct from the error-RESULT above.
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {
      onRequest: () => {
        throw { code: "bad_request", message: "provider not installable: agy spike unresolved" };
      }
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const err = await conn.installProvider({ provider: "google" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CliChatUnavailableError);
    expect((err as Error).message).toContain("not installable");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // §3.4 per-call deadline — the #445 fix: a never-answered turn verb must REJECT
  // (releasing the per-user turn lock) instead of hanging the promise forever.
  // ──────────────────────────────────────────────────────────────────────────

  it("rejects a never-answered turn verb after the per-call deadline (CliChatUnavailableError, #445)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    // The server completes the hello but SWALLOWS the submit frame — no response ever comes back,
    // and the socket stays open so neither routeFrame nor failAllInFlight settles the call. Before
    // the deadline existed this promise hung forever and wedged turnsInFlight (permanent 409).
    const server = await startFakeServer(socketPath, secret, { swallowRequests: true });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      callTimeoutMs: 60 // tiny deadline so the test is fast
    });
    conns.push(conn);

    const err = await conn.submit("u1", submitParams("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliChatUnavailableError);
    expect((err as Error).message).toMatch(/submit timed out after 60ms/);
  });

  it("does NOT time out when callTimeoutMs is 0 (deadline disabled — opt-out seam)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, { swallowRequests: true });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      callTimeoutMs: 0 // disable all per-call deadlines
    });
    conns.push(conn);

    // With deadlines off the swallowed call stays pending — assert it has NOT settled after a window
    // comfortably longer than the would-be deadline, mirroring the imposter-hello "pending" check.
    const settled = await Promise.race([
      conn
        .submit("u1", submitParams("x"))
        .then(() => "resolved")
        .catch(() => "rejected"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 150))
    ]);
    expect(settled).toBe("pending");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // #456 Task B — activity-aware RPC deadline: resetActivityDeadline(sessionKey)
  // ──────────────────────────────────────────────────────────────────────────

  it("resetActivityDeadline re-arms the in-flight turn-verb timer so activity prevents a trip (#456)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    // Server swallows requests (no response); the deadline is the only thing that can settle the call.
    const server = await startFakeServer(socketPath, secret, { swallowRequests: true });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2,
      callTimeoutMs: 200 // original deadline
    });
    conns.push(conn);

    // Fire a readNew that the server swallows. Without a reset it would trip at 200ms.
    const resultPromise = conn.readNew("u1", { afterOffset: 0 });

    // Wait long enough for the connection handshake + frame write to complete and the call to be
    // pending with its timer running, but BEFORE the 200ms deadline. 100ms is safely in-window.
    await new Promise((r) => setTimeout(r, 100));
    // Confirm the call is pending (deadline has NOT fired yet at 100ms < 200ms).
    const pre = await Promise.race([
      resultPromise.then(() => "settled").catch(() => "rejected"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 10))
    ]);
    expect(pre).toBe("pending");

    // Signal activity at 100ms — re-arms the timer for another 200ms (new deadline ~300ms).
    conn.resetActivityDeadline("u1");

    // At 220ms (past the ORIGINAL 200ms deadline) the call must STILL be pending — the reset held.
    const settledAt220 = await Promise.race([
      resultPromise.then(() => "settled").catch(() => "rejected"),
      new Promise<string>((r) => setTimeout(() => r("pending"), 110))
    ]);
    expect(settledAt220).toBe("pending");

    // Close the conn to settle the call cleanly (the swallowed request never gets a response).
    conn.close();
    await expect(resultPromise).rejects.toBeInstanceOf(CliChatUnavailableError);
  });

  it("resetActivityDeadline is a no-op when no turn verb is in flight for the session (#456)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {});
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    // No in-flight call — must not throw.
    expect(() => conn.resetActivityDeadline("u_nobody")).not.toThrow();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Review B4 follow-up — a structured one-shot call (email extraction and similar callers) must
  // no longer be rejected with "CLI structured stream is unavailable" once this client is built
  // through the real socket factory. Only the transport (the fake in-process server above) is
  // mocked; RpcConnection and ChatEngineRpcClient are the real classes.
  // ──────────────────────────────────────────────────────────────────────────
  it("an RPC-backed engine now exposes all three structured-call methods (real socket, real client)", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    const server = await startFakeServer(socketPath, secret, {});
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const client = new ChatEngineRpcClient("anthropic", "u1", conn, "interactive", undefined, true);

    // Same structural check `isCliStructuredEngine` runs (cli-structured-adapter.ts) before it will
    // hand a structured call to this engine — before this fix, an RPC-backed client had none of
    // these three methods and the guard always failed.
    expect(typeof client.launchStructured).toBe("function");
    expect(typeof client.submitStructured).toBe("function");
    expect(typeof client.readStructured).toBe("function");
  });

  it("carries a structured launch, submit, and read all the way through the real socket", async () => {
    const secret = "s";
    const socketPath = tmpSocket();
    let receivedSchema: unknown;
    let receivedSubmitText: unknown;
    let receivedAfterOffset: unknown;
    const server = await startFakeServer(socketPath, secret, {
      onRequest: ({ method, params }) => {
        if (method === "launch") {
          receivedSchema = (params as { schema?: unknown }).schema;
          return { offset: 0 };
        }
        if (method === "submitStructured") {
          receivedSubmitText = (params as { text: string }).text;
          return { ok: true };
        }
        if (method === "readStructured") {
          receivedAfterOffset = (params as { afterOffset: number }).afterOffset;
          return { text: '{"confidence":1}', offset: 42, complete: true };
        }
        return { ok: true };
      }
    });
    servers.push(server);
    const conn = new TestConn({
      socketPath,
      rpcSecret: secret,
      reconnectMinMs: 1,
      reconnectMaxMs: 2
    });
    conns.push(conn);

    const client = new ChatEngineRpcClient("anthropic", "u1", conn, "interactive", undefined, true);
    const schema = { type: "object", properties: { confidence: { type: "number" } } };

    const launchResult = await client.launchStructured({
      neutralDir: "/unused",
      personaPath: "/unused/persona.md",
      schema
    });
    expect(launchResult).toEqual({ offset: 0 });
    expect(receivedSchema).toEqual(schema);

    await client.submitStructured("extract the signals");
    expect(receivedSubmitText).toBe("extract the signals");

    const readResult = await client.readStructured(10);
    expect(receivedAfterOffset).toBe(10);
    expect(readResult).toEqual({ text: '{"confidence":1}', offset: 42, complete: true });
  });
});
