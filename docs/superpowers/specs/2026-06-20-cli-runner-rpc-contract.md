# Spec: cli-runner ↔ api RPC contract (in-container CLI chat) — #342

- **Status:** FROZEN v2 — re-frozen after three adversarial reviews (2 Claude critics + Codex). THE
  authoritative contract for the api ⇄ cli-runner split. Four independent lanes build against this with
  **zero further coordination**.
- **Date:** 2026-06-20 (v2)
- **Owner:** #342 in-container CLI chat (overnight build, Ben-delegated approvals)
- **GitHub:** #342 (epic #47, Phase 2)
- **Grounded-on:** `origin/main` ff34061 (worktree `~/jarvis-342-build`)
- **Implements / reverses:** ADR 0008 (host-native CLI volumes → cli-runner sidecar). Plan: `docs/superpowers/plans/2026-06-20-in-container-cli-chat.md`.

> **This document is FROZEN.** Four independent implementation lanes code against it with **no further
> coordination**. Every wire shape, path, env var, and ownership rule below is normative. Where a lane
> needs a value not specified here, that is a contract gap — escalate, do **not** invent.

---

## 1. Problem & Goal

Today live chat runs the multiplexer (`tmux`) and the provider CLIs (`claude`/`codex`/`agy`) **in the api
and worker containers**, reading transcripts off host-bind-mounted `~/.claude|.codex|.gemini` dirs
(`infra/docker-compose.prod.yml:154-197`). That couples app secrets (`BETTER_AUTH_SECRET`,
`JARVIS_AI_SECRET_KEY`, db URLs, vault) to the same container that runs third-party CLIs.

**Goal:** move CLIs + multiplexer + their auth/transcripts into a dedicated **`cli-runner` sidecar**, and
have the api drive it over a **private Unix-domain socket**. The api mounts **none** of the CLI-data
volumes; transcripts return to the api via the `readNew` RPC. `CliChatEngineImpl` stays inside cli-runner
**unchanged**; the api side becomes a thin RPC client implementing the same `CliChatEngine` interface
(`packages/chat/src/live/types.ts:31-41`).

The contract boundary is exactly the existing `CliChatEngine` interface. The RPC mirrors its five methods
plus two non-session methods (`listLiveSessions` for reconciliation, `probeProvider` for onboarding).
Nothing else crosses the socket.

### The lane split (who builds what against this contract) — CANONICAL DISJOINT PARTITION

This is the **single authoritative file-ownership partition** for the Phase-1 parallel build. **No two
lanes edit the same file.** The master spec's Phase-1 lane section (`§6`) carries the identical partition.
The one cross-lane seam: **Lane A authors `rpc-contract.ts` FIRST**; Lanes B and D import it read-only;
Lane A's `runtime.ts` imports the engine class from Lane B's `cli-chat-engine.ts` (compile-time only).

| Lane                                | Files it OWNS (exclusively)                                                                                                                                                                                                                                                                                                                                                                                                                                | Reads this spec for                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **A — api RPC client**              | **NEW** `packages/chat/src/live/rpc-contract.ts` (**authored FIRST** — the home of all wire types, §10) · **NEW** `packages/chat/src/live/chat-engine-rpc-client.ts` (`ChatEngineRpcClient` implements `CliChatEngine`; socket connect/reconnect; reconciliation driver) · `packages/chat/src/live/runtime.ts` (factory: socket present → rpc client, else in-process) · the `EngineLaunchOpts` extension in `packages/chat/src/live/types.ts`             | §3 framing, §4 methods, §5 reconciliation, §6 secrets (token-via-launch + socket secret), §10 wire-type home |
| **B — cli-runner server**           | **NEW** cli-runner server entrypoint + package · `packages/chat/src/live/cli-chat-engine.ts` (server impl: Claude token off the launch line → `.jarvis-claude-mcp.json`; neutralDir derivation; per-session-dir cleanup; bounded drain; `probeProvider` impl; kill-by-mux-name; listLiveSessions-by-mux). **Imports** `rpc-contract.ts` read-only.                                                                                                         | §3 framing, §4 methods, §6 secrets, §7 env allowlist, §10 wire-type home                                     |
| **C — infra/compose**               | `infra/docker-compose.prod.yml` (cli-runner + root-init services; tools/auth-home/socket volumes; **remove** host-bridge mounts `:162`/`:167-169`/`:172` + `JARVIS_CLI_HOME_BASE` env `:137`/`:185`; RPC-secret env) · Dockerfile/entrypoint · `install.sh` · `infra/env.production.example`                                                                                                                                                               | §8 volume matrix, §7 env vars, §6.6 socket secret                                                            |
| **D — tokens + state + onboarding** | `packages/ai/src/gateway/session-tokens.ts` (`listSessionIds` + `reconcile`) · `packages/chat/src/live/chat-session-manager.ts` (`reconcileLiveSessions` + reconnect trigger + populate `personaText`/`replayBatch` + seed offset + reaper mutex) · `packages/shared/src/onboarding-api.ts` (additive `ProviderInstallState` + `installState?` DTO + JSON-schema block) · the Phase-2 `provider_state` migration. **Imports** `rpc-contract.ts` read-only. | §5 reconciliation, §9 state machine, §10 wire-type home                                                      |

---

## 2. Scope

**In:** the wire protocol (framing, envelopes incl. a server `bootId`, the connection auth hello, liveness),
the five engine RPC methods + `listLiveSessions` (reconciliation) + `probeProvider` (onboarding), the
`launch` payload redesign (persona **content**, replay **batch string**, MCP token; `launch` now returns the
post-drain `offset`), MCP-token ownership + reconnect/restart reconciliation (incl. fast-restart detection
via `bootId` and kill-by-mux-name for post-restart orphans), secrets discipline (no secret in any tmux launch
line / argv / log / capture-pane / `show-environment`, and a socket-access secret excluded from the CLI env),
the volume + mount matrix, the env-var set + cli-runner sanitized-env allowlist, and the provider state
machine + its persistence seam.

**Out:** the on-demand installer recipes (Phase 2 of the plan), the login presentation layer (Phase 3),
agy/Antigravity pinning spike, API-key chat engine (rejected), GLM/opencode provider. The DB schema for the
provider state machine is sketched (§10) but its migration is a Phase-2 build task, not frozen here beyond
the enum + location.

---

## 3. TRANSPORT

### 3.1 Socket

- **Type:** Unix-domain `SOCK_STREAM` (`net.createServer` / `net.connect` on a filesystem path). Not TCP.
  No port is ever opened; the cli-runner exposes **no** network listener.
- **Path:** `JARVIS_CLI_RUNNER_SOCKET`, default **`/run/jarv1s/cli-runner.sock`**. Lives on the dedicated
  **socket volume** (§8) mounted into **cli-runner + api ONLY** (not worker, not web).
- **Permissions:** the socket file is created `0600`, owned by `JARVIS_HOST_UID:JARVIS_HOST_GID`. The
  containing dir (`/run/jarv1s`) is `0700` owned by the same uid (root-init chowns it, §8). cli-runner binds
  (server); api connects (client).
- **The filesystem permission is NOT a sufficient boundary against same-UID CLI subprocesses.** The
  provider CLIs (`claude`/`codex`/`agy`) run inside cli-runner **as the same uid** that owns the socket, so
  the `0600` permission does not stop a malicious or compromised CLI subprocess from opening the socket and
  impersonating the api. The socket therefore carries an **application-level auth hello** — see §3.6. The
  filesystem permission + private volume keep _other containers_ out; the hello keeps _same-UID
  subprocesses_ out.
- **Bind hygiene:** on start, cli-runner `unlink`s a stale socket path before `listen` (handles unclean
  shutdown). It MUST refuse to bind if the path resolves outside `/run/jarv1s` (defense against a
  misconfigured env var pointing at a shared mount). **Symmetrically, the api client MUST `realpath`-check
  that `JARVIS_CLI_RUNNER_SOCKET` resolves under `/run/jarv1s` BEFORE it `connect`s** (mirror of the server
  bind check; defends the client against a redirected socket path). The `unlink`→`listen` is not atomic; the
  `0700` uid-owned dir only keeps **other** uids out of that race (the acknowledged non-threat). Against the
  **same-UID** adversary — a compromised CLI that wins the bind race and still satisfies the `realpath`-check —
  the defense is the §3.6 **mutual challenge-response** hello: the imposter cannot prove the secret, so the
  client aborts BEFORE sending any token. Filesystem perms are NOT relied on as the same-UID TOCTOU defense.

### 3.2 Framing — DECISION: length-prefixed JSON (NOT newline-delimited)

**Each message is a 4-byte big-endian unsigned length prefix (`uint32`, network byte order) followed by
exactly that many bytes of UTF-8 JSON.** No delimiter inside the payload; the length is authoritative.

```
┌──────────────┬───────────────────────────────┐
│ len: uint32  │ JSON body (len bytes, UTF-8)   │
│ (big-endian) │                                │
└──────────────┴───────────────────────────────┘
```

**Justification vs newline-delimited JSON (NDJSON):**

1. **`readNew` returns large transcript bodies.** A `readNew` response carries an array of
   `TranscriptRecord`s whose `text` can contain **arbitrary newlines** (assistant replies, multi-line tool
   output, thinking blocks). With NDJSON the framer must escape every `\n` in the JSON (JSON encoding already
   does this — `\n` becomes `\\n`), so NDJSON is _technically_ possible, but it forces the reader to scan
   every byte for an unescaped delimiter and reassemble across chunk boundaries. Length-prefix lets the
   reader allocate exactly `len` bytes and read straight through — **no delimiter scan, no escape ambiguity.**
2. **Partial reads are inherent on a stream socket.** A single `read()` may return a fragment of one message
   or several messages concatenated. The length prefix makes reassembly trivial and unambiguous: buffer
   until ≥4 bytes → read `len` → buffer until ≥`len` bytes → slice exactly one frame → repeat. NDJSON
   reassembly requires holding a growing line buffer and splitting on `\n`, which is more error-prone under
   fragmentation and pathological inputs.
3. **Backpressure & bounds.** A length prefix lets the reader **reject oversized frames before allocating**
   (see `MAX_FRAME_BYTES` below). NDJSON cannot know a message is too large until it finds the delimiter.

**`MAX_FRAME_BYTES = 16 MiB.`** A frame whose declared length exceeds this is a malformed frame: the
receiver **closes the connection** (it cannot trust the stream alignment — see §3.7 for the
malformed-frame-vs-bad-request distinction).

**Chunking is DEFERRED for Phase 1 — no record-boundary chunking.** A `readNew` response is bounded well
under `MAX_FRAME_BYTES` in practice: the api polls every 25ms (`chat-session-manager.ts:121`) and the manager
already bounds replay to a recent window + rolling summary (`listPriorTurns`), so each response carries only
the records appended since `afterOffset` — kilobytes, not megabytes. **If a single `readNew` response WOULD
exceed `MAX_FRAME_BYTES`** (pathological, e.g. one multi-MiB tool-output line), the server returns an
`RpcErr code "internal"` rather than chunk. Record-boundary chunking is explicitly **not** specified in
Phase 1; the under-specified chunking design from v1 is removed. (Re-introducing chunking later does not
change the wire envelope — it would only add a `complete:false` continuation convention.)

### 3.3 The `readNew` transcript offset and JS `Number` precision

`readNew(afterOffset)` and its response `offset` are **offsets into the JSONL transcript treated as a JS
string** — specifically **the number of UTF-16 code units of the JSONL string consumed** (i.e. JS
`String.prototype.length` / `.slice`, NOT byte offsets). This is exactly what the existing code does:
`transcript-reader.ts:86` computes `jsonl.slice(afterOffset)` and `cli-chat-engine.ts:213` returns
`offset: jsonl.length` — both string operations, both UTF-16 code units. **BOTH sides of the RPC treat the
transcript as a JS string.**

> **Do NOT switch to byte offsets.** Byte offsets would force a rewrite of `parseTranscript` (which slices
> the string, not a `Buffer`) and of `cli-chat-engine.readNew`. The contract value is _consistency_, not the
> unit: as long as the server produces `jsonl.length` and the api passes it straight back as `afterOffset`
> (and never reinterprets it), the round-trip is exact. Both `.length` and `.slice` count the same UTF-16
> code units, so the pair is self-consistent. (v1 mislabelled this "byte offset" — corrected here.)

These are JSON numbers. JavaScript's safe-integer ceiling is `Number.MAX_SAFE_INTEGER = 2^53 − 1`. A chat
transcript will never approach that, so a JSON `number` is safe **with a guard**:

- The contract type for `offset`/`afterOffset` is `number` (integer, ≥ 0 — UTF-16 code units, §3.3).
- **Guard:** a `readNew` request whose `afterOffset` is not a non-negative integer `≤ Number.MAX_SAFE_INTEGER`
  is a **semantically-invalid value, NOT a malformed frame**: the server returns `RpcErr code "bad_request"`
  **without closing** the connection (§3.7). (Contrast: a bad _length prefix_ closes the connection.)
- Rationale for not using a string/BigInt: the existing in-process code already uses `number` end-to-end
  (`jsonl.length`, `session.transcriptOffset`), and round-tripping through JSON preserves it exactly within
  the safe range. Introducing BigInt would force a type change in `CliChatEngine` (forbidden — §4.0).

### 3.4 Request / response / error envelope

Every frame body is one JSON object. Three discriminated shapes: **request**, **ok response**, **error
response**. Correlation is by monotonically-increasing `id` (per-connection, client-assigned). **Every
response (ok AND err) carries the server `bootId`** (§5.6) so the api can detect a silent cli-runner restart.

```typescript
/** Client → server. One per RPC call. `id` is unique per connection. */
export interface RpcRequest {
  readonly t: "req";
  readonly id: number; // client-assigned, monotonic per connection, 1..2^53-1
  readonly method: RpcMethod; // see §4
  /**
   * = actorUserId; routes to the per-user engine. OPTIONAL: omitted by the
   * non-session methods listLiveSessions and probeProvider. REQUIRED + non-empty
   * for every other method (launch/submit/readNew/isAlive/kill). A missing or
   * empty sessionKey on a session method ⇒ RpcErr bad_request (§3.7), not a close.
   */
  readonly sessionKey?: string;
  readonly params: unknown; // method-specific; shapes in §4
}

/** Server → client. Success. */
export interface RpcOk {
  readonly t: "ok";
  readonly id: number; // echoes the request id
  readonly bootId: string; // server boot uuid (§5.6); same for every response from one cli-runner process
  readonly result: unknown; // method-specific; shapes in §4
}

/** Server → client. Failure. */
export interface RpcErr {
  readonly t: "err";
  readonly id: number; // echoes the request id
  readonly bootId: string; // server boot uuid (§5.6) — present on errors too, so a restart is detectable mid-failure
  readonly error: RpcError;
}

export interface RpcError {
  /** Stable machine code; the client maps it back to a typed JS error (§4.7). */
  readonly code: RpcErrorCode;
  /** Human-readable, ALREADY redacted server-side via redactSecrets (§6.4). Safe to log. */
  readonly message: string;
}

export type RpcErrorCode =
  | "unavailable" // engine could not launch / multiplexer down / NOT_LAUNCHED → CliChatUnavailableError (retryable HTTP 503)
  | "not_launched" // submit/readNew/isAlive called before a successful launch — maps to RETRYABLE 503 (see §4.7)
  | "bad_request" // semantically-invalid params (bad offset, missing sessionKey) — does NOT close the connection
  | "internal"; // unexpected server-side failure (already redacted)

export type RpcMethod =
  | "launch"
  | "submit"
  | "readNew"
  | "isAlive"
  | "kill" // per-session (sessionKey required)
  | "listLiveSessions" // non-session (reconciliation, §4.6)
  | "probeProvider"; // non-session (onboarding, §4.8)

export type RpcFrame = RpcRequest | RpcOk | RpcErr;
```

**Concurrency on one connection:** the api opens a **single** long-lived connection and may have multiple
in-flight requests (different `id`s, e.g. one user's `readNew` poll while another user's `launch` runs).
Responses may arrive out of order; the client matches by `id`. Per-`sessionKey` ordering is the server's
responsibility (it serializes operations on a single engine instance — see §4.0). The api's
`ChatSessionManager` already enforces turn-at-a-time per user (`turnsInFlight`, `chat-session-manager.ts:116`)
and serializes launches (`launching` map, line 110), so no two conflicting RPCs for the same `sessionKey`
are issued concurrently by a correct client — but the server MUST NOT assume it.

### 3.5 Client connect / reconnect / liveness

- **Connect:** api connects on boot (lazily on first engine use is also acceptable, but connect-on-boot lets
  reconciliation run before any user turn — see §5.4). On `ECONNREFUSED`/`ENOENT` (cli-runner not up yet),
  retry with capped backoff (e.g. 250ms → 2s, jittered). The api's chat surface is "unavailable" (HTTP 503
  via `CliChatUnavailableError`) until the socket connects — identical to today's `unavailableEngineFactory`.
- **Liveness:** an **application-level ping** rides the same envelope is **NOT** added (keep it minimal); the
  socket's connection state IS the liveness signal. If the api needs to probe before streaming, it issues a
  cheap `isAlive` for the relevant `sessionKey` (the grounding map's "first readNew is fine" conclusion
  applies). A half-open connection surfaces as a write `EPIPE`/`ECONNRESET` on the next RPC.
- **Reconnect:** on socket `close`/`error`, the client:
  1. Fails all in-flight requests with `RpcErrorCode "unavailable"` (→ the manager surfaces 503 / the turn
     errors; HTTP-level retry is the recovery path, per the grounding map).
  2. Reconnects with backoff.
  3. **On (re)connect, runs the reconciliation handshake (§5) before serving new turns.** This is mandatory:
     the cli-runner may have restarted (losing all sessions) or the api may have restarted (losing its
     session map while cli-runner kept live `jarv1s-live-*` sessions). Either way the two registries can be
     out of sync, and orphaned MCP tokens / mux sessions must be resolved.
- **Fast-restart detection (`bootId`):** the socket can survive a cli-runner restart invisibly (the api's
  TCP/Unix connection may not see a `close` if cli-runner restarts fast and re-binds). Every response carries
  the server `bootId` (§5.6). The api records the **first** `bootId` it sees; if a later response carries a
  **different** `bootId`, the api treats it as a silent restart: it **fails all in-flight calls**, **blocks
  new calls**, and **runs reconciliation** (§5.3) before serving turns again — exactly as it would on a
  visible reconnect. This closes the silent fast-restart window that a connection-state-only liveness signal
  misses.
- **In-process fallback (host install):** when the api is **not** containerized (host install, no socket env
  var set), the engine factory keeps constructing `CliChatEngineImpl` in-process exactly as today
  (`runtime.ts:54-61`, which reads `JARVIS_CLI_HOME_BASE` at `runtime.ts:58`). The RPC client is selected
  **only** when `JARVIS_CLI_RUNNER_SOCKET` is set. This is the boot-time fork; lane A adds the selection,
  lane C sets the env var only in the compose path.

### 3.6 Connection auth hello (socket access control)

The socket is **not** private from same-UID CLI subprocesses (§3.1). Access control is therefore an
application-level handshake:

- **Shared secret `JARVIS_CLI_RUNNER_RPC_SECRET`** is known ONLY to the api and the cli-runner _server_
  process (both read it from their own env). It is **excluded from the CLI-subprocess env allowlist** (§7.2)
  — a launched `claude`/`codex`/`agy` never sees it.
- **Mutual challenge-response handshake — the secret is NEVER sent on the wire.** Under the same-UID adversary
  a malicious CLI could win the §3.1 bind race and impersonate the _server_; a client that sent the secret
  first would hand `JARVIS_CLI_RUNNER_RPC_SECRET` to the imposter. So neither side transmits the secret — both
  **prove knowledge** of it over exchanged nonces (HMAC-SHA256), in three length-prefixed frames before any
  `RpcRequest`:
  ```typescript
  /** Client → server, FIRST frame. */
  export interface RpcHello {
    readonly t: "hello";
    readonly clientNonce: string;
  } // random 32-byte hex
  /** Server → client: proves it holds the secret AND challenges the client. */
  export interface RpcHelloChallenge {
    readonly t: "hello-challenge";
    readonly serverProof: string; // HMAC_SHA256(secret, "S" + clientNonce)
    readonly serverNonce: string; // random 32-byte hex
  }
  /** Client → server: proves it holds the secret. */
  export interface RpcHelloResponse {
    readonly t: "hello-response";
    readonly clientProof: string; // HMAC_SHA256(secret, "C" + serverNonce)
  }
  ```
- Flow: client sends `clientNonce`; server replies with `serverProof` + `serverNonce`. **The client verifies
  `serverProof` BEFORE sending anything else** — a wrong/absent proof ⇒ the client closes and never reveals a
  token to the (imposter) peer. The client then sends `clientProof`; the server verifies it (constant-time
  compare) and either proceeds to normal request/response framing or **closes immediately** (no error frame).
  The `"S"`/`"C"` domain-separation tags prevent a reflected proof; an unset secret on either side ⇒ immediate
  close. Proofs and nonces are never logged (§6.4).
- This handshake does **not** weaken the filesystem/volume boundary (which still keeps other containers out);
  it adds the missing defense against a compromised same-UID CLI subprocess opening the socket.

### 3.7 Malformed frame vs semantically-invalid request

Two distinct failure modes, deliberately disambiguated:

- **A malformed FRAME closes the connection** (the stream can no longer be trusted to be aligned): a bad
  length prefix, a body that is not valid JSON, an oversize frame (> `MAX_FRAME_BYTES`, §3.2), an unknown
  `t` discriminant, or a first frame that is not a valid `hello` (§3.6). The receiver closes; the api treats
  the close as a reconnect (§3.5) and reconciles.
- **A well-formed frame with a semantically-invalid value returns `RpcErr bad_request` WITHOUT closing.**
  Examples: a `readNew` `afterOffset` out of range (§3.3), a session method with a missing/empty `sessionKey`
  (§3.4), unknown `method`, or malformed `params` for a known method. The connection stays open; the api maps
  it to a typed error (§4.7) and the user retries.

---

## 4. METHODS

### 4.0 Invariant: the `CliChatEngine` interface is the contract boundary and MUST NOT change

`packages/chat/src/live/types.ts:31-41` defines the interface. **The split changes ONE signature:
`launch` now returns the post-drain transcript `offset`** (see §4.1.2 and the rationale below):

```typescript
export interface CliChatEngine {
  readonly provider: ProviderKind; // "anthropic" | "openai-compatible" | "google"
  launch(opts: EngineLaunchOpts): Promise<{ offset: number }>; // CHANGED from Promise<void> (§4.1.2)
  submit(text: string): Promise<void>;
  readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }>;
  isAlive(): Promise<boolean>;
  kill(): Promise<void>;
}
```

> **Why `launch` must return `{ offset }` (the single biggest correctness fix in v2).** When cli-runner
> owns the replay-drain (§4.1), the manager **cannot** keep seeding `session.transcriptOffset = 0` — the
> drained replay text has already been written to the transcript. If the first `readNew(0)` ran after a
> drained launch, it would re-read the replay block and emit it as the assistant's reply. `launch` therefore
> returns the **offset at the end of the server-side drain**, and the manager seeds
> `session.transcriptOffset` from it on BOTH the RPC and in-process paths (§4.1.2). An in-process engine that
> does not own the drain returns `{ offset: 0 }` (the manager keeps draining itself, as today).

The api-side `ChatEngineRpcClient` **implements this interface verbatim** (including the new `launch` return
type) so `ChatSessionManager`, `createRealEngineFactory`, the integration `FakeLiveEngine`, and all existing
unit tests stay green — **note:** `FakeLiveEngine` and the `cli-chat-engine` / `chat-session-manager` /
`chat-live-api` test suites must be updated to the new `launch(): Promise<{ offset }>` return type (§11
Testing). The RPC marshals each method across the socket. `provider` is known to the client at construction
time (the factory passes it), so it is NOT an RPC.

**One engine per `sessionKey` on the server.** `sessionKey === actorUserId` (set at
`chat-session-manager.ts:162`; the mint call that captures it is `chat-session-manager.ts:164`), used as the
multiplexer session name suffix `jarv1s-live-${threadKey}` (`cli-chat-engine.ts:150`). The cli-runner holds a
`Map<sessionKey, CliChatEngineImpl>`. The server serializes operations per `sessionKey` (a per-key async
queue) so a `submit` can't interleave a `kill`. **The Map is not the only source of truth for liveness:**
`kill` and `listLiveSessions` operate on the canonical mux session names directly so they work for orphans
the Map doesn't know about (post-restart) — see §4.5 and §4.6.

`TranscriptRecord` is reused **verbatim** from `types.ts:12-19` — no new fields, no renames:

```typescript
export type ChatRecordKind =
  | "user"
  | "thinking"
  | "tool"
  | "status"
  | "reply"
  | "error"
  | "action_request"
  | "action_result";
export interface TranscriptRecord {
  readonly kind: ChatRecordKind;
  readonly text: string;
  readonly actionRequestId?: string;
  readonly toolName?: string;
  readonly summary?: string;
  readonly outcome?: "executed" | "denied" | "error";
}
```

### 4.1 `launch` — CRITICAL DESIGN CALL

#### 4.1.0 `EngineLaunchOpts` extension (lane A, in `types.ts`)

`EngineLaunchOpts` (`types.ts:21-28`) is **extended additively** — every existing field
(`neutralDir`, `personaPath`, `mcpConfigPath?`, `mcpToken?`, `mcpServerUrl?`) is kept unchanged, and two new
**optional** fields are added:

```typescript
export interface EngineLaunchOpts {
  readonly neutralDir: string; // unchanged — used by the in-process engine
  readonly personaPath: string; // unchanged — used by the in-process engine
  readonly mcpConfigPath?: string; // unchanged
  readonly mcpToken?: string; // unchanged
  readonly mcpServerUrl?: string; // unchanged
  readonly personaText?: string; // NEW — rendered persona CONTENT (for the RPC path)
  readonly replayBatch?: string; // NEW — assembled replay string (for the RPC path)
}
```

This is **back-compatible**: the in-process `CliChatEngineImpl` ignores `personaText`/`replayBatch` and keeps
using `personaPath`; the RPC client uses `personaText`/`replayBatch` and ignores the paths.

**Who populates what (the manager owns this, BOTH paths):** `ChatSessionManager.launchSession`
(`chat-session-manager.ts:147`) populates `personaText` (the rendered persona) **and** `replayBatch` on
**every** launch, for **both** the in-process and RPC engines. The api-side
`ChatEngineRpcClient.launch` serializes **only** `personaText` + `replayBatch` + `mcpToken` + `mcpServerUrl` +
`provider` into `RpcLaunchParams` and **DROPS** `neutralDir` + `personaPath` (the api has no CLI-data mount;
those paths are meaningless cross-container). The in-process `CliChatEngineImpl` continues to read
`neutralDir`/`personaPath` and ignores the two new fields.

#### 4.1.0a Single-active-user gate (Phase 1, until #347) — FROZEN REQUIREMENT

> **Single-active-user gate (Phase 1, until #347):** while UID-separation is absent, the cli-runner server
> admits **AT MOST ONE live session** across all `sessionKey`s. A `launch` RPC for a `sessionKey` is rejected
> with `RpcErr { code: 'unavailable' }` (redacted message) whenever a _different_ `sessionKey` is currently
> live, until that session is killed. Controlled by env flag `JARVIS_CLI_RUNNER_SINGLE_USER` (default `1` =
> ON; set `0` only when UID-separation #347 lands). Added error path reusing the existing `unavailable` code
> — **NO wire-contract change.** Owner: **Lane B** (cli-runner server).

**Liveness is measured from DISK-backed MUX state plus the server's in-memory reservations and engine registry (CRITICAL — this is the property the gate guarantees).** The
safety property is _no two users' `0600` token dirs co-resident_ under `<JARVIS_CLI_NEUTRAL_BASE>`. The
in-memory `Map<sessionKey, engine>` is **NOT** a sufficient liveness signal: across an unclean cli-runner
**restart** the Map is empty while the prior session's `jarv1s-live-*` mux session **and its on-disk `0600`
token dir survive** (§6.5 cleans dirs only on `kill`/failed-launch, never on restart). A different user's
`launch` would then pass a Map-only gate while the prior token dir is still resident — exactly the
co-residency #347 forbids. Therefore the gate is frozen as:

1. **`liveKeys` = the MUX ENUMERATION ∪ the SERVER's in-flight-launch RESERVATION set ∪ engine-registry keys — never the engine `Map` alone, never the api's `launching` map.** The api-side `launching` map (§5.4) is **invisible to the
   cli-runner server** and MUST NOT be relied on; the server keeps its **own** `Set<sessionKey>` of in-flight
   launches. Admission runs in a **single global async-critical-section** — one server-wide mutex, **NOT** the
   §4.0 per-`sessionKey` queue (which does not serialize _cross_-key launches; §3.4 forbids assuming the client
   serializes). Holding the mutex, the server computes `liveKeys = listLiveSessions-by-mux (§4.6) ∪ reservations ∪ engine-registry keys`; if any key `≠ K` is present it releases the mutex and returns `unavailable`; otherwise it
   **atomically adds `K` to `reservations`**, releases the mutex, and only THEN creates the mux session outside
   the lock. `K` is removed from `reservations` on mux-create success **or** on any launch failure (a
   `finally`). **The out-of-lock mux-create + launch MUST be bounded by a timeout** (e.g. the existing
   `launchMs` boot budget plus a margin): if it does not settle in time the launch fails with `unavailable`
   and the `finally` releases `K` — so a wedged/hung tmux server can NEVER strand `K` in `reservations` and
   freeze the gate (single-user-for-`K`) until a process restart (fail-safe recovery; reservation release is
   guaranteed by promise-settle **and** by timeout). This reservation closes the TOCTOU window in which two
   concurrent cross-key `launch` RPCs would both pass the gate before either's `jarv1s-live-*` session exists.
2. **Startup CLEAN-SLATE sweep (cli-runner, BEFORE accepting connections).** A container restart
   (`restart: unless-stopped`) kills cli-runner's forked tmux server (§7.1), so there may be **zero** live mux
   sessions to enumerate while the `<JARVIS_CLI_NEUTRAL_BASE>/<sessionKey>` token dirs **persist on the named
   auth/home volume** (§8) — a mux-only sweep would miss them. So the sweep is clean-slate: (a) kill every
   `jarv1s-live-*` mux session that does exist (kill-by-mux-name §4.5), **and (b) `rm -rf` every `<sessionKey>`
   dir directly under `<JARVIS_CLI_NEUTRAL_BASE>` (`/data/cli-auth/chat/*`) UNCONDITIONALLY** — the gate
   guarantees ≤1 live session so a fresh process legitimately has zero. After the sweep no foreign `0600` token
   dir survives into the next launch; the gate's liveness set starts empty and truthful. The api's §5.3
   reconciliation still runs on reconnect as defence-in-depth, but the gate no longer **depends** on it having
   run first.

Both reuse existing machinery (kill-by-mux-name §4.5, `listLiveSessions`-by-mux §4.6, §6.5 dir removal) and
introduce **no wire/envelope change.**

**Why this is here.** The per-session `0600` token files are readable by any same-UID CLI subprocess (§13),
so two _concurrent_ live sessions would each be able to read the other's token file. Until UID-separation
(issue **#347**) lands, the gate enforces isolation by ensuring only one engine — hence one live session's
secret files — exists at a time. This is the **HARD RUNTIME GATE that MUST land in Phase 1**, standing in for
the deferred UID separation. It does not add, remove, or alter any wire shape: a rejected cross-user `launch`
returns the already-defined `RpcErr` with the already-defined `unavailable` code (§3.4 / §4.7). When
`JARVIS_CLI_RUNNER_SINGLE_USER=0` (only after #347 lands), the gate is disabled and concurrent engines are
allowed. `JARVIS_CLI_RUNNER_SINGLE_USER` is **cli-runner-server config only** — it is NOT in the §7.2
CLI-subprocess env allowlist.

#### 4.1.1 The launch decision

**Today** `EngineLaunchOpts` carries `neutralDir` + `personaPath` (api-side filesystem paths). In the split,
**neutralDir and the persona file live on the cli-runner side** (the auth/home volume) — the api has no
CLI-data mount and cannot write them. So the api cannot pass paths over the socket.

**Decision:** `launch` carries **persona CONTENT** (`personaText`) and the **replay batch** as a string; the
cli-runner derives `neutralDir` from `sessionKey`, writes the persona file under it, injects the MCP token,
launches the CLI, and (if a replay batch is present) submits it and drains it server-side, returning the
post-drain `offset`.

This **moves the replay/drain into the launch RPC** (today `ChatSessionManager.launchSession` does
`engine.submit(replayBlock)` then drains at lines 199-201). Folding replay into `launch` keeps the replay
text — which is user-authored conversation history (`renderReplayBlock`) — flowing through a single RPC and
lets the server own the post-launch drain (it owns the transcript file). The api still **builds** the replay
string (it owns persistence + persona rendering + recall seed); it just ships the finished string.

> **Refactor note for lane A (api manager):** `ChatSessionManager.launchSession` changes so that it passes
> `personaText` + `replayBatch` into `launch` (for both engine kinds). For the RPC engine the server writes
> the persona file and runs `submit`+drain; for the in-process engine the manager still renders to a file
> (`personaPath`) and the engine ignores the new fields, and the manager keeps its own post-launch drain
> (lines 194-202). The persona **rendering** (`resolveChatPersona`, recall seed,
> `renderReplayBlock`/`renderSummaryBlock`) stays api-side (it needs persistence + recall, which are not on
> cli-runner). Only the **file write + drain** move server-side for the RPC path.

#### 4.1.1a The exact `launch` payload

```typescript
/** params for method "launch". */
export interface RpcLaunchParams {
  /** Selects the CLI + transcript parser. Mirrors CliChatEngine.provider. */
  readonly provider: "anthropic" | "openai-compatible" | "google";
  /**
   * Rendered persona CONTENT (NOT a path). cli-runner writes it to the persona file
   * under the server-derived neutralDir, then passes that path to the CLI via
   * --append-system-prompt-file (Claude) etc. This is the full text produced by the
   * api's resolveChatPersona() (DEFAULT_JARVIS_PERSONA + rendered persona block).
   */
  readonly personaText: string;
  /**
   * Opaque per-session MCP bearer token (jst_<uuid>), minted + owned by the API
   * (session-tokens.ts). Crosses to cli-runner ONLY here, in this socket payload.
   * NEVER via env, argv, or a launch line. cli-runner injects it per-provider (§6.2).
   * Absent ⇒ launch the CLI with NO MCP server (tools disabled), exactly as today
   * when mcpToken is falsy (cli-chat-engine.ts:344 `--tools ""`).
   */
  readonly mcpToken?: string;
  /** MCP gateway base URL (api-side, reachable from cli-runner over the jarv1s network). */
  readonly mcpServerUrl?: string;
  /**
   * The prior-conversation replay batch as ONE string (memory seed + rolling summary +
   * recent turns), already assembled + injection-neutralized by the api
   * (renderMemorySeedBlock / renderSummaryBlock / renderReplayBlock joined by "\n\n").
   * Absent or "" ⇒ no replay (fresh conversation). When present, cli-runner submits it
   * after the CLI boots and drains the transcript so the first real turn starts from a
   * clean offset (replaces chat-session-manager.ts:194-202).
   */
  readonly replayBatch?: string;
}

/**
 * result for method "launch". Carries the post-drain transcript offset (§4.1.2):
 * after the server launches the CLI and (if replayBatch present) submits+drains it,
 * `offset` is the transcript length consumed so far (jsonl.length / UTF-16 code units,
 * §3.3). The api seeds session.transcriptOffset from this so the FIRST real readNew
 * does not re-read the replay as the reply.
 */
export interface RpcLaunchResult {
  readonly offset: number;
}
```

- **`neutralDir` is NOT in the payload.** cli-runner derives it deterministically from `sessionKey`:
  `JARVIS_CLI_NEUTRAL_BASE/<sessionKey>` (default base `/data/cli-auth/chat`, on the auth/home volume — §8).
  This mirrors today's `renderPersona({ userId, ..., baseDir: neutralBase })` (`runtime.ts:119`
  `resolveChatHome()` → manager `neutralBase`), just relocated into cli-runner. The derivation MUST sanitize
  `sessionKey` (it is a user UUID; reject anything with `/`, `..`, or NUL before joining).
- **`personaPath` is NOT in the payload.** cli-runner writes `personaText` to
  `<neutralDir>/persona.md` (or the existing persona filename) `0600` and passes that path to the CLI.
- **Errors:** a launch failure (multiplexer down, missing CLI binary, persona write failure) → `RpcErr` with
  `code: "unavailable"` and a **redacted** message (§6.4). The api client throws `CliChatUnavailableError`
  (→ HTTP 503), preserving today's behavior (`cli-chat-engine.ts:166`). On any failed launch the server
  removes the whole per-session neutral dir (§6.5) before returning the error.
- **Single-active-user gate (§4.1.0a):** when `JARVIS_CLI_RUNNER_SINGLE_USER` is ON (default), a `launch`
  whose `sessionKey` differs from the currently-live `sessionKey` is rejected with `RpcErr code "unavailable"`
  (redacted) until that live session is killed — the same `unavailable` path, no new wire shape.

#### 4.1.2 Post-drain offset seeding (both paths)

`launch` returns `{ offset }` (§4.0). The manager seeds `session.transcriptOffset = result.offset` on
**both** the RPC and in-process paths:

- **RPC path:** the server submits `replayBatch` (if present), drains the transcript to a clean boundary, and
  returns `offset = jsonl.length` after the drain. The manager seeds it and runs **no** further drain.
- **In-process path:** `CliChatEngineImpl.launch` does not own the drain, so it returns `{ offset: 0 }`; the
  manager keeps its existing `submit(replayBatch)` + drain (`chat-session-manager.ts:194-202`) and overwrites
  `session.transcriptOffset` from its own drain, exactly as today.

This is what prevents the first `readNew` from re-reading the replay block as the assistant reply.

#### 4.1.3 `personaText` + `replayBatch` are REBUILT on EVERY launch (never cached client-side)

The manager rebuilds **both** `personaText` and `replayBatch` from live state on **every** launch — never
caches them in the engine or the RPC client. "Every launch" means: the initial launch, a relaunch after idle
reap, `switchProvider`, and a post-reconnect respawn. Rationale: persona settings, the recall seed, the
rolling summary, and the recent-turn window can all change between launches; a cached batch would replay
stale context. In particular, `switchProvider` (`chat-session-manager.ts:302`) kills the old engine and
re-`ensureSession`s, which produces a **freshly-rendered `replayBatch` for the target provider** (the replay
is plain conversation text, provider-agnostic, but it is re-assembled from current persistence each time).

### 4.2 `submit`

```typescript
export interface RpcSubmitParams {
  readonly text: string;
}
export interface RpcSubmitResult {
  readonly ok: true;
}
```

- Server applies the existing leading-`!` sanitize (`sanitizeInput`, `cli-chat-engine.ts:411`) — it already
  does, since `CliChatEngineImpl.submit` runs unchanged on the server. The client passes raw `text`.
- Called before a successful `launch` for the `sessionKey` ⇒ `RpcErr code "not_launched"`.

### 4.3 `isAlive`

```typescript
export interface RpcIsAliveParams {} // empty
export interface RpcIsAliveResult {
  readonly alive: boolean;
}
```

- Maps to `CliChatEngineImpl.isAlive()` (`cli-chat-engine.ts:216`). No engine for the `sessionKey` ⇒
  `{ alive: false }` (NOT an error — mirrors `handle === null` returning false at line 217).

### 4.4 `readNew`

```typescript
export interface RpcReadNewParams {
  /** Offset into the JSONL transcript as a JS string (UTF-16 code units, §3.3); non-negative integer ≤ Number.MAX_SAFE_INTEGER. */
  readonly afterOffset: number;
}
export interface RpcReadNewResult {
  /** EXISTING TranscriptRecord shape, reused verbatim (types.ts:12-19; §4.0). */
  readonly records: TranscriptRecord[];
  /** New offset = jsonl.length (cli-chat-engine.ts:213; UTF-16 code units, §3.3). Pass back as afterOffset next poll. */
  readonly offset: number;
  /** True once the engine detects end-of-turn for the provider (transcript-reader completion signal). */
  readonly complete: boolean;
}
```

- Direct passthrough of `CliChatEngineImpl.readNew(afterOffset)` (`cli-chat-engine.ts:180-214`). cli-runner
  reads the transcript file (it owns the auth/home volume), parses it via `parseTranscript`, and returns
  records. **The api never reads a transcript file** — this is the core isolation win.
- **Not-yet-created transcript** (Codex/Gemini name their file on first write): the server returns
  `{ records: [], offset: afterOffset, complete: false }` (lines 191/200), preserving the caller's offset.
- **Offset validation:** an `afterOffset` out of §3.3 range ⇒ `RpcErr code "bad_request"` **without closing**
  the connection (§3.7).
- **Frame size (no chunking — §3.2):** each `readNew` response is bounded well under `MAX_FRAME_BYTES` by the
  incremental design (records appended since `afterOffset`) and `listPriorTurns`' bounded replay window. If a
  single response WOULD exceed `MAX_FRAME_BYTES` (pathological, e.g. a multi-MiB single tool-output line) the
  server returns `RpcErr code "internal"` rather than chunk. Record-boundary chunking is deferred for
  Phase 1.

### 4.5 `kill`

```typescript
export interface RpcKillParams {} // empty
export interface RpcKillResult {
  readonly ok: true;
}
```

- Maps to `CliChatEngineImpl.kill()` (`cli-chat-engine.ts:221`): kills the mux session, removes the
  per-session secret files (§6.5), and drops the per-`sessionKey` engine from the server registry.
  **Idempotent** — killing an absent session is `{ ok: true }`, never an error (mirrors the existing
  idempotent `mux.kill`).
- **Kill MUST work without an engine object in the Map.** A post-restart cli-runner may hold a live
  `jarv1s-live-<sessionKey>` mux session it has no `CliChatEngineImpl` for (the Map was wiped by the
  restart). `kill(sessionKey)` therefore kills **by the canonical mux name** `jarv1s-live-<sessionKey>`
  (sanitizing `sessionKey` first, §4.1.1a) — asking the multiplexer to kill that session directly — even when
  the Map has no entry. It then also removes the per-session neutral dir (§6.5) if present. This is what lets
  the api's reconciliation (§5.3) reap orphaned mux sessions after an api restart.
- The api calls `kill` on `/clear` (`chat-session-manager.ts:290`), `switchProvider` (`:305`), and idle-reap
  (`:347`). **MCP-token revocation stays api-side** (the api owns the registry — §5). `kill` does NOT revoke
  a token; the api revokes it after a successful `kill` exactly as today.

### 4.6 `listLiveSessions` — the reconciliation primitive

```typescript
/** No sessionKey on the request (instance-wide query). params is empty. */
export interface RpcListLiveSessionsParams {}
export interface RpcListLiveSessionsResult {
  /** Every sessionKey for which cli-runner currently holds a LIVE jarv1s-live-* mux session. */
  readonly sessionKeys: string[];
}
```

- The server **MUST enumerate the actual live `jarv1s-live-*` mux sessions via the multiplexer** (e.g. tmux
  `list-sessions` filtered to the `jarv1s-live-` prefix), **not only its `Map<sessionKey, …>`**. After a
  cli-runner restart the Map is empty while real mux sessions may still be running; enumerating only the Map
  would hide those orphans from reconciliation. The server strips the `jarv1s-live-` prefix to recover each
  `sessionKey` and returns the set of genuinely-alive keys. This is the **single source of truth** the api
  reconciles against (§5), and the **same enumeration the §4.1.0a single-active-user gate and the §6.5 startup
  clean-slate sweep consume** (the gate's `liveKeys` = this set ∪ the **cli-runner server's own
  in-flight-launch reservation set**, §4.1.0a — **NOT** the api-side `launching` map, which the server cannot
  observe; that map feeds api-side _reconciliation_ only, §5.4); none of the three rely on the in-memory engine
  `Map`. Used by the api's reconciliation driver and the server-side gate, never per turn.
- **Authorization on the non-session verbs:** `listLiveSessions` (like `probeProvider`) returns instance-wide
  data with no `sessionKey` scope; the §3.6 connection auth hello is the **sole** gate on these verbs — safe
  because only the api holds `JARVIS_CLI_RUNNER_RPC_SECRET` and the CLI subprocesses are excluded from it
  (§6.6 / §7.2).

### 4.7 Error → typed-JS mapping (api client side)

| `RpcErrorCode` | api client throws                                              | HTTP (via existing route mapping)                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unavailable`  | `CliChatUnavailableError` (`packages/chat/src/live/errors.ts`) | 503 (retryable)                                                                                                                                                                                   |
| `not_launched` | `CliChatUnavailableError`                                      | **503 (retryable)** — a missing engine is a transient/recoverable condition (the next turn relaunches), NOT a 500. Mapping it to 500 would surface a hard error for a routinely-recoverable race. |
| `bad_request`  | `Error`                                                        | 500                                                                                                                                                                                               |
| `internal`     | `Error`                                                        | 500                                                                                                                                                                                               |

The error `message` is **already redacted server-side** (§6.4) before it crosses the socket, so the api may
log it directly. The api MUST NOT reconstruct or request a stack trace over the socket (stacks can embed the
token-bearing launch line — see `redactCause`, `cli-chat-engine.ts:448-455`).

### 4.8 `probeProvider` — onboarding provider check (non-session)

```typescript
/** No sessionKey on the request (instance-wide query). */
export interface RpcProbeProviderParams {
  readonly provider: "anthropic" | "openai-compatible" | "google";
}
export interface RpcProbeProviderResult {
  /** EXISTING OnboardingProviderCheckResponse shape (onboarding-api.ts:44-47), reused verbatim. */
  readonly status: "ready" | "needs_login" | "not_installed" | "multiplexer_unavailable" | "error";
  readonly message?: string;
}
```

**Why this verb exists (design fork — DECISION: ADD NOW).** Once the CLIs move into cli-runner, the api can
no longer run `claude`/`codex auth status` or `agy --print` in-process — the binaries and their auth are not
in the api container. The onboarding probe must run **inside cli-runner**. So the live auth-status logic
(claude/codex `auth status`, `agy --print`, the PATH-presence check, the multiplexer-usable check) **MOVES
to cli-runner** behind this verb, and the api's `makeProviderConnectionCheckProbe` +
`makeCliPresentProbe` call `probeProvider` over the socket instead of spawning CLIs.

- **Runs with NO MCP token and NO replay** — it is a pure presence/auth check, not a chat launch. It must
  never mint, inject, or require a token.
- Returns the existing transient `OnboardingProviderCheckStatus` values **including `multiplexer_unavailable`**
  (a cli-runner-wide condition surfaced here, not a per-provider lifecycle state — §9.1).
- `message` is redacted server-side (§6.4) like any other error string before crossing the socket.
- It is a **non-session** method: no `sessionKey`. The api uses it only from the onboarding path, never per
  turn.

---

## 5. MCP TOKEN OWNERSHIP + RECONCILIATION

### 5.1 Ownership (unchanged by the split)

The **API mints, tracks, refreshes, and revokes** MCP session tokens via `SessionTokenRegistry`
(`packages/ai/src/gateway/session-tokens.ts`) — in-memory `Map<token, {identity, expiresAt}>`, keyed within
identity by `chatSessionId === actorUserId`. Mint happens in the api's `mcpTokenLifecycle.mint`
(`packages/chat/src/routes.ts:142-157`), capturing the actor's `allowedToolNames`. **cli-runner cannot mint
or revoke** — it only _injects_ the token the api hands it at `launch` (§6.2). This is the plan's
"MCP tokens are API-owned; cli-runner can't revoke them" decision (plan §3, R4).

The token reaches the gateway when the CLI (inside cli-runner) calls `POST /api/mcp` with
`Authorization: Bearer jst_<uuid>` (`packages/chat/src/mcp-transport.ts`). The api verifies it against its
own registry. So the trust chain is: api mints → api → (socket `launch`) → cli-runner injects → CLI →
(HTTP `/api/mcp`) → api verifies. The token never touches the worker, the web container, or any disk the api
can read.

### 5.2 The drift problem

Because the two registries are independent (api: token registry + `ChatSessionManager.sessions` map;
cli-runner: live `jarv1s-live-*` mux sessions), a restart of either side can desync them:

- **cli-runner restarts** (or crashes): all mux sessions die. The api still holds valid tokens + `sessions`
  entries for users whose engines are now gone → **orphaned tokens** (valid bearer tokens for dead sessions)
  and stale `sessions` entries.
- **api restarts:** `SessionTokenRegistry` (in-memory) is wiped AND `ChatSessionManager.sessions` is wiped,
  but cli-runner keeps live `jarv1s-live-*` mux sessions running with CLIs still holding the **old** token
  string in their `--mcp-config` / token env file → **orphaned mux sessions** (live CLIs whose token the api
  no longer recognizes). Those CLIs' MCP calls will 401 (token gone from the registry), but the sessions
  themselves keep running and must be reaped.

### 5.3 The ONE authoritative reconciliation (runs on every socket (re)connect AND on bootId change)

There is **exactly one** reconciliation routine, driven by the **api** (it owns the registries). It runs on
every socket (re)connect (§3.5) and on a detected `bootId` change (§5.6). It is built from three **frozen**
new APIs:

```typescript
// packages/ai/src/gateway/session-tokens.ts  (lane D)
listSessionIds(): string[];                         // every chatSessionId the registry currently holds a token for
reconcile(liveSessionIds: Set<string>): void;       // revoke every token whose chatSessionId ∉ liveSessionIds

// packages/chat/src/live/chat-session-manager.ts   (lane D)
reconcileLiveSessions(liveKeys: Set<string>): Promise<void>;  // the orchestrator below
```

`listSessionIds()` is the **source for orphan-token revocation** — critically, **the `sessions` Map may be
empty after an api restart, so the token registry (not the Map) is what tells us which tokens exist.** The
routine:

1. **`listLiveSessions`** → `liveKeys: Set<sessionKey>` (the authoritative set of sessionKeys cli-runner
   actually has alive — §4.6, enumerated by mux, not the server Map).
2. **Orphan-token revoke (token registry is the source).** For every `sessionId` in
   `tokens.listSessionIds()` **absent from `liveKeys`** → `tokens.revoke`/`reconcile` revokes it. This
   catches tokens the api holds for sessions cli-runner no longer has (e.g. after a cli-runner crash) **even
   when the `sessions` Map is empty** (api restart). `tokens.reconcile(liveKeys)` does exactly this sweep.
3. **Drop stale api sessions.** For every `sessionKey` in `ChatSessionManager.sessions` **absent from
   `liveKeys`** (cli-runner restarted; api kept a `sessions` entry) → drop it from `sessions` and revoke its
   token. The next `submitTurn` lazily relaunches (today's respawn-and-replay path) — safe because the
   conversation persists in the DB.
4. **Kill orphaned mux sessions.** For every `sessionKey` in `liveKeys` that `ChatSessionManager.sessions`
   does **not** know about (api restarted; cli-runner kept the session) → the api issues `kill` (§4.5) for
   that `sessionKey`. cli-runner tears down the orphaned `jarv1s-live-*` session **by mux name** (the Map may
   not hold it — §4.5). The CLI in it was holding a now-unknown token anyway.

`reconcileLiveSessions(liveKeys)` performs steps 2–4 (it calls `tokens.reconcile`, diffs `liveKeys` against
`this.sessions`, drops/revokes the stale ones, and issues `kill` RPCs for the api-unknown live ones). After
it returns, the api's token registry and `sessions` map are consistent with cli-runner's live set.

### 5.4 Races vs in-flight turns and the 30-min idle reap

- **The per-manager async mutex (frozen).** Reconciliation runs **under a single async mutex on the
  `ChatSessionManager`, SHARED with `reapIdle`** (§5.5) — the two MUST be mutually exclusive because both
  mutate `sessions` + revoke tokens. Lane D adds this mutex and wraps both `reconcileLiveSessions` and
  `reapIdle` in it.
- **Treat a launching key as live for the WHOLE launch window.** A `sessionKey` in the `launching` map
  (`chat-session-manager.ts:110`) is mid-launch and MUST be treated as **live** by reconciliation —
  not killed, not dropped, and its token not revoked — for the **entire window from launch-request-sent to
  launch-response-received** (not merely while the promise is pending in some narrower sense). Because the
  manager already serializes launches per user and reconciliation holds the mutex, the window is bounded; but
  reconciliation must explicitly union `liveKeys` with the current `launching` keys before computing the
  orphan/stale diffs.
- **In-flight turn during reconnect:** if the socket drops mid-turn, the in-flight `submit`/`readNew` fails
  with `unavailable` (§3.5); the turn errors at the HTTP layer and the user retries (idempotent at the HTTP
  level). Reconciliation then runs on reconnect **before** the next turn is served.
- The TTL backstop (60 min, `session-tokens.ts:35`) is the final safety net: any token reconciliation misses
  still self-expires.
- **Idempotency:** the handshake is idempotent — running it twice is a no-op once consistent. A `kill` for an
  already-dead `sessionKey` returns `{ ok: true }` (§4.5). A `revokeBySessionId` for an absent session is a
  no-op (`session-tokens.ts:106`).

### 5.5 Who runs the idle reaper

**`reapIdle` has NO production caller today** (confirmed against `ff34061`: `reapIdle`
(`chat-session-manager.ts:343`) is defined but no production scheduler invokes it). The split does not change
that fact. Lane D owns the resolution and MUST pick **one** of:

- **(a) Wire it.** Add an api `setInterval` that calls `manager.reapIdle()` **under the shared §5.4 mutex**
  (so it cannot race reconciliation); `reapIdle` now issues `kill` RPCs over the socket. This is the
  preferred outcome.
- **(b) Explicitly defer it.** Leave `reapIdle` unwired and **state in the PR that reconciliation works
  WITHOUT it** — the §5.6 bootId-driven + reconnect-driven reconciliation, plus the 60-min token TTL
  backstop, are sufficient to prevent leaked tokens/zombie sessions even with no idle reaper. Reconciliation
  does not depend on `reapIdle` running.

Either way the §5.4 mutex is the invariant: if `reapIdle` IS wired, it shares the mutex; if it is NOT, the
mutex still guards reconciliation against concurrent launches.

### 5.6 Server `bootId` (silent fast-restart detection)

cli-runner generates a fresh **`bootId` (a uuid) at process start** and stamps it on **every** `RpcOk` and
`RpcErr` envelope (§3.4 — envelope-level, not per-method). The api:

1. Records the **first** `bootId` it observes after (re)connect.
2. On any subsequent response whose `bootId` **differs** from the recorded one, treats it as a silent
   cli-runner restart: **fails all in-flight calls** (`unavailable`), **blocks new calls** until
   reconciliation completes, **runs reconciliation** (§5.3), then records the new `bootId` and resumes.

This closes the window where cli-runner restarts so fast the socket never reports a `close`, so the api would
otherwise keep using a connection to a process that has lost every session (and is replying with a stale or
empty state). The `bootId` is opaque; the api never interprets its value beyond equality.

---

## 6. SECRETS DISCIPLINE

### 6.1 Hard rule

**NO secret in any tmux `send-keys` launch line, process argv, log, or `capture-pane` output.** "Secret" here
means the MCP bearer token (`jst_<uuid>`) and any provider auth. The MCP token crosses api → cli-runner
**ONLY** via the socket `launch` payload (§4.1.1a `mcpToken`) — never an env var, never a launch line, never a
CLI argument visible in `ps`/`/proc/<pid>/cmdline`.

### 6.2 Per-provider injection (cli-runner side), with Claude's token moved off the launch line

Today (`cli-chat-engine.ts`):

- **Claude (`anthropic`):** the token is **inline in the `--mcp-config` JSON on the launch line**
  (`buildClaudeCommand`, lines 331-343: `headers: { Authorization: "Bearer jst_..." }`). **This is the leak
  surface to close.** The token appears in the `tmux send-keys` line, in argv, and in `capture-pane`.
- **Codex (`openai-compatible`):** **already correct** — the token is written to a `0600` file
  `<neutralDir>/.jarvis-mcp-token.env` (`writeCodexTokenEnv`, lines 382-395) and the launch line only
  references the **env-var name** `JARVIS_MCP_TOKEN` via `-c 'mcp_servers.jarvis.bearer_token_env_var=...'`
  (lines 358-366). No token in argv.
- **Gemini (`google`):** the token is written into `<neutralDir>/.gemini/settings.json` (`launch`, lines
  119-137); the launch line is just `agy --sandbox` (line 378). No token in argv. **Already correct.**

**Required change (lane B):** Claude's token MUST move off the launch line into a `0600` file, the same way
Codex does it. Specify the mechanism:

- cli-runner writes the **full `--mcp-config` JSON** (including the `Authorization: Bearer jst_...` header) to
  a `0600` file `<neutralDir>/.jarvis-claude-mcp.json`, owned by the run uid, created before launch and
  removed on `kill`/failed-launch (mirror `writeCodexTokenEnv`/`removeCodexTokenEnv`; lifecycle frozen in
  §6.5).
- The launch line passes the **path**, not the JSON: `claude ... --mcp-config <path> --strict-mcp-config
--allowedTools "mcp__jarvis__*" ...`. `claude --mcp-config` accepts a **file path** (it already accepts
  inline JSON; a path is the documented alternative). The token is then only in the `0600` file and in the
  Claude process's own memory — never in the tmux line, argv, or `capture-pane`.
- The persona file (`--append-system-prompt-file`) is also `0600` (it is persona text, not a secret, but keep
  the neutralDir uniformly `0700` and its files `0600`).

**FORBIDDEN: `tmux set-environment` for the MCP token.** Some earlier drafts (and ADR 0010) listed
`tmux set-environment` as an option for getting the bearer to the CLI. It is **rejected**: `tmux
show-environment` is a capture surface (any same-pane/same-server reader can dump the environment), so the
token would be exfiltratable. The token reaches the CLI **only via the per-session `0600` file** — never an
environment variable set on the tmux server/session. (ADR 0010 §5 is corrected to drop the
`tmux set-environment` option; see its consequences note.)

After this change, **all three providers** keep secrets off the launch line AND off the tmux environment:
Claude via `.jarvis-claude-mcp.json`, Codex via `.jarvis-mcp-token.env`, Gemini via `.gemini/settings.json`.

### 6.3 No secret in env crossing the boundary

The token does **not** travel as an env var from api to cli-runner. cli-runner receives it in the `launch`
RPC payload (in-process, in the socket frame, which is on the `0600` private volume) and writes it to the
provider's `0600` file. The cli-runner's own process env is sanitized (§7) and contains **no** app secret.

### 6.4 Redaction at the boundary

cli-runner runs `redactSecrets` (`packages/ai/src/adapters/redact.ts`: patterns `JARVIS_MCP_TOKEN=\S+`,
`Bearer\s+\S+`, `jst_[A-Za-z0-9_-]+`) on **every** error message and **drops stacks** before putting a
message into an `RpcErr.message` (reusing `redactCause`, `cli-chat-engine.ts:448-455`). The api therefore
receives only redacted text and may log it.

**FORBIDDEN: logging raw RPC frames on EITHER side.** The `launch` frame carries the MCP token **and** the
persona/`replayBatch` (private conversation data), and the `hello` frame carries the socket secret — so
dumping a raw frame leaks secrets _and_ private content. Neither the api client nor the cli-runner server may
log frame bodies. The **only loggable fields** for an RPC frame are: `method`, `id`, `sessionKey`, and the
frame **byte-length**. (`redactSecrets` still runs on any `RpcErr.message` that is logged; stacks are
dropped.) A debug log that wants to trace traffic logs `{ method, id, sessionKey, bytes }` — never the
`params`/`result`/`error.message`-with-body.

### 6.5 Per-session secret-file lifecycle (frozen — the simplest rule)

Each launched provider writes a per-session secret file under the session's neutral dir:

| Provider                    | Secret file (under `<neutralDir>`)                                              | Mode   |
| --------------------------- | ------------------------------------------------------------------------------- | ------ |
| Claude (`anthropic`)        | `.jarvis-claude-mcp.json` (NEW — the full `--mcp-config` JSON incl. the bearer) | `0600` |
| Codex (`openai-compatible`) | `.jarvis-mcp-token.env` (existing)                                              | `0600` |
| Gemini (`google`)           | `.gemini/settings.json` (existing — carries the Authorization header)           | `0600` |

**Both the MCP bearer token AND `mcpServerUrl` reach the CLI ONLY via these per-session config files** (Claude's
`.jarvis-claude-mcp.json` `url` + `headers`; Codex's `-c mcp_servers.jarvis.url=…` plus the `0600` token
env-file; Gemini's `settings.json`) — **never** as a CLI argv or process env var. Lane B MUST NOT pass
`mcpServerUrl` (or the token) as a flag/env to the child.

**Frozen cleanup rule — the simplest one: cli-runner removes the ENTIRE per-session neutral dir
(`<JARVIS_CLI_NEUTRAL_BASE>/<sessionKey>`) on `kill` AND on a failed launch.** This supersedes the
per-file `removeCodexTokenEnv` (which removed only Codex's file): instead of remembering to remove three
different per-provider files, the server removes the whole `<sessionKey>` dir, which contains all of them
plus the persona file. Consequences:

- On `kill(sessionKey)` (including kill-by-mux-name for an orphan with no Map entry, §4.5): after killing the
  mux session, `rm -rf` the per-session neutral dir.
- On a failed `launch`: remove the per-session neutral dir before returning the `RpcErr`. For a
  **PRE-mux-create** failure (multiplexer down, persona-write, §4.1) removing the dir suffices. For a
  **POST-mux-create** failure (the replay/submit/drain step fails after the `jarv1s-live-<sessionKey>` session
  already exists, §4.1.2) the server MUST FIRST **kill that mux session by canonical name** (kill-by-mux-name
  §4.5) and then remove the dir — otherwise the orphaned mux session stays in `listLiveSessions`-by-mux, enters
  the gate's `liveKeys`, and blocks the single-active-user gate for ALL users until api §5.3 reconciliation or
  a restart reaps it (symmetric to the kill-on-`kill(sessionKey)` rule above).
- **On cli-runner STARTUP (before accepting connections) — CLEAN-SLATE sweep:** kill every `jarv1s-live-*`
  mux session that exists (kill-by-mux-name §4.5) **and `rm -rf` every `<sessionKey>` dir directly under
  `<JARVIS_CLI_NEUTRAL_BASE>` (`/data/cli-auth/chat/*`) UNCONDITIONALLY.** A container restart kills the forked
  tmux server (§7.1), so there may be zero mux sessions to enumerate while the token dirs **persist on the
  named auth/home volume** (§8) — a mux-only sweep would miss them. Since the gate guarantees ≤1 live session,
  a fresh process legitimately has zero, so the base is cleared unconditionally. This is the on-disk
  precondition the §4.1.0a gate relies on; no foreign `0600` token dir survives a restart.
- The dir is recreated fresh on the next launch for that `sessionKey` (the manager rebuilds `personaText` and
  the server re-writes the secret files — §4.1.3), so no stale secret survives a relaunch.

This bounds secret-file lifetime to "while the session is live", for **all** providers, with one rule.
(Same-UID readability of these files while a session IS live is the open security item — §13.)

> **INVARIANT (same-UID trust domain):** Same-UID CLIs share a trust domain; per-session `0600` files are
> **NOT** a cross-user boundary — the single-active-user gate (`JARVIS_CLI_RUNNER_SINGLE_USER`, default ON,
> §4.1.0a) enforces isolation until UID-separation (issue **#347**) lands.

### 6.6 Socket access secret (`JARVIS_CLI_RUNNER_RPC_SECRET`)

The per-connection auth hello (§3.6) authenticates the api to cli-runner with a shared secret:

- `JARVIS_CLI_RUNNER_RPC_SECRET` is set in the **api** and **cli-runner-server** env only (a random value;
  lane C generates it in `install.sh` / `env.production.example` and injects it into both services).
- It is **excluded from the §7.2 CLI-subprocess env allowlist** — a launched CLI never inherits it.
- It is a secret for all logging/redaction purposes (§6.4): never logged, covered by `redactSecrets`.

### 6.7 Acceptance tests the lanes must add (frozen as acceptance, §12)

- The Claude launch line (the `tmux send-keys` argument / the mux `open` `launchLine`) contains only the
  mcp-config **path** — **no** `jst_`, `Bearer`, or token value.
- **The token is ABSENT from all of:** the tmux launch line, the spawned CLI's argv
  (`/proc/<pid>/cmdline`), `tmux capture-pane` output, `tmux show-environment` output, and the api/server
  logs. (Five assertions; the `show-environment` one enforces fix §6.2's no-`set-environment` rule.)
- Any error `RpcErr.message` contains no token shape (redacted, §6.4).
- `kill` and a failed `launch` both remove the per-session neutral dir (no secret file survives — §6.5).

---

## 7. ENV VARS (cli-runner) + SANITIZED-ENV ALLOWLIST

### 7.1 New / changed env vars

| Var                                   | Where                  | Default                       | Meaning                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JARVIS_CLI_RUNNER_SOCKET`            | api + cli-runner       | `/run/jarv1s/cli-runner.sock` | RPC Unix socket path (§3.1). **Its presence on the api selects the RPC client over in-process `CliChatEngineImpl`** (§3.5). Excluded from the CLI-subprocess env allowlist (§7.2).                                                                                                                                                                      |
| `JARVIS_CLI_RUNNER_RPC_SECRET`        | api + cli-runner       | _(random; required)_          | Shared secret for the socket auth hello (§3.6/§6.6). Known ONLY to api + cli-runner-server. **Excluded from the CLI-subprocess env allowlist** (§7.2).                                                                                                                                                                                                  |
| `JARVIS_CLI_RUNNER_SINGLE_USER`       | cli-runner (server)    | `1` (ON)                      | Single-active-user gate (§4.1.0a). ON ⇒ the cli-runner server holds at most one live engine; a `launch` for a different `sessionKey` returns `RpcErr code "unavailable"` until the live session is killed. Set `0` **only** when UID-separation (issue #347) lands. **cli-runner-server config only — NOT in the CLI-subprocess env allowlist** (§7.2). |
| `JARVIS_CLI_HOME`                     | cli-runner             | `/data/cli-auth`              | `HOME` for the CLIs (auth/home volume, §8). Replaces today's `JARVIS_CLI_HOME_BASE=/host-home` (which moves to cli-runner and points at the volume, not a host bind-mount).                                                                                                                                                                             |
| `JARVIS_CLI_HOME_BASE`                | cli-runner             | `${JARVIS_CLI_HOME}`          | Transcript base for `transcriptGlobDir` (`tmux-bridge.ts:96`). On cli-runner this equals `HOME` (the CLIs write `~/.claude`, `~/.codex`, `~/.gemini` under it). **Removed from api + worker** (they no longer read transcripts).                                                                                                                        |
| `JARVIS_CLI_NEUTRAL_BASE`             | cli-runner             | `/data/cli-auth/chat`         | Base under which `<sessionKey>` neutral dirs are derived (§4.1.1a). Replaces the api's `resolveChatHome()` / `JARVIS_CHAT_HOME` for the containerized path.                                                                                                                                                                                             |
| `JARVIS_CLI_TOOLS_PREFIX`             | cli-runner             | `/data/cli-tools`             | npm prefix for installed CLIs (Phase 2 installer).                                                                                                                                                                                                                                                                                                      |
| `NPM_CONFIG_PREFIX`                   | cli-runner             | `/data/cli-tools`             | npm installs CLIs here (tools volume).                                                                                                                                                                                                                                                                                                                  |
| `PATH`                                | cli-runner             | `…:/data/cli-tools/bin`       | so `claude`/`codex`/`agy` resolve from the tools volume.                                                                                                                                                                                                                                                                                                |
| `JARVIS_HOST_UID` / `JARVIS_HOST_GID` | root-init + cli-runner | `1000` / `1000`               | uid/gid the volumes are chowned to and the socket is owned by (§8).                                                                                                                                                                                                                                                                                     |
| `JARVIS_MULTIPLEXER`                  | cli-runner             | `tmux`                        | the bundled multiplexer (tmux). cli-runner forks its **own** tmux server (no host socket).                                                                                                                                                                                                                                                              |

**Removed from api + worker — COMPOSE-ONLY, NOT a code removal** (lane C deletes these mounts/vars from the
api+worker compose services): the host tmux socket mount (`docker-compose.prod.yml:162`),
`JARVIS_HOST_CLAUDE_DIR`/`JARVIS_HOST_CODEX_DIR`/`JARVIS_HOST_GEMINI_DIR` mounts (`:167-169`),
`JARVIS_CHAT_HOME` mount (`:172`), and the `JARVIS_CLI_HOME_BASE` env (`:137` api / `:185` worker). Per the
plan, `JARVIS_HOST_CLIS` is **deleted in in-container mode** (#341 superseded) — install.sh stops writing it
and cli-runner discovers CLIs via PATH probe inside the container (grounding area 4).

> **Critical scope clarification (the code still reads these vars on a host install).** The deletion above is
> **only the container/compose path**. The host-dev / native-install path is **unchanged**:
> `createRealEngineFactory` still reads `JARVIS_CLI_HOME_BASE` (`runtime.ts:58`) and `resolveChatHome` still
> reads `JARVIS_CHAT_HOME` (`chat-home.ts`). The in-process fallback engine (selected when
> `JARVIS_CLI_RUNNER_SOCKET` is unset, §3.5) depends on those vars. **Do NOT remove the env reads from the
> code** — only the compose `environment:`/`volumes:` entries go. The following host-mode suites therefore
> **stay green, unchanged** (they exercise the in-process path, §11):
> `tests/unit/cli-chat-engine.test.ts` (`homeBase '/host-home'`), `tests/unit/chat-live-chat-home.test.ts`
> (`JARVIS_CHAT_HOME`), `tests/unit/ai-cli-availability.test.ts` (`JARVIS_HOST_CLIS`).

### 7.2 cli-runner sanitized-env ALLOWLIST (excludes all app secrets)

cli-runner starts the CLIs with a **clean, allowlisted environment** — not the api's env. The CLI subprocess
env contains **only** the allowlist below. Everything else (and especially every secret) is **excluded**.

**ALLOWED into the CLI subprocess env:**

- `HOME` (= `JARVIS_CLI_HOME` = `/data/cli-auth`)
- `PATH` (incl. `/data/cli-tools/bin`)
- `NPM_CONFIG_PREFIX`, `JARVIS_CLI_TOOLS_PREFIX`
- `JARVIS_CLI_HOME`, `JARVIS_CLI_HOME_BASE`, `JARVIS_CLI_NEUTRAL_BASE`
- `JARVIS_HOST_UID`, `JARVIS_HOST_GID`
- `TERM`, `LANG`, `LC_*`, `TMPDIR` (terminal/locale basics for the TUI)

(`JARVIS_MULTIPLEXER` is **NOT** allowlisted into the CLI child — it is cli-runner-_server_ spawn config
(which mux to fork), not needed by `claude`/`codex`/`agy`; deny-by-default drops it.)

**EXCLUDED from the CLI subprocess env (never present in the launched CLI's env):**

- `JARVIS_CLI_RUNNER_SOCKET` — **removed from the allowlist.** A CLI subprocess has no business reaching the
  RPC socket; only the cli-runner _server_ process needs the path. Keeping it out of the CLI env denies a
  compromised CLI the socket path (defense alongside the §3.6 auth hello).
- `JARVIS_CLI_RUNNER_RPC_SECRET` — the socket auth secret (§6.6). **Excluded** — the CLI must never see it.
- `JARVIS_CLI_RUNNER_SINGLE_USER` — the single-active-user gate flag (§4.1.0a). **Excluded** — it is
  cli-runner-_server_ config; a launched CLI has no business reading it.
- `BETTER_AUTH_SECRET`
- `JARVIS_AI_SECRET_KEY`
- `JARVIS_CONNECTOR_SECRET_KEY`
- `POSTGRES_PASSWORD` and **every** DB URL / role password (`*_DATABASE_URL`, `JARVIS_*_DB_*`, the four
  runtime-role passwords)
- Any vault path / `JARVIS_VAULT_*`
- The MCP token does **not** appear here either — it arrives per-launch via the socket payload (§6.3), not
  the env.

> The cli-runner _server_ process env DOES carry `JARVIS_CLI_RUNNER_SOCKET` + `JARVIS_CLI_RUNNER_RPC_SECRET`
>
> - `JARVIS_CLI_RUNNER_SINGLE_USER` (it needs the first two to bind + authenticate, and the third to enforce
>   the single-active-user gate, §4.1.0a); the allowlist above governs the **CLI subprocess** env it builds
>   when spawning `claude`/`codex`/`agy`, which is a strict subset that drops all three.

**Implementation note (lane B/C):** the exclusion is enforced at **two** layers (defense in depth): (1) the
compose `cli-runner` service does **not** use the app `env_file` (it gets only the explicit `environment:`
block above) — so app secrets are never in the container env at all; and (2) when cli-runner spawns a CLI it
builds the child env from the allowlist explicitly rather than passing `process.env` through. Process
env-stripping alone is insufficient because **mounts** are container-level — hence the sidecar (plan §
"Key decisions").

---

## 8. VOLUME + MOUNT MATRIX

The api/worker/web containers mount **NONE** of the CLI-data volumes. The only api ⇄ cli-runner coupling is
the private `0600` socket.

| Volume                            | Mount path                  | cli-runner    | api    | worker | web | Mode / notes                                                                                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------- | ------------- | ------ | ------ | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tools** (`jarv1s-cli-tools`)    | `/data/cli-tools`           | **RW**        | —      | —      | —   | Installed CLIs (npm). `NPM_CONFIG_PREFIX=/data/cli-tools`; `PATH+=/data/cli-tools/bin`.                                                                                                                                                                                                                   |
| **auth/home** (`jarv1s-cli-auth`) | `/data/cli-auth` (= `HOME`) | **RW (ONLY)** | —      | —      | —   | Provider auth (`~/.claude`, `~/.codex`, `~/.agy`/`~/.gemini` creds) **and** CLI transcripts (`~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/tmp/.../chats`) **and** per-session neutral dirs (`/data/cli-auth/chat/<sessionKey>`). cli-runner reads transcripts and returns records via `readNew`. |
| **socket** (`jarv1s-cli-socket`)  | `/run/jarv1s`               | **RW**        | **RW** | —      | —   | Holds the `0600` RPC socket. Dir `0700`, socket file `0600`, owned `JARVIS_HOST_UID`. **cli-runner + api ONLY.**                                                                                                                                                                                          |
| postgres-data                     | `/var/lib/postgresql/data`  | —             | —      | —      | —   | (unchanged; postgres only)                                                                                                                                                                                                                                                                                |
| vault-data                        | `/data/vaults`              | —             | **RW** | **RW** | —   | (unchanged; api/worker only — cli-runner NEVER mounts the vault)                                                                                                                                                                                                                                          |
| model-cache                       | `/app/.cache/huggingface`   | —             | **RW** | **RW** | —   | (unchanged; embeddings stay in the api/worker process)                                                                                                                                                                                                                                                    |

**Root-init service** (one-shot, root, runs before api/worker/cli-runner; plan §4): chowns
`jarv1s-cli-tools`, `jarv1s-cli-auth`, and `/run/jarv1s` to `JARVIS_HOST_UID:JARVIS_HOST_GID`, and creates
`/run/jarv1s` as `0700`. All non-root services `depends_on` it `service_completed_successfully`.

**Key isolation invariants (frozen):**

- cli-runner mounts **only** tools + auth/home + socket. It does **NOT** mount vault, model-cache, or
  postgres-data, and does **NOT** receive the app `env_file`.
- api mounts **only** vault + model-cache + socket. It does **NOT** mount tools or auth/home — it cannot read
  any transcript or any provider auth.
- worker mounts vault + model-cache (no socket — the socket is cli-runner + api only, per plan R4).
- web mounts nothing CLI-related.

---

## 9. PROVIDER STATE MACHINE (Phase 2)

### 9.1 States

```
not_installed ─▶ installing ─▶ installed ─▶ needs_login ─▶ ready
      ▲              │             │             │            │
      └──────────────┴─────────────┴─────────────┴────────────┴─▶ error
```

| State           | Meaning                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `not_installed` | CLI binary absent from the tools volume (no PATH hit in cli-runner).                           |
| `installing`    | install service (Phase 2) is fetching/installing the pinned recipe.                            |
| `installed`     | binary present + version-verified, but not yet authenticated.                                  |
| `needs_login`   | installed, but no valid provider auth (login presentation layer, Phase 3, not yet run).        |
| `ready`         | installed AND authenticated AND smoke-passed → live chat can launch this provider.             |
| `error`         | install or login failed; carries a redacted message. Recoverable (retry → re-enters the flow). |

This is a **superset** of today's transient probe enum
`OnboardingProviderCheckStatus = ready | needs_login | not_installed | multiplexer_unavailable | error`
(`packages/shared/src/onboarding-api.ts:37-42`). The split adds the lifecycle states `installing` +
`installed` that today's presence-only probe cannot express. `multiplexer_unavailable` remains a
**transient probe** result (the multiplexer is a cli-runner-wide condition, not a per-provider lifecycle
state) — it stays in the probe response enum, not the persisted lifecycle.

**The transient probe now runs over the socket via `probeProvider` (§4.8).** Because the CLIs and their auth
moved into cli-runner, the api can no longer compute these statuses in-process; the api's
`makeProviderConnectionCheckProbe` + `makeCliPresentProbe` call `probeProvider({ provider })` and surface its
`OnboardingProviderCheckResponse` unchanged.

### 9.2 Persistence location

The persisted provider state extends the onboarding contract, not the live-chat contract:

- **New type** in `packages/shared/src/onboarding-api.ts`:
  ```typescript
  export type ProviderInstallState =
    | "not_installed"
    | "installing"
    | "installed"
    | "needs_login"
    | "ready"
    | "error";
  ```
  This is **additive** — it does not modify the existing `OnboardingProviderCheckStatus` union (which stays
  the transient probe shape so existing routes + schemas are untouched). The onboarding founder status DTO
  (`OnboardingCliProviderDto`, lines 27-31) gains an **optional** `installState?: ProviderInstallState` field
  (optional ⇒ no schema break; the JSON-schema `cliAuth.providers.items` adds it as a non-required enum
  property).
- **Storage:** one row per provider in a Phase-2 table owned by the settings/onboarding module
  (e.g. `app.provider_state { provider, state, version, message, updated_at }`), written by the install +
  login services (running in cli-runner, reported to the api over a Phase-2 control path — NOT this socket;
  this socket is the live-chat engine boundary only). The exact migration is a Phase-2 build task; **frozen
  here:** the enum values, the additive `installState?` field, and the rule that state lives in the
  onboarding/settings module (module isolation), never in `@jarv1s/chat` or the token registry.

---

## 10. WIRE-TYPE HOME (frozen — authored FIRST by Lane A)

**All RPC wire types live in ONE new file — `packages/chat/src/live/rpc-contract.ts`.** Lane A authors it
**first**; Lanes B and D import it **read-only**. No other file re-declares any of these shapes. This is the
single seam that lets four lanes compile against one contract without colliding.

The file exports, at minimum:

- **Envelopes + framing:** `RpcRequest`, `RpcOk`, `RpcErr`, `RpcError`, `RpcErrorCode`, `RpcMethod`,
  `RpcFrame`, the auth-handshake frames `RpcHello` / `RpcHelloChallenge` / `RpcHelloResponse`, and the
  `bootId` field convention (§3.4, §3.6, §5.6). `MAX_FRAME_BYTES` constant.
- **Per-method params/results:** `RpcLaunchParams`, `RpcLaunchResult`, `RpcSubmitParams`,
  `RpcReadNewParams`, `RpcReadNewResult`, `RpcListLiveSessionsParams`, `RpcListLiveSessionsResult`,
  `RpcProbeProviderParams`, `RpcProbeProviderResult` (and the trivial `RpcIsAliveParams`/`RpcIsAliveResult`,
  `RpcKillParams`/`RpcKillResult`).

`TranscriptRecord` / `ChatRecordKind` continue to live in `types.ts` (reused verbatim, §4.0) and are
imported by `rpc-contract.ts`, not re-declared. `OnboardingProviderCheckStatus` continues to live in
`onboarding-api.ts`; `RpcProbeProviderResult` reuses its value set.

**The one cross-lane compile seam:** Lane A's `runtime.ts` imports the engine class from Lane B's
`cli-chat-engine.ts` (compile-time only, to construct the in-process engine on the host path). Lanes B and D
import `rpc-contract.ts`. There are no other cross-lane imports.

## 11. Testing

- **Interface return-type change ripples to the fakes/suites.** Because `launch` now returns
  `Promise<{ offset: number }>` (§4.0), update: `FakeLiveEngine` (`tests/integration/chat-live-api.test.ts`)
  and the `cli-chat-engine` / `chat-session-manager` / `chat-live-api` suites, all of which currently assume
  `launch(): Promise<void>`. The fakes return `{ offset: 0 }` (they don't own a drain) and the manager seeds
  `transcriptOffset` from it (§4.1.2).
- **Host-mode suites stay GREEN, unchanged** (they exercise the in-process fallback path; the env-var removal
  is compose-only, not code — §7.1): `tests/unit/cli-chat-engine.test.ts` (homeBase `'/host-home'`),
  `tests/unit/chat-live-chat-home.test.ts` (`JARVIS_CHAT_HOME`), `tests/unit/ai-cli-availability.test.ts`
  (`JARVIS_HOST_CLIS`).
- **New RPC round-trip tests:** each verb (`launch / submit / readNew / isAlive / kill / listLiveSessions /
probeProvider`) across an in-process socket pair; the `hello` auth handshake (good secret connects, bad/
  absent secret is closed); `bootId` change triggers reconciliation; malformed-frame closes vs `bad_request`
  stays open (§3.7); offset preserved across the round-trip (UTF-16 code units, §3.3).
- **Secrets acceptance tests:** the five token-absence assertions of §6.7 (launch line, argv via
  `/proc/<pid>/cmdline`, `capture-pane`, `show-environment`, logs) + the per-session-dir cleanup on
  kill/failed-launch.
- **Reconciliation tests:** `tokens.reconcile(liveSet)` revokes only non-members; a `cli-runner` reconnect
  with an empty `sessions` Map still revokes orphaned tokens (via `listSessionIds`) and kills orphaned mux
  sessions by name (§5.3); reconciliation and `reapIdle` are mutually exclusive under the §5.4 mutex.
- **Single-active-user gate tests (Lane B, §4.1.0a):**
  (a) **integration:** with one live session, a 2nd `launch` for a **different** `sessionKey` is rejected with
  `RpcErr code "unavailable"` while the first is live, and **succeeds after the first session is killed**
  (assert with `JARVIS_CLI_RUNNER_SINGLE_USER` ON / default).
  (b) **documenting test:** assert that `0600` mode + `redactSecrets` do **NOT** protect a per-session token
  file from a **same-UID read** — i.e. a same-UID reader can open and read the `0600` token file while the
  session is live — so nobody mistakes `0600` for the cross-user boundary (the gate, not the file mode, is
  what enforces isolation until #347 — §13).

## 12. Acceptance criteria

1. The api-side `ChatEngineRpcClient` implements `CliChatEngine` (`types.ts:31-41`) verbatim **including the
   new `launch(): Promise<{ offset }>` return type**; existing `ChatSessionManager`, `cli-chat-engine.test.ts`
   (server-side, in-process), `chat-session-manager.test.ts`, and `chat-live-api.test.ts` (`FakeLiveEngine`)
   stay green after the return-type update (§11).
2. Length-prefixed framing (§3.2) round-trips multi-line `TranscriptRecord.text` and `readNew` responses
   across fragmented socket reads; a malformed frame > `MAX_FRAME_BYTES` closes the connection; a
   semantically-invalid `afterOffset` returns `bad_request` without closing (§3.7).
3. The `hello` auth handshake (§3.6) authenticates the api; an unauthenticated connection (bad/absent
   `JARVIS_CLI_RUNNER_RPC_SECRET`) is closed; the CLI subprocess env contains neither the socket path nor the
   RPC secret (§7.2).
4. `launch` carries `personaText` + `replayBatch` + `mcpToken` (§4.1.1a), returns the post-drain `offset`
   (§4.1.2); cli-runner derives `neutralDir` from `sessionKey`, writes the persona file, injects the token,
   and (when `replayBatch` present) replays + drains server-side. The api passes **no** filesystem paths and
   seeds `transcriptOffset` from the returned offset.
   4a. **Single-active-user gate (§4.1.0a, Lane B):** with `JARVIS_CLI_RUNNER_SINGLE_USER` ON (default) and one
   live session, a 2nd `launch` for a **different** `sessionKey` is rejected with `RpcErr code "unavailable"`
   while the first is live and **succeeds after the first is killed** (test (a), §11) — and a documenting test
   (test (b), §11) shows `0600` + `redactSecrets` do not protect a per-session token file from a same-UID
   read. The gate reuses the existing `unavailable` code — **NO wire-contract change**.
5. The Claude launch line contains the mcp-config **path**, not the token (§6.2); the five token-absence
   assertions (§6.7) hold — incl. `tmux show-environment` (no `set-environment` of the token) and logs;
   per-session neutral dir is removed on kill AND failed launch (§6.5).
6. On socket (re)connect AND on a `bootId` change (§5.6) the ONE reconciliation (§5.3) runs:
   orphan-token revoke (sourced from `tokens.listSessionIds`, works with an empty `sessions` Map) → drop
   stale api sessions → `kill` orphaned mux sessions **by mux name**; idempotent; mutually exclusive with
   `reapIdle` under the §5.4 mutex; launching keys treated live for the whole launch window.
7. cli-runner mounts only tools + auth/home + socket and gets no app `env_file`; api/worker/web mount no
   CLI-data volume; the cli-runner CLI subprocess env matches the §7.2 allowlist and contains none of the
   excluded secrets.
8. `probeProvider` (§4.8) runs inside cli-runner with no token/replay and returns the existing
   `OnboardingProviderCheckStatus` values incl. `multiplexer_unavailable`; the api's onboarding probes call
   it over the socket.
9. `ProviderInstallState` + the optional `installState?` DTO field are additive in `onboarding-api.ts`;
   existing onboarding routes/schemas unchanged.

## 13. Open security decision (escalated — do NOT silently resolve)

**Cross-session MCP-token-file isolation:** the per-session `0600` files under `/data/cli-auth`
(`.jarvis-claude-mcp.json`, `.jarvis-mcp-token.env`, `.gemini/settings.json`) remain **readable by any
SAME-UID provider CLI subprocess** while a session is live (Codex finding #2). All provider CLIs run as the
single `JARVIS_HOST_UID`, so one user's launched CLI could read another live session's token file. The
socket auth secret (fix §6.6) closes **RPC** access; it does **not** close same-UID file access. **Full
per-user token isolation requires running the CLI subprocesses under separate UIDs/identities (or per-user
sidecars)** — an infra + spawn change owned by Lane C/Lane B that does **NOT** change this RPC contract.

**Phase 1 ships, as a DOCUMENTED limitation:** same-UID execution + the socket secret + per-session-dir
cleanup (§6.5) — **behind the HARD RUNTIME GATE `JARVIS_CLI_RUNNER_SINGLE_USER` (default ON, §4.1.0a) that
MUST land in Phase 1.** While the gate is ON the cli-runner holds at most one live engine, so no two sessions'
`0600` token files are readable concurrently. **UID/identity separation is deferred to fast-follow issue
#347** (the verdict on this escalation is DEFER-OK-WITH-GATE). Lanes proceed on the documented Phase-1
posture; the gate carries the isolation until #347 closes.

**INVARIANT:** Same-UID CLIs share a trust domain; per-session `0600` files are **NOT** a cross-user boundary
— the single-active-user gate (`JARVIS_CLI_RUNNER_SINGLE_USER`, default ON) enforces isolation until
UID-separation (issue **#347**) lands.

**Tracking — issue #347** (security · milestone "Phase 2 · Multi-user" · Part of #47 · **BLOCKING** for
concurrent multi-user CLI chat): defer UID-separation (per-user UIDs/identities or per-user sidecars) for the
CLI subprocesses. **Lifting `JARVIS_CLI_RUNNER_SINGLE_USER` (setting it `0` to enable concurrent multi-user
CLI chat) is gated on #347 closing** — until then the flag stays ON and the cli-runner is single-active-user.

## 14. Open issues (do not block the freeze; flagged for the build)

- **Idle-reaper scheduler:** `reapIdle` has no production caller today (§5.5). Lane D either wires it (an api
  `setInterval` sharing the §5.4 mutex) or explicitly defers it, stating that reconciliation works without it.
- **Multi-instance api:** `SessionTokenRegistry` is per-instance in-memory; horizontal api scaling is out of
  scope (single-instance house model, ADR 0007). If it ever scales, the registry needs DB backing and the
  reconciliation needs a shared store — explicitly deferred.
- **`replayBatch` size:** a very long replay could approach `MAX_FRAME_BYTES`; in practice the api already
  bounds replay to a recent window + rolling summary (`listPriorTurns`), so it stays well under 16 MiB. If a
  future change unbounds it, `readNew`/`launch` would need chunking — flagged, not built (chunking deferred,
  §3.2).
- **agy/Antigravity** transcript + auth format is a Phase-2/3 spike (plan risks); the contract treats
  `google` exactly as the existing Gemini-shaped parser until that spike resolves.

## 15. Out of scope

On-demand installer recipes + pinning (Phase 2 build), login presentation layer (Phase 3), API-key chat
engine (rejected), GLM/opencode provider, Apple `container` runtime, the provider-state DB migration (only
its enum + location are frozen here).
