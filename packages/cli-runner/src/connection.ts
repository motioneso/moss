/**
 * Per-connection lifecycle for the cli-runner server: the §3.6 auth handshake, then
 * the §3.2 length-prefixed frame read-loop, decode → §4 method dispatch → response
 * encode. Malformed frames close the connection (§3.7); semantically-invalid requests
 * return RpcErr without closing.
 *
 * NO raw frame logging (§6.4): the only loggable fields are { method, id, sessionKey,
 * bytes }. Error messages are redacted server-side before crossing the wire.
 */

import { redactSecrets } from "@moss/ai";

import {
  CliChatUnavailableError,
  VerifiedSubmitError,
  decodeFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
  type RpcBeginLoginParams,
  type RpcCancelLoginParams,
  type RpcCancelSubmitParams,
  type RpcErr,
  type RpcErrorCode,
  type RpcFrame,
  type RpcHandshakeFrame,
  type RpcInstallProviderParams,
  type RpcKillParams,
  type RpcKillTerminalParams,
  type RpcLaunchParams,
  type RpcListProviderModelsParams,
  type RpcOk,
  type RpcOpenTerminalParams,
  type RpcPollLoginParams,
  type RpcProbeProviderParams,
  type RpcProviderKind,
  type RpcReadNewParams,
  type RpcReadStructuredParams,
  type RpcRequest,
  type RpcResizeTerminalParams,
  type RpcSubmitLoginTokenParams,
  type RpcWriteTerminalParams
} from "@moss/chat/live";

import { BadSubmitAttemptError, NotLaunchedError, type CliChatEngineHost } from "./engine-host.js";
import { InstallBadRequestError } from "./install-service.js";
import { LoginBadRequestError } from "./login-service.js";
import { isHandshakeFrame, stepHelloServer, type HelloServerState } from "./hello.js";
// #1059 — owner terminal dispatch: TerminalHost owns the single active PTY; TerminalSink
// is the shape the host calls back through to push async PTY output over THIS connection.
import type { TerminalHost, TerminalSink } from "./terminal-host.js";

/** A duplex byte sink/source — `net.Socket` satisfies this; tests inject a fake. */
export interface ByteChannel {
  // #1526 — real sockets return boolean (false = backpressure); existing fakes may still
  // return void. Only an exact `false` means backpressure — never inferred from `void`.
  write(buf: Buffer): boolean | void;
  end(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "close" | "error", listener: () => void): void;
  on(event: "drain", listener: () => void): void;
}

export interface ConnectionDeps {
  readonly host: CliChatEngineHost;
  readonly bootId: string;
  readonly secret: string | undefined;
  /**
   * #1059 — owns the single active owner-terminal PTY for this cli-runner process. One
   * TerminalHost is shared across ALL connections (constructed once in main.ts/server.ts),
   * matching the "at most one live terminal" security model: a second connection OPENING a
   * terminal still evicts whichever session was open before, regardless of which socket owns
   * it (TerminalHost.open's internal killAll — unchanged). [N2] fix: CLOSE-time teardown is no
   * longer instance-wide — see `close()` below, which now kills only the terminal THIS
   * connection opened, not every live terminal on the shared host.
   */
  readonly terminalHost: TerminalHost;
  /** Optional debug logger; receives ONLY { method, id, sessionKey, bytes } (§6.4). */
  readonly log?: (line: {
    method?: string;
    id?: number;
    sessionKey?: string;
    bytes: number;
  }) => void;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Drive one accepted connection to completion. Never throws. */
export function serveConnection(channel: ByteChannel, deps: ConnectionDeps): void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let authenticated = false;
  let closed = false;
  const hello: HelloServerState = { phase: "await-hello", serverNonce: "" };
  // #1059 [N2] — the terminalId THIS connection most recently opened, or null if it never
  // opened one. Recorded by `recordTerminal` from the `openTerminal` case in `invoke` below.
  // A second `openTerminal` on the SAME connection overwrites this — the prior id was already
  // evicted by TerminalHost.open's internal killAll, so tracking only the latest is correct.
  let ownedTerminalId: string | null = null;
  const recordTerminal = (id: string): void => {
    ownedTerminalId = id;
  };
  // #1526 — the terminalId whose data push last saw `write() === false`, or null if none is
  // currently backpressured. Cleared by the matching "drain" event, which resumes only this id.
  let backpressureTerminalId: string | null = null;

  // #1059 — per-connection push sink: PTY output/exit arrive on TerminalHost's own async
  // callbacks (node-pty read events), NOT inside a request/response turn, so they must be
  // written to THIS connection's channel directly via safeWrite rather than returned from
  // `invoke`. base64 keeps raw (possibly non-UTF-8) PTY bytes JSON-safe on the wire (§3.2).
  const pushSink: TerminalSink = {
    data: (terminalId, bytes) => {
      const outcome = safeWrite(channel, {
        t: "push",
        bootId: deps.bootId,
        channel: "terminalData",
        terminalId,
        dataB64: bytes.toString("base64")
      });
      if (outcome === "error") {
        close();
        return false;
      }
      if (outcome === "backpressure") {
        backpressureTerminalId = terminalId;
        return false;
      }
      return true;
    },
    exit: (terminalId, exitCode) => {
      if (
        safeWrite(channel, {
          t: "push",
          bootId: deps.bootId,
          channel: "terminalExit",
          terminalId,
          exitCode
        }) === "error"
      ) {
        close();
      }
    }
  };

  // #1554 Decision 2 — the persistent runtime pool's `onReap` fires host-side (the pool is
  // process-wide, like the host itself), not connection-side like TerminalHost's PTY output, so
  // it can't reuse `pushSink`. Every connection registers its own listener on connect and
  // unregisters on close, symmetric with `ownedTerminalId`/`close()` below, so a reap fans out
  // as a `sessionReaped` push to every connected client.
  const unregisterReap = deps.host.addSessionReapedListener((sessionKey, reapReason) => {
    safeWrite(channel, {
      t: "push",
      bootId: deps.bootId,
      channel: "sessionReaped",
      sessionKey,
      reapReason
    });
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    // #1059 [N2] — a dropped/closed socket must never leave an orphan PTY running, but this
    // must kill ONLY the terminal THIS connection opened, not `killAll()`: TerminalHost is a
    // process-wide singleton shared across every connection, so a blanket killAll() here would
    // tear down a DIFFERENT admin's live session on close-and-reopen races or a second admin's
    // concurrent terminal (self-inflicted DoS, no data leak). `kill()` on a stale/already-evicted
    // id is a safe no-op (TerminalHost.clear checks `session.id === id`), so this is correct even
    // if a later connection's `openTerminal` already evicted this connection's terminal.
    if (ownedTerminalId) deps.terminalHost.kill({ terminalId: ownedTerminalId });
    // #1554 Decision 2 — deregister this connection's reap listener so a closed/dropped
    // connection doesn't keep accumulating dead listeners on the process-wide host.
    unregisterReap();
    try {
      channel.end();
    } catch {
      // ignore — already gone
    }
  };

  channel.on("close", close);
  channel.on("error", close);
  channel.on("drain", () => {
    if (backpressureTerminalId) {
      deps.terminalHost.resume(backpressureTerminalId);
      backpressureTerminalId = null;
    }
  });

  channel.on("data", (chunk: Buffer) => {
    if (closed) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

    // Drain as many complete frames as are buffered.
    for (;;) {
      const decoded = decodeFrame(buf);
      if (decoded.kind === "incomplete") return;
      if (decoded.kind === "oversize") {
        // Malformed FRAME — stream alignment is no longer trustworthy (§3.2/§3.7).
        close();
        return;
      }
      const body = decoded.body;
      // The decoded frame's payload byte-length (§3.2/§6.4 — the ONLY size field we log).
      const frameBytes = body.length;
      buf = buf.subarray(decoded.consumed);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        // A body that is not valid JSON is a malformed frame ⇒ close (§3.7).
        close();
        return;
      }

      if (!authenticated) {
        if (!isHandshakeFrame(parsed)) {
          // First frame must be a valid hello (§3.6/§3.7).
          close();
          return;
        }
        const step = stepHelloServer(hello, parsed as RpcHandshakeFrame, deps.secret);
        if (step.kind === "close") {
          close();
          return;
        }
        if (step.kind === "send") {
          channel.write(encodeFrame(step.frame));
          continue;
        }
        // authenticated — switch to request/response framing.
        authenticated = true;
        continue;
      }

      // Authenticated: every subsequent frame must be a request (§3.4).
      void dispatchFrame(parsed, frameBytes, deps, channel, close, pushSink, recordTerminal);
    }
  });
}

async function dispatchFrame(
  parsed: unknown,
  frameBytes: number,
  deps: ConnectionDeps,
  channel: ByteChannel,
  close: () => void,
  pushSink: TerminalSink,
  // #1059 [N2] — threaded from serveConnection's connection-scoped `ownedTerminalId`; invoke's
  // `openTerminal` case calls this with the fresh terminalId so close() can scope its kill to
  // just this connection instead of the whole shared TerminalHost.
  recordTerminal: (id: string) => void
): Promise<void> {
  if (!isRequest(parsed)) {
    // Unknown `t` discriminant / not a request post-handshake ⇒ malformed frame (§3.7).
    close();
    return;
  }
  const req = parsed;
  // §6.4: the ONLY loggable fields are { method, id, sessionKey, bytes } — the request
  // frame's payload byte-length, NOT its body.
  deps.log?.({
    method: req.method,
    id: req.id,
    sessionKey: req.sessionKey,
    bytes: frameBytes
  });

  try {
    const result = await invoke(req, deps.host, deps.terminalHost, pushSink, recordTerminal);
    const ok: RpcOk = { t: "ok", id: req.id, bootId: deps.bootId, result };
    // §3.2/§4.4: an OK result (e.g. a pathological multi-MiB readNew) that would exceed
    // MAX_FRAME_BYTES must NOT throw into the close path — encodeFrame throws and the
    // stream is still aligned (we have not written anything). Convert it to an in-band
    // RpcErr{ code: "internal" } so the connection survives and the client maps it to a
    // typed error (§4.7) instead of seeing a silent reconnect.
    if (frameExceedsCap(ok)) {
      const tooBig = toErrFrame(req.id, deps.bootId, new Error("response frame too large"));
      if (safeWrite(channel, tooBig) === "error") close();
      return;
    }
    if (safeWrite(channel, ok) === "error") close();
  } catch (err) {
    const errFrame = toErrFrame(req.id, deps.bootId, err);
    if (safeWrite(channel, errFrame) === "error") close();
  }
}

/**
 * True when the encoded frame would exceed MAX_FRAME_BYTES (§3.2). Used to convert an
 * un-framable OK response into an in-band RpcErr{internal} BEFORE attempting to write it,
 * so encodeFrame never throws into the connection-close path on the success branch.
 */
function frameExceedsCap(frame: RpcFrame): boolean {
  return Buffer.byteLength(JSON.stringify(frame), "utf8") > MAX_FRAME_BYTES;
}

async function invoke(
  req: RpcRequest,
  host: CliChatEngineHost,
  terminalHost: TerminalHost,
  pushSink: TerminalSink,
  // #1059 [N2] — see dispatchFrame's param doc above.
  recordTerminal: (id: string) => void
): Promise<unknown> {
  switch (req.method) {
    case "launch": {
      const key = requireSessionKey(req);
      const params = (isRecord(req.params) ? req.params : {}) as Partial<RpcLaunchParams>;
      const hasReplay = typeof params.replayBatch === "string" && params.replayBatch.length > 0;
      if (
        (hasReplay && !isAttemptId(params.replayAttemptId)) ||
        (!hasReplay && params.replayAttemptId !== undefined)
      ) {
        throw new BadRequestError(
          "replayAttemptId is required exactly when replayBatch is present"
        );
      }
      return host.launch(key, params as RpcLaunchParams);
    }
    case "submit": {
      const key = requireSessionKey(req);
      const params = isRecord(req.params) ? req.params : {};
      const text = params.text;
      if (typeof text !== "string") throw new BadRequestError("submit.text must be a string");
      if (!isAttemptId(params.attemptId)) {
        throw new BadRequestError("submit.attemptId must be a UUID");
      }
      await host.submit(key, { attemptId: params.attemptId, text });
      return { ok: true };
    }
    case "cancelSubmit": {
      const key = requireSessionKey(req);
      const params = (isRecord(req.params) ? req.params : {}) as Partial<RpcCancelSubmitParams>;
      if (!isAttemptId(params.attemptId)) {
        throw new BadRequestError("cancelSubmit.attemptId must be a UUID");
      }
      await host.cancelSubmit(key, { attemptId: params.attemptId });
      return { ok: true };
    }
    case "readNew": {
      const key = requireSessionKey(req);
      const afterOffset = (req.params as RpcReadNewParams).afterOffset;
      if (
        typeof afterOffset !== "number" ||
        !Number.isInteger(afterOffset) ||
        afterOffset < 0 ||
        afterOffset > MAX_SAFE
      ) {
        // Semantically-invalid value — bad_request WITHOUT closing (§3.3/§3.7).
        throw new BadRequestError("afterOffset out of range");
      }
      return host.readNew(key, afterOffset);
    }
    case "submitStructured": {
      // Review B4 follow-up — mirrors the "submit" case, minus attemptId (no idempotency ledger
      // for a structured one-shot session; the caller owns retry policy, cli-structured-adapter.ts).
      const key = requireSessionKey(req);
      const params = isRecord(req.params) ? req.params : {};
      const text = params.text;
      if (typeof text !== "string") {
        throw new BadRequestError("submitStructured.text must be a string");
      }
      await host.submitStructured(key, text);
      return { ok: true };
    }
    case "readStructured": {
      // Review B4 follow-up — mirrors the "readNew" case's afterOffset validation.
      const key = requireSessionKey(req);
      const afterOffset = (req.params as RpcReadStructuredParams).afterOffset;
      if (
        typeof afterOffset !== "number" ||
        !Number.isInteger(afterOffset) ||
        afterOffset < 0 ||
        afterOffset > MAX_SAFE
      ) {
        throw new BadRequestError("afterOffset out of range");
      }
      return host.readStructured(key, afterOffset);
    }
    case "isAlive": {
      const key = requireSessionKey(req);
      return { alive: await host.isAlive(key) };
    }
    case "kill": {
      const key = requireSessionKey(req);
      const params = (isRecord(req.params) ? req.params : {}) as Partial<RpcKillParams>;
      if (
        params.preserveNeutralDir !== undefined &&
        typeof params.preserveNeutralDir !== "boolean"
      ) {
        throw new BadRequestError("kill.preserveNeutralDir must be a boolean");
      }
      await host.kill(key, params);
      return { ok: true };
    }
    case "purgeTranscripts": {
      // #744 — private-chat transcript purge. Manager calls this before kill so a resident engine
      // uses exact identity. A throw keeps the row and makes kill preserve the marker for boot sweep.
      const key = requireSessionKey(req);
      await host.purgeTranscripts(key);
      return { ok: true };
    }
    case "interrupt": {
      const key = requireSessionKey(req);
      await host.interrupt(key);
      return { ok: true };
    }
    case "listLiveSessions": {
      // Non-session verb — no sessionKey (§4.6).
      return { sessionKeys: await host.listLiveSessions() };
    }
    case "probeProvider": {
      const params = req.params as RpcProbeProviderParams;
      const provider = params.provider;
      if (!isProviderKind(provider)) throw new BadRequestError("unknown provider");
      return host.probeProvider(provider, { forceFresh: params.forceFresh });
    }
    case "installProvider": {
      // §A.2.4 TWO ordered validation gates, both mapping to bad_request (§3.7) but
      // DISTINCT (§A.2.3):
      //  (1) KIND guard FIRST — a value that is not an RpcProviderKind ⇒ "unknown
      //      provider" (the isProviderKind mirror), before the catalog is consulted.
      //  (2) CATALOG-status gate SECOND — a valid kind whose recipe is blocked/absent ⇒
      //      a DISTINCT "provider not installable: <reason>" rejection. agy-while-blocked
      //      lands here, NOT in the kind guard. This gate lives inside the install
      //      service (InstallService.resolveRecipe → InstallBadRequestError), which
      //      errorCode() maps to bad_request. A FAILED install (download/verify/promote)
      //      is NOT here — it is a normal RpcOk { result.state:"error" } (§A.2.3).
      const provider = (req.params as RpcInstallProviderParams).provider;
      if (!isProviderKind(provider)) throw new BadRequestError("unknown provider");
      return host.installProvider(provider);
    }
    case "listProviderModels": {
      // #2208: non-session; kind guard ⇒ bad_request. Every other outcome (not logged in,
      // unsupported, vendor failure) is a normal RpcOk result, never an RpcErr.
      const provider = (req.params as RpcListProviderModelsParams).provider;
      if (!isProviderKind(provider)) throw new BadRequestError("unknown provider");
      return host.listProviderModels(provider);
    }
    case "beginLogin": {
      // login-contract §L.2.2: kind guard FIRST (bad_request). The catalog/adapter-blocked gate
      // (no adapter / agy) lives in the login service (LoginBadRequestError → bad_request).
      const provider = (req.params as RpcBeginLoginParams).provider;
      if (!isProviderKind(provider)) throw new BadRequestError("unknown provider");
      return host.beginLogin(provider);
    }
    case "pollLogin": {
      const p = req.params as RpcPollLoginParams;
      if (!isProviderKind(p.provider)) throw new BadRequestError("unknown provider");
      if (typeof p.loginId !== "string" || p.loginId.length === 0) {
        throw new BadRequestError("missing loginId");
      }
      return host.pollLogin(p.provider, p.loginId);
    }
    case "submitLoginToken": {
      const p = req.params as RpcSubmitLoginTokenParams;
      if (!isProviderKind(p.provider)) throw new BadRequestError("unknown provider");
      if (typeof p.loginId !== "string" || p.loginId.length === 0) {
        throw new BadRequestError("missing loginId");
      }
      // The token is auth material (§L.6.3) — validated for presence only; NEVER logged/echoed.
      if (typeof p.token !== "string" || p.token.length === 0) {
        throw new BadRequestError("missing token");
      }
      return host.submitLoginToken(p.provider, p.loginId, p.token);
    }
    case "cancelLogin": {
      const p = req.params as RpcCancelLoginParams;
      if (!isProviderKind(p.provider)) throw new BadRequestError("unknown provider");
      if (typeof p.loginId !== "string" || p.loginId.length === 0) {
        throw new BadRequestError("missing loginId");
      }
      return host.cancelLogin(p.provider, p.loginId);
    }
    // #1059 owner terminal — non-session verbs (no sessionKey, mirrors listLiveSessions):
    // the terminal is a single instance-wide resource, not per-chat-session.
    case "openTerminal": {
      const p = req.params as RpcOpenTerminalParams;
      // Validated here (not inside TerminalHost) so a bad request maps to bad_request
      // WITHOUT ever reaching TerminalHost.open — same pattern as every other params
      // guard in this switch (§3.7: semantically-invalid params ⇒ err, not a close).
      if (!Number.isInteger(p.cols) || !Number.isInteger(p.rows) || p.cols <= 0 || p.rows <= 0) {
        throw new BadRequestError("openTerminal cols/rows must be positive integers");
      }
      // #1059 [N2] — record the LATEST opened id on THIS connection so close() can scope its
      // kill to just this terminal instead of the shared host's killAll().
      const opened = terminalHost.open(p, pushSink);
      recordTerminal(opened.terminalId);
      return opened;
    }
    case "writeTerminal": {
      const p = req.params as RpcWriteTerminalParams;
      if (typeof p.terminalId !== "string" || typeof p.dataB64 !== "string") {
        throw new BadRequestError("writeTerminal requires terminalId + dataB64");
      }
      terminalHost.write(p);
      return { ok: true };
    }
    case "resizeTerminal": {
      // No params validation (task-4 spec): a stale/malformed terminalId is a no-op inside
      // TerminalHost (forId() returns null), so there is nothing unsafe to guard here.
      terminalHost.resize(req.params as RpcResizeTerminalParams);
      return { ok: true };
    }
    case "killTerminal": {
      // No params validation (task-4 spec) — kill is idempotent for an absent/unknown id.
      terminalHost.kill(req.params as RpcKillTerminalParams);
      return { ok: true };
    }
    default:
      throw new BadRequestError("unknown method");
  }
}

function requireSessionKey(req: RpcRequest): string {
  if (typeof req.sessionKey !== "string" || req.sessionKey.length === 0) {
    // Missing/empty sessionKey on a session method ⇒ bad_request, NOT a close (§3.4/§3.7).
    throw new BadRequestError("missing sessionKey");
  }
  return req.sessionKey;
}

function toErrFrame(id: number, bootId: string, err: unknown): RpcErr {
  const code = errorCode(err);
  // Redact the message server-side before it crosses the wire (§6.4). Never include a stack.
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactSecrets(raw);
  return { t: "err", id, bootId, error: { code, message } };
}

function errorCode(err: unknown): RpcErrorCode {
  if (err instanceof BadRequestError) return "bad_request";
  // §A.2.3 catalog-blocked / in-flight install rejection ⇒ bad_request (does NOT close).
  if (err instanceof InstallBadRequestError) return "bad_request";
  // §L.2.4 catalog/adapter-blocked / stale-loginId / no-login-on-build ⇒ bad_request (does NOT close).
  if (err instanceof LoginBadRequestError) return "bad_request";
  if (err instanceof NotLaunchedError) return "not_launched";
  if (err instanceof BadSubmitAttemptError) return "bad_request";
  if (err instanceof VerifiedSubmitError) return err.code;
  if (err instanceof CliChatUnavailableError) return "unavailable";
  return "internal";
}

function safeWrite(channel: ByteChannel, frame: RpcFrame): "sent" | "backpressure" | "error" {
  try {
    return channel.write(encodeFrame(frame)) === false ? "backpressure" : "sent";
  } catch {
    // EPIPE / oversize-encode / half-open peer — the caller closes.
    return "error";
  }
}

function isRequest(value: unknown): value is RpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { t?: unknown; id?: unknown; method?: unknown };
  return v.t === "req" && typeof v.id === "number" && typeof v.method === "string";
}

function isProviderKind(value: unknown): value is RpcProviderKind {
  return value === "anthropic" || value === "openai-compatible" || value === "google";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isAttemptId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** Semantically-invalid request value ⇒ RpcErr bad_request WITHOUT closing (§3.7). */
class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
