# API-key Providers Drive Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick an Anthropic or OpenAI-compatible API-key provider (including one at a custom address, such as a local proxy) as the chat provider, and have the chat drawer work through the existing agent programs with tools and confirmation cards.

**Architecture:** Chat keeps its one engine (ACP over the cli-runner sidecar). The app decrypts the API key at chat launch and sends it, with the row's address and model, on the `acpSpawn` RPC. The sidecar puts it in the agent's process env only: `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` for the claude agent, or a Moss-named variable referenced from a provider entry in `opencode.json` for OpenCode. Readiness for API-key rows is the app's own `/v1/models` call plus the sidecar's installed-tools report.

**Tech Stack:** TypeScript (strict), Node 24, Fastify, React with TanStack Query, Vitest, pnpm workspaces (`@moss/*` packages), ACP adapters pinned in `packages/cli-runner/package.json` (`@agentclientprotocol/claude-agent-acp` 0.75.1, `opencode-ai` 1.18.29).

**Spec:** `docs/superpowers/specs/2026-10-10-api-key-chat-design.md` (approved 2026-10-10). Task issue: #3410. Phases 4 and 5 (dev-instance seeding, UAT) are in `docs/superpowers/plans/2026-10-10-api-key-chat-seeding.md`.

**Revised 2026-10-11** after an independent review of the plans at `f846d7446`. The revision adds a provider launch revision and targeted session invalidation (Tasks 11 and 12), cross-chunk stderr redaction (Task 9) and redacted launch errors (Task 10), one address and model id policy for discovery and the key test (Tasks 4 and 5), a chat-model contract (Task 5), fixed removal controls (Task 7), and stronger phase 0 and UI proofs (Tasks 1, 2, 16).

## Global Constraints

- Never hardcode a model or provider in product code. Test fixtures may use literal ids.
- Public repo. No credentials, private hostnames, LAN addresses, ports of private services or personal data in code, tests, docs, commits or PR text. Use `$PROXY_URL`, `$PROXY_KEY_FILE`, `$PROXY_ANTHROPIC_MODEL`, `$PROXY_OPENAI_MODEL` in instructions and `http://proxy.test` (no port) in test fixtures.
- Paths in docs are repo-relative or `~/Jarv1s`, never absolute home paths.
- No PR may push a file from under 1000 lines to over 1000 lines. Near the limit today: `packages/cli-runner/src/acp-host.ts` 997, `packages/shared/src/ai-api.ts` 984, `packages/cli-runner/src/engine-host.ts` 983, `packages/chat/src/live/chat-session-manager.ts` 978, `packages/chat/src/live/runtime.ts` 946. Run `wc -l` on these after each task that touches them.
- Prettier `printWidth` 100.
- Unit tests run one file at a time: `pnpm test:unit <file>`. The full gate and database tests run only through the verify-gate skill, at the points marked **verify-gate**.
- Unsupported-kind message, verbatim: "Chat supports API-key providers of type Anthropic or OpenAI-compatible. Choose one of those, or a CLI provider, in Admin > AI providers."
- ADR 0003 status line, verbatim: "Superseded in part (interactive transport) by `docs/superpowers/specs/2026-10-10-api-key-chat-design.md`".
- Release note: Category Added, "Chat can now use an API-key provider".
- Never add `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL` to any env allowlist (`packages/ai/src/adapters/sanitized-env.ts`, `scripts/start-jarv1s.ts`).
- The key must never appear in any process argv, in api or cli-runner logs, in RPC error messages, in pg-boss payloads, in anything sent to the browser, or in `opencode.json`. This holds for a key split across stderr chunks too; there is no disclosure waiver. CLI-row spawns carry no API-key variables. Each of these has a test that is observed failing with its protection removed ("removal step"), and the removal step records the observed failure.
- Leak searches use `/tmp/acp-proof/key-scan.mjs`, which reads the key file itself and prints only counts, pids and file names. Never put key text, or any slice of it, in a command line (no `grep -F "$KEY_TAIL"`).
- One address normalizer, `providerBaseUrl`, serves launch, model discovery, the key test and the HTTP adapters. One model id policy, `PROVIDER_MODEL_ID_PATTERN`, serves the RPC check and Anthropic discovery at a custom address.
- Supported models are chat models. Discovery drops embedding, moderation, rerank, speech and image-generation ids, so they never get the chat capability.
- OpenAI-compatible means the Chat Completions API (`POST <address>/v1/chat/completions`). Docs, the release note and PR text say "OpenAI-compatible (Chat Completions)". One proxy passing does not prove other services.
- A live chat session follows its provider row. The active-provider identity carries a non-secret launch revision (a hash of kind, address and sealed credential, never the key), and a provider save or revoke drops that row's live sessions.
- Vendor behaviour (what the claude agent and OpenCode do with the env and settings) is assumed only where phase 0 proved it. If phase 0 fails a check, stop and report to Ben; do not build on the assumption.
- Chat, status updates, PR text and handoff docs are plain English for a non-engineer reader: name things by what they do, at most one code-formatted name per sentence, plain ASCII punctuation, no invented shorthand. Pass this instruction on to every agent you spawn. Commit messages and code comments stay precise and technical.

## Review Focus

1. An address saved with a trailing slash or a trailing `/v1` (people paste either). Expect the same requests as the bare address, never `/v1/v1/...`, at launch, in model discovery and in the key test. Pinned in Task 4 (`providerBaseUrl` cases), Task 5 (discovery to persistence with `/v1` and `/v1/`) and Task 9 (OpenCode entry gets exactly one `/v1`).
2. An API-key row whose key is missing, revoked or cannot be decrypted (secret key rotated). Expect chat to refuse with one fixed message before any thread or engine work, and no error text containing key material. Pinned in Task 11 (`openChatCredential` returns null on every failure) and Task 12 (launch refuses before `openNewConversation`).
3. Switching from an API-key OpenAI-compatible row to an OpenCode CLI row. Expect the old provider entry gone from `opencode.json` before the CLI agent starts. Pinned in Task 8 (script removes the entry) and Task 9 (every OpenCode spawn sends a removal).
4. A key the provider rejects mid-chat. Expect the fixed "provider rejected the API key" message, and no CLI login rejection recorded (which would mark an unrelated CLI login bad). Pinned in Task 10.
5. Model ids containing `/`, `:` or `@` (common on proxies and routers). Expect them kept by discovery, accepted on the RPC and written into the entry unchanged, and the agent to use exactly that model. Pinned in Task 1 (effective model through Moss's own client), Task 5, Task 7 and Task 8.
6. An admin saves a new key or address on the same provider row while a chat is open, or during launch. Expect the next turn to run in a fresh engine with the new key and the history replayed, never the old engine. Pinned in Task 11 (revision in the identity) and Task 12 (launch race, targeted drop on save and revoke).
7. A key split across two adapter stderr chunks, or echoed in a launch error. Expect "[redacted]" in every split position, and nothing after the final flush. Pinned in Task 9 (stream redactor) and Task 10 (launch errors).
8. A provider that lists only embedding models, or nothing. Expect no chat-capable model and a clear refusal, never an embedding model tagged for chat. Pinned in Task 5 and seeding Task 18.

---

## Before you start

- [ ] **Rebase onto current main.** The planning branch was 6 commits behind `origin/main` when this plan was written. None of those commits touch the files edited here except `packages/ai/src/routes.ts` and `packages/shared/src/app-map-core.ts`, and neither change moves an anchor this plan uses.

```bash
git fetch origin
git rebase origin/main
git rev-list --count HEAD..origin/main   # expect 0
```

- [ ] **Record line counts** for the files near the limit.

```bash
wc -l packages/cli-runner/src/acp-host.ts packages/shared/src/ai-api.ts \
  packages/cli-runner/src/engine-host.ts packages/chat/src/live/chat-session-manager.ts \
  packages/chat/src/live/runtime.ts
```

Expected: 997, 984, 983, 978, 946 (or close, if main moved). If any is already above 1000, stop and ask.

## Verified Branch State

Checked against the code on 2026-10-10. Line numbers are on the planning branch.

| Fact | Where |
| --- | --- |
| Chat refuses API-key rows | `assertLiveCliProvider`, `packages/chat/src/live/chat-session-provider-identity.ts:55-60` |
| Routing never sees the auth method | `toAcpProviderKind`, `packages/chat/src/live/acp-chat-engine.ts:47-59` |
| Anthropic address hardcoded in three places | `packages/ai/src/adapters/http-api.ts` (anthropic `buildRequest`), `packages/ai/src/model-discovery.ts:194` `doFetch`, `packages/ai/src/provider-validation.ts:146` `fetchModels` |
| Structured adapter already honours a base URL, without stripping `/v1` | `packages/ai/src/adapters/http-api-structured.ts:127` |
| Spawn env built after the sanitizer; login token added for anthropic | `packages/cli-runner/src/acp-host.ts:370-379`, token read at `:988-996` |
| OpenCode deny settings written per chat spawn | `acp-host.ts:387-395`, `packages/cli-runner/src/agent-home-prepare.mjs` |
| `acpSpawn` RPC params | `packages/chat/src/live/rpc-contract.ts:633-652`, validated in `packages/cli-runner/src/connection.ts:630-657` |
| Chat persistence has no secret cipher | `packages/chat/src/live/persistence.ts:71-86` |
| Meeting chat already decrypts API keys under the user's data context | `packages/chat/src/live/meeting-chat-runtime.ts:73` |
| Discovery helper not exported from `@moss/ai` | `packages/ai/src/index.ts` |
| A second auth-failure mapping at prompt time | `acp-chat-engine.ts:658-664` |
| Add form labels the address field "Base URL" | `apps/web/src/settings/settings-ai-provider-picker.tsx` |
| OpenAI-compatible discovery and key test append `/v1/models` without stripping a saved `/v1` | `model-discovery.ts:217-218`, `provider-validation.ts:146-170` |
| Anthropic discovery keeps only ids with `claude-` and without `:` | `model-discovery.ts:258-261` `extractModelEntries` |
| Capability inference tags every non-transcription id as chat and tool-use | `model-discovery.ts:373-414` `inferModel` |
| OpenAI HTTP adapters use the row address without stripping `/v1` | `http-api.ts:241`, `http-api-structured.ts:159` |
| Moss's client substitutes an advertised model when the requested id is not advertised | `packages/acp/src/client.ts:472-489` `setModelForChat` |
| Adapter stderr is redacted per chunk only | `acp-host.ts:582-587` |
| Non-auth launch errors are rethrown raw | `acp-chat-engine.ts:607-619` |
| Active-provider identity has no config revision | `sameActiveChatProvider`, `chat-session-provider-identity.ts:33-44` |
| Provider save and revoke invalidate discovery but no live chat | `packages/ai/src/routes.ts:422-424`, `:451` |
| Drop-by-kind seam already published from chat to the onboarding route | `packages/chat/src/routes.ts:205-207`, `:573-575`; `packages/module-registry/src/index.ts:3604-3607`, `:3852` |

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `packages/ai/src/provider-base-url.ts` | Create | Normalize a stored address; the one place holding the default Anthropic and OpenAI addresses |
| `packages/ai/src/adapters/http-api.ts`, `http-api-structured.ts` | Modify | Use the row's Anthropic address |
| `packages/ai/src/model-discovery.ts`, `provider-validation.ts` | Modify | Same, for `/v1/models`; export the fixed result messages |
| `packages/ai/src/api-key-chat-readiness.ts` | Create | Readiness check for API-key chat rows, cached by row id plus update time |
| `packages/ai/src/provider-validation-routes.ts` | Modify | `GET /api/ai/providers/:id/chat-readiness` |
| `packages/shared/src/ai-chat-readiness-api.ts` | Create | Readiness statuses, response type and route schema (kept out of `ai-api.ts`, which is at 984 lines) |
| `packages/acp/src/opencode-provider.ts` | Create | The OpenCode provider id and key variable name shared by sidecar and app |
| `packages/chat/src/live/rpc-contract.ts` | Modify | Optional `credential` on `acpSpawn` |
| `packages/cli-runner/src/acp-spawn-credential.ts` | Create | Validate the RPC credential; value-free errors |
| `packages/cli-runner/src/acp-launch-credential.ts` | Create | Put credential or CLI login token into the agent env; build the OpenCode entry request |
| `packages/cli-runner/src/acp-host.ts` | Modify | Call the helper; net line count goes down |
| `packages/cli-runner/src/stderr-redactor.ts` | Create | Mask a key across stderr chunk boundaries with a bounded holdback |
| `packages/ai/src/routes.ts`, `packages/chat/src/routes.ts`, `packages/module-registry/src/index.ts` | Modify | Drop live chat sessions for one provider row on save or revoke |
| `packages/cli-runner/src/agent-home-prepare.mjs`, `agent-home-prepare-run.ts` | Modify | Write or remove the OpenCode provider entry |
| `packages/chat/src/live/api-key-launch.ts` | Create | Decrypt the chat credential; pick the OpenCode model value |
| `packages/chat/src/live/acp-chat-engine.ts` | Modify | Route by auth method; API-key auth failures; tunnel carries the credential |
| `packages/chat/src/live/chat-session-provider-identity.ts`, `chat-session-launch.ts`, `errors.ts`, `auth-errors.ts`, `persistence.ts`, `runtime.ts`, `chat-session-ports.ts`, `chat-session-manager.ts`, `../live-routes.ts` | Modify | Open the gate, pass the credential, new errors |
| `apps/web/src/settings/settings-ai-provider-catalog.ts` | Modify | "Anthropic (API key)" add entry |
| `apps/web/src/settings/settings-ai-chat-readiness.ts` | Create | Readiness status to display text |
| `apps/web/src/settings/settings-ai-provider-models.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/api/query-keys.ts` | Modify | Show readiness on API-key cards |
| `packages/shared/src/app-map-core.ts` | Modify | Describe the new behaviour |
| `docs/architecture/decisions/0003-interactive-chat-is-cli-transport.md` | Modify | Status line |

---

## Phase 0: Proofs (no product code)

A failed proof stops the plan. Post what failed on issue #3410 and wait for Ben. Do not work around a failed proof in code.

Run these on the host, from the implementation worktree after `pnpm install`. The harness lives in `/tmp/acp-proof/` and is never committed. The proxy is the stand-in for any Anthropic- or OpenAI-compatible service.

Shared setup (every Phase 0 task):

```bash
export PROXY_URL='<proxy address, no trailing /v1>'
export PROOF_KEY_FILE='<path to a 0600 file holding the proxy key>'
export PROOF_HOME="$(mktemp -d /tmp/acp-proof-home.XXXXXX)"
mkdir -p /tmp/acp-proof
```

Never `cat` the key file, and never pass the key, or any slice of it, on a command line. The harness, the recorder and the scanner below read it from the file.

Shared tools (write once, before Task 1):

```js
// /tmp/acp-proof/key-scan.mjs - leak scan. Never commit. Never prints key text.
// usage: node key-scan.mjs <key-file> [--argv] [path ...]
// Counts the whole key and every 12-character window of it, so a cut copy still counts.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [keyFile, ...rest] = process.argv.slice(2);
if (!keyFile) {
  console.error("usage: node key-scan.mjs <key-file> [--argv] [path ...]");
  process.exit(2);
}
const key = readFileSync(keyFile, "utf8").trim();
if (key.length < 12) {
  console.error("key shorter than 12 characters; scan would over-match");
  process.exit(2);
}
const needles = new Set([key]);
for (let i = 0; i + 12 <= key.length; i += 1) needles.add(key.slice(i, i + 12));
const hit = (buffer) => {
  const text = buffer.toString("latin1");
  for (const needle of needles) if (text.includes(needle)) return true;
  return false;
};

let total = 0;
if (rest[0] === "--argv") {
  rest.shift();
  const pids = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      if (hit(readFileSync(`/proc/${pid}/cmdline`))) pids.push(pid);
    } catch {}
  }
  console.log(`ARGV_HITS ${pids.length}${pids.length ? ` pids=${pids.join(",")}` : ""}`);
  total += pids.length;
}
const files = [];
const walk = (path) => {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    let names = [];
    try {
      names = readdirSync(path);
    } catch {}
    for (const name of names) walk(join(path, name));
    return;
  }
  if (info.isFile() && info.size <= 64 * 1024 * 1024) {
    try {
      if (hit(readFileSync(path))) files.push(path);
    } catch {}
  }
};
for (const path of rest) walk(path);
console.log(`FILE_HITS ${files.length}`);
for (const file of files) console.log(`  ${file}`);
total += files.length;
process.exitCode = total > 0 ? 1 : 0;
```

```js
// /tmp/acp-proof/model-recorder.mjs - forwards to $PROXY_URL and records which model each
// request asks for. Logs method, path and body.model only, never headers. Never commit.
// usage: node model-recorder.mjs <port> <log-file>
import { appendFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const [port, logFile] = process.argv.slice(2);
const upstream = new URL(process.env.PROXY_URL);
const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    let model = "-";
    try {
      model = JSON.parse(body.toString("utf8")).model ?? "-";
    } catch {}
    appendFileSync(logFile, `${req.method} ${req.url.split("?")[0]} model=${model}\n`);
    const out = send(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: upstream.pathname.replace(/\/+$/, "") + req.url,
        headers: { ...req.headers, host: upstream.host }
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      }
    );
    out.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    out.end(body);
  });
}).listen(Number(port), "127.0.0.1");
```

```ts
// /tmp/acp-proof/moss-client-proof.ts - drives an adapter through Moss's own ACP client
// (MossAcpClient, including setModelForChat) over a local tunnel. Never commit.
// usage: pnpm exec tsx /tmp/acp-proof/moss-client-proof.ts <anthropic|opencode> <model> [prompt]
// env: MOSS_REPO, PROOF_HOME, PROOF_KEY_FILE, PROOF_BASE_URL, ADAPTER_ENTRY or OPENCODE_BIN,
//      PROOF_MODE=set|env|both (anthropic only, default both),
//      PROOF_REPLAY_FILE (optional "User: ..." / "Assistant: ..." lines),
//      PROOF_PROMPTS_FILE (optional JSON array of prompts, run in one session)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const [kind, model, prompt = "Reply with the single word: ready"] = process.argv.slice(2);
if ((kind !== "anthropic" && kind !== "opencode") || !model) {
  console.error("usage: moss-client-proof.ts <anthropic|opencode> <model> [prompt]");
  process.exit(2);
}
const { MossAcpClient } = await import(join(need("MOSS_REPO"), "packages/acp/src/index.ts"));
const home = need("PROOF_HOME");
const key = readFileSync(need("PROOF_KEY_FILE"), "utf8").trim();
const base = need("PROOF_BASE_URL").replace(/\/+$/, "");
const mode = process.env.PROOF_MODE ?? "both";
const mask = (text: unknown) => String(text).split(key).join("[KEY]");
const cwd = join(home, "work");
mkdirSync(cwd, { recursive: true });

function agentProcess(): ChildProcess {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    LANG: "C.UTF-8"
  };
  if (kind === "anthropic") {
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_API_KEY = key;
    if (process.env.CLAUDE_CODE_EXECUTABLE) {
      env.CLAUDE_CODE_EXECUTABLE = process.env.CLAUDE_CODE_EXECUTABLE;
    }
    if (mode !== "set") env.ANTHROPIC_MODEL = model;
    return spawn(process.execPath, [need("ADAPTER_ENTRY")], { cwd, env });
  }
  env.MOSS_OPENCODE_API_KEY = key;
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const entry = {
    npm: "@ai-sdk/openai-compatible",
    name: "Moss",
    options: { baseURL: `${base}/v1`, apiKey: "{env:MOSS_OPENCODE_API_KEY}" },
    models: { [model]: {} }
  };
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { moss: entry } }), {
    mode: 0o600
  });
  return spawn(need("OPENCODE_BIN"), ["acp"], { cwd, env });
}

// Stdout lines are numbered from 1; read(afterSeq) returns every line after afterSeq.
let child: ChildProcess | null = null;
const lines: string[] = [];
const stderr: Buffer[] = [];
let exited = false;
const tunnel = {
  async spawn() {
    child = agentProcess();
    createInterface({ input: child.stdout! }).on("line", (line) => lines.push(line));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("exit", () => {
      exited = true;
    });
    return { cwd, home, pid: child.pid ?? null, uid: process.getuid!(), gid: process.getgid!() };
  },
  async send(_sessionKey: string, line: string) {
    child!.stdin!.write(`${line}\n`);
  },
  async read(_sessionKey: string, afterSeq: number) {
    const fresh = lines.slice(afterSeq);
    return { lines: fresh, firstSeq: afterSeq + 1, nextSeq: lines.length, exited, truncated: false };
  },
  async kill() {
    child?.kill();
  },
  async execStart(): Promise<{ execId: number }> {
    throw new Error("exec is not used by this proof");
  },
  async execPoll(): Promise<never> {
    throw new Error("exec is not used by this proof");
  },
  async execKill(): Promise<void> {}
};

const client = new MossAcpClient(tunnel);
const handle = await client.openSession("proof", "proof", kind, "proof-user", "chat");
try {
  if (mode !== "env") {
    const requested = kind === "opencode" ? `moss/${model}` : model;
    const set = await client.setModelForChat(handle, requested);
    console.log(`SET applied=${set.applied} mismatch=${set.mismatch} mechanism=${set.mechanism}`);
  }
  if (process.env.PROOF_REPLAY_FILE) {
    const turns = readFileSync(process.env.PROOF_REPLAY_FILE, "utf8").trim().split("\n");
    // Same framing as renderReplayBlock in packages/chat/src/live/chat-context-blocks.ts.
    await client.prompt(
      handle,
      [
        "<conversation>",
        "The following is the prior conversation so far. Continue it; do not respond to this message.",
        ...turns,
        "</conversation>"
      ].join("\n")
    );
    console.log("REPLAYED");
  }
  const prompts: string[] = process.env.PROOF_PROMPTS_FILE
    ? JSON.parse(readFileSync(process.env.PROOF_PROMPTS_FILE, "utf8"))
    : [prompt];
  for (const [index, text] of prompts.entries()) {
    try {
      const result = await client.prompt(handle, text, { timeoutMs: 180_000 });
      const reply = mask(result.text).replace(/\s+/g, " ").slice(0, 200);
      console.log(`TURN ${index + 1} STOP ${result.stopReason} REPLY ${reply}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : error;
      console.log(`TURN ${index + 1} ERROR ${mask(message).slice(0, 300)}`);
      process.exitCode = 1;
    }
  }
} finally {
  await client.close(handle).catch(() => undefined);
  await tunnel.kill();
  // Mask the joined stream, never per chunk, so a key split across chunks is still caught.
  if (process.exitCode) console.log(`STDERR_TAIL ${mask(Buffer.concat(stderr)).slice(-1000)}`);
}
```

Start the recorder on a claimed dev port. It runs until Task 3.

```bash
export MOSS_REPO="$PWD"
export RECORDER_PORT="$(devports claim acp-proof)"
node /tmp/acp-proof/model-recorder.mjs "$RECORDER_PORT" /tmp/acp-proof/models.log &
echo $! > /tmp/acp-proof/recorder.pid
export PROOF_BASE_URL="http://127.0.0.1:$RECORDER_PORT"
```

### Task 1: Prove the claude agent answers through the proxy

**Files:**
- Create (not committed): `/tmp/acp-proof/acp-proof.mjs`
- Uses (not committed): `/tmp/acp-proof/key-scan.mjs`, `/tmp/acp-proof/model-recorder.mjs`, `/tmp/acp-proof/moss-client-proof.ts` from the shared setup

**Interfaces:**
- Consumes: nothing.
- Produces: the go/no-go facts for Task 3, the value of `$PROXY_ANTHROPIC_MODEL`, and the mechanism that carries the model (Step 7).

- [ ] **Step 1: Write the harness**

```js
// /tmp/acp-proof/acp-proof.mjs - phase 0 harness. Never commit.
// usage: node acp-proof.mjs <claude|opencode> <model> [prompt]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const [agent, model, prompt = "Reply with the single word: ready"] = process.argv.slice(2);
if (!["claude", "opencode"].includes(agent) || !model) {
  console.error("usage: node acp-proof.mjs <claude|opencode> <model> [prompt]");
  process.exit(2);
}
const home = need("PROOF_HOME");
const key = readFileSync(need("PROOF_KEY_FILE"), "utf8").trim();
const base = need("PROXY_URL").replace(/\/+$/, "");
const cwd = join(home, "work");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "note.txt"), "The proof word is heron.\n");
const mask = (text) => String(text).split(key).join("[KEY]");

const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8" };
let command;
let args;
let modelValue = model;
if (agent === "claude") {
  command = process.execPath;
  args = [need("ADAPTER_ENTRY")];
  env.ANTHROPIC_BASE_URL = base;
  env.ANTHROPIC_API_KEY = key;
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    env.CLAUDE_CODE_EXECUTABLE = process.env.CLAUDE_CODE_EXECUTABLE;
  }
  if (process.env.PROOF_SET_ANTHROPIC_MODEL === "1") env.ANTHROPIC_MODEL = model;
} else {
  command = need("OPENCODE_BIN");
  args = ["acp"];
  env.MOSS_OPENCODE_API_KEY = key;
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const entry = {
    npm: "@ai-sdk/openai-compatible",
    name: "Moss",
    options: { baseURL: `${base}/v1`, apiKey: "{env:MOSS_OPENCODE_API_KEY}" },
    models: { [model]: {} }
  };
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { moss: entry } }, null, 2), {
    mode: 0o600
  });
  modelValue = `moss/${model}`;
}

const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
console.log(`PID ${child.pid}`);
const stderr = [];
child.stderr.on("data", (chunk) => stderr.push(chunk));
// Mask the joined stream at exit, never per chunk, so a key split across chunks is caught.
child.on("exit", () => process.stderr.write(mask(Buffer.concat(stderr)).slice(-2000)));
const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let nextId = 1;
const pending = new Map();
const request = (method, params) => {
  const id = nextId++;
  write({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`NON_JSON ${mask(line)}`);
    return;
  }
  if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
    const waiter = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) waiter.reject(msg.error);
    else waiter.resolve(msg.result);
    return;
  }
  if (msg.method === "session/request_permission") {
    const options = msg.params?.options ?? [];
    const pick =
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => String(o.kind).startsWith("allow"));
    console.log(`\nPERMISSION ${mask(msg.params?.toolCall?.title ?? "")} -> ${pick?.optionId}`);
    const outcome = pick
      ? { outcome: "selected", optionId: pick.optionId }
      : { outcome: "cancelled" };
    write({ id: msg.id, result: { outcome } });
    return;
  }
  if (msg.method === "session/update") {
    const update = msg.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      process.stdout.write(mask(update.content.text));
    } else if (update?.sessionUpdate === "tool_call") {
      console.log(`\nTOOL_CALL ${mask(update.title ?? update.kind ?? "")}`);
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    write({ id: msg.id, error: { code: -32601, message: "not supported by the proof harness" } });
  }
});

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  });
  console.log(`AUTH_METHODS ${JSON.stringify((init.authMethods ?? []).map((m) => m.id))}`);
  const session = await request("session/new", { cwd, mcpServers: [] });
  const modelOption = (session.configOptions ?? []).find((o) => o.category === "model");
  const values = (modelOption?.options ?? []).flatMap((o) => o.options ?? [o]).map((o) => o.value);
  console.log(`MODEL_OPTION ${modelOption?.id ?? "none"} values=${mask(JSON.stringify(values))}`);
  if (modelOption) {
    await request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: modelOption.id,
      value: modelValue
    });
    console.log(`MODEL_SET ${modelValue}`);
  }
  const result = await request("session/prompt", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: prompt }]
  });
  console.log(`\nSTOP ${result.stopReason}`);
} catch (error) {
  console.log(`\nRPC_ERROR ${mask(JSON.stringify(error))}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
```

- [ ] **Step 2: List the proxy's Anthropic models and pick one**

```bash
node -e '
const key = require("fs").readFileSync(process.env.PROOF_KEY_FILE, "utf8").trim();
fetch(process.env.PROXY_URL + "/v1/models", {
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }
}).then(async (r) => console.log(r.status, ((await r.json()).data ?? []).map((m) => m.id).join(" ")));
'
export PROXY_ANTHROPIC_MODEL='<one id from that list>'
```

Expected: `200` and a list of ids. Anything else: stop.

- [ ] **Step 3: Run the claude adapter through the proxy**

```bash
export ADAPTER_ENTRY="$PWD/packages/cli-runner/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
node /tmp/acp-proof/acp-proof.mjs claude "$PROXY_ANTHROPIC_MODEL"
```

Expected:
- `AUTH_METHODS [...]` printed, then no `RPC_ERROR` from `initialize` (no login asked for).
- `MODEL_OPTION model values=[...]`. Record whether the proxy id is in the list.
- `MODEL_SET <id>` with no error. This proves the raw set call only; Step 7 proves the model Moss's own client ends up using.
- A short reply and `STOP end_turn`.

If `session/set_config_option` fails because the id is not listed, run again with `PROOF_SET_ANTHROPIC_MODEL=1` and record the result. The plan sets `ANTHROPIC_MODEL` at spawn either way (Task 9), so a pass with it set is still a pass.

- [ ] **Step 4: Prove a tool call with permission**

```bash
node /tmp/acp-proof/acp-proof.mjs claude "$PROXY_ANTHROPIC_MODEL" \
  'Read the file note.txt in the current folder and tell me the proof word.'
```

Expected: a `TOOL_CALL` line, possibly a `PERMISSION ... -> <allow option>` line, and a reply containing "heron".

- [ ] **Step 5: Prove a wrong key fails as an auth error**

```bash
WRONG=$(mktemp); printf 'sk-wrong-key-for-proof' > "$WRONG"; chmod 600 "$WRONG"
PROOF_KEY_FILE="$WRONG" node /tmp/acp-proof/acp-proof.mjs claude "$PROXY_ANTHROPIC_MODEL"; rm -f "$WRONG"
```

Expected: `RPC_ERROR` with code `-32000` and a message containing "Authentication required", either at `initialize`, `session/new` or `session/prompt`. Record which call failed and the exact error shape. If the failure is not an auth-required error, record it as a finding for Ben: Task 10 maps only auth-required errors to the rejected-key message.

- [ ] **Step 6: Check argv and the agent home for the key**

Start a slow prompt in the background, scan every process's argv while it runs, then scan the agent home and the run log after it ends. The scanner reads the key from the file; no key text reaches a command line.

```bash
node /tmp/acp-proof/acp-proof.mjs claude "$PROXY_ANTHROPIC_MODEL" \
  'Count slowly from one to forty, one number per line.' > /tmp/acp-proof/run.log 2>&1 &
sleep 5
node /tmp/acp-proof/key-scan.mjs "$PROOF_KEY_FILE" --argv
wait
node /tmp/acp-proof/key-scan.mjs "$PROOF_KEY_FILE" "$PROOF_HOME" /tmp/acp-proof/run.log
```

Expected: `ARGV_HITS 0` and `FILE_HITS 0` from the first scan, then `FILE_HITS 0`. A hit lists the pid or file name only (the spec's open risk about the claude CLI config); stop and report the name, never the content.

- [ ] **Step 7: Prove the effective model through Moss's own client**

Moss sets the model with `setModelForChat`, which substitutes an advertised value when the requested id is not advertised (`packages/acp/src/client.ts:472-489`). The raw harness bypasses that, so this step drives the adapter through the real client, with the recorder between the agent and the proxy. Pick a second proxy id that the claude adapter does not advertise (Step 3 printed the advertised values), ideally one containing `/`, `:` or `@`.

```bash
export PROXY_ANTHROPIC_ALT_MODEL='<a proxy id that is not in the MODEL_OPTION values>'
for id in "$PROXY_ANTHROPIC_MODEL" "$PROXY_ANTHROPIC_ALT_MODEL"; do
  for mode in set env both; do
    : > /tmp/acp-proof/models.log
    echo "== $mode"
    PROOF_MODE=$mode pnpm exec tsx /tmp/acp-proof/moss-client-proof.ts anthropic "$id"
    grep '/v1/messages' /tmp/acp-proof/models.log | sort | uniq -c
  done
done
```

Expected for mode `both` (what Moss does: `ANTHROPIC_MODEL` at spawn plus `setModelForChat`), for both ids: `SET ... mismatch=false`, `TURN 1 STOP end_turn`, and every recorded `/v1/messages` line reads `model=<that id>`. Record the `set` and `env` rows too; they show which mechanism carries the model. If `both` records any other model for either id, stop and report to Ben: the engine would need to skip or change the set call for API-key rows, which this plan does not include.

- [ ] **Step 8: Prove history replay**

```bash
printf '%s\n' 'User: Remember that the proof word is kestrel.' \
  'Assistant: Noted, the proof word is kestrel.' > /tmp/acp-proof/replay.txt
PROOF_REPLAY_FILE=/tmp/acp-proof/replay.txt pnpm exec tsx /tmp/acp-proof/moss-client-proof.ts \
  anthropic "$PROXY_ANTHROPIC_MODEL" 'What is the proof word from our conversation? One word.'
```

Expected: `REPLAYED`, then `TURN 1 STOP end_turn REPLY` containing "kestrel".

### Task 2: Prove OpenCode answers through the proxy with an env-referenced key

**Files:**
- Uses: `/tmp/acp-proof/acp-proof.mjs` from Task 1.

**Interfaces:**
- Consumes: shared setup.
- Produces: the go/no-go facts for Task 3, and `$PROXY_OPENAI_MODEL`.

- [ ] **Step 1: List the proxy's OpenAI-compatible models**

```bash
node -e '
const key = require("fs").readFileSync(process.env.PROOF_KEY_FILE, "utf8").trim();
fetch(process.env.PROXY_URL + "/v1/models", { headers: { authorization: "Bearer " + key } })
  .then(async (r) => console.log(r.status, ((await r.json()).data ?? []).map((m) => m.id).join(" ")));
'
export PROXY_OPENAI_MODEL='<one id from that list>'
```

Expected: `200` and a list of ids.

- [ ] **Step 2: Run OpenCode with the provider entry**

```bash
export PROOF_HOME="$(mktemp -d /tmp/acp-proof-home.XXXXXX)"
export OPENCODE_BIN="$PWD/packages/cli-runner/node_modules/.bin/opencode"
node /tmp/acp-proof/acp-proof.mjs opencode "$PROXY_OPENAI_MODEL"
```

Expected: no `RPC_ERROR`, `MODEL_OPTION` values include `moss/<id>`, `MODEL_SET moss/<id>`, a reply and `STOP end_turn`.

If OpenCode reports a missing key, the `{env:...}` reference does not work in this version. Stop: the spec's fallback (a per-session key file) needs Ben's decision.

- [ ] **Step 3: Prove a tool call**

```bash
node /tmp/acp-proof/acp-proof.mjs opencode "$PROXY_OPENAI_MODEL" \
  'Read the file note.txt in the current folder and tell me the proof word.'
```

Expected: a `TOOL_CALL` line and a reply containing "heron".

- [ ] **Step 4: Wrong key, argv and agent home**

Repeat Task 1 Steps 5 and 6 with `opencode "$PROXY_OPENAI_MODEL"`. Also confirm the settings file holds only the reference:

```bash
node /tmp/acp-proof/key-scan.mjs "$PROOF_KEY_FILE" "$PROOF_HOME/.config/opencode/opencode.json"
grep -c '{env:MOSS_OPENCODE_API_KEY}' "$PROOF_HOME/.config/opencode/opencode.json"
```

Expected: `FILE_HITS 0`, then `1`.

Record the wrong-key error shape. OpenCode may report it as a prompt error rather than auth-required; record exactly what it is.

- [ ] **Step 5: Prove the effective model through Moss's own client**

Moss writes the row's model into the entry, so the requested id is always advertised to OpenCode. This step proves `setModelForChat` keeps it and the proxy sees it unchanged. If the proxy lists an id containing `/`, `:` or `@`, use it here as well.

```bash
for id in "$PROXY_OPENAI_MODEL" '<a second proxy id with / : or @, if one exists>'; do
  : > /tmp/acp-proof/models.log
  PROOF_HOME="$(mktemp -d /tmp/acp-proof-home.XXXXXX)" \
    pnpm exec tsx /tmp/acp-proof/moss-client-proof.ts opencode "$id"
  grep '/v1/chat/completions' /tmp/acp-proof/models.log | sort | uniq -c
done
```

Expected for each id: `SET applied=true mismatch=false`, `TURN 1 STOP end_turn`, and every recorded `/v1/chat/completions` line reads `model=<that id>` (no `moss/` prefix). Any other model: stop and report to Ben.

- [ ] **Step 6: Prove history replay and a near-limit conversation**

The entry gives each model an empty object, so OpenCode 1.18.29 treats the context and output limits as 0 and never compacts. Moss does not supply limits. It relies on its bounded replay (at most 40 messages and 8000 tokens, `packages/chat/src/live/replay-window.ts`) and on a fresh session after a failure. This step proves both halves. Set the model's context size in tokens from the proxy's model card or its `/v1/models` `context_length` field.

```bash
export PROXY_OPENAI_CONTEXT_TOKENS='<context size of $PROXY_OPENAI_MODEL in tokens>'
PROOF_HOME="$(mktemp -d /tmp/acp-proof-home.XXXXXX)" \
  PROOF_REPLAY_FILE=/tmp/acp-proof/replay.txt pnpm exec tsx /tmp/acp-proof/moss-client-proof.ts \
  opencode "$PROXY_OPENAI_MODEL" 'What is the proof word from our conversation? One word.'
node -e '
const tokens = Number(process.env.PROXY_OPENAI_CONTEXT_TOKENS);
const filler = "lorem ipsum ".repeat(Math.floor(tokens / 4));
const prompts = [1, 2, 3, 4, 5].map((n) => `Part ${n}. Reply only "ok ${n}".\n${filler}`);
require("fs").writeFileSync("/tmp/acp-proof/near-limit.json", JSON.stringify(prompts));
'
time PROOF_HOME="$(mktemp -d /tmp/acp-proof-home.XXXXXX)" \
  PROOF_PROMPTS_FILE=/tmp/acp-proof/near-limit.json pnpm exec tsx \
  /tmp/acp-proof/moss-client-proof.ts opencode "$PROXY_OPENAI_MODEL"
PROOF_HOME="$(mktemp -d /tmp/acp-proof-home.XXXXXX)" \
  PROOF_REPLAY_FILE=/tmp/acp-proof/replay.txt pnpm exec tsx /tmp/acp-proof/moss-client-proof.ts \
  opencode "$PROXY_OPENAI_MODEL" 'What is the proof word from our conversation? One word.'
```

Expected:
- First run: `REPLAYED`, then a reply containing "kestrel".
- Near-limit run: five `TURN` lines, each a `STOP` or an `ERROR`, within the 180-second turn timeout. The conversation passes the context size by the fourth part, so at least one `ERROR` naming the context length is expected. A turn that never returns is a hang; stop and report to Ben.
- Last run: a fresh session with the bounded replay answers "kestrel".

Record the overflow error text (masked) for Task 10, which shows prompt errors to the user.

### Task 3: Record go or no-go on the task issue

**Files:** none.

- [ ] **Step 1: Post the results**

Write a plain-English comment on #3410 covering, for each agent: answered through the proxy (yes/no), the effective model matched the requested one through Moss's own client (and which of the env value and the set call carried it), tool call worked, history replay worked, wrong-key error shape, argv clean, agent home clean. For OpenCode add how the near-limit conversation ended (reply, clean error or hang). Say that a Moss tool call with its confirmation card is proved later, in Task 16, because the harness has no Moss tool server. Never include the proxy address, key, or model ids that reveal a private setup.

```bash
gh issue comment 3410 --body-file /tmp/acp-proof/results.md
kill "$(cat /tmp/acp-proof/recorder.pid)"
devports release "$RECORDER_PORT"
rm -rf /tmp/acp-proof /tmp/acp-proof-home.*
```

- [ ] **Step 2: Decide**

All proofs pass: continue to Phase 1. Any proof fails: stop and wait for Ben.

---
## Phase 1: Anthropic address and the add entry (gates stay shut)

### Task 4: One normalizer for provider addresses and one model id policy, used by the HTTP adapters

**Files:**
- Create: `packages/ai/src/provider-base-url.ts`
- Modify: `packages/ai/src/index.ts` (add the export)
- Modify: `packages/ai/src/adapters/http-api.ts:223` (anthropic `buildRequest` url), `:176` (transcription) and `:241` (OpenAI requests)
- Modify: `packages/ai/src/adapters/http-api-structured.ts:127` (anthropic) and `:159` (openai-compatible)
- Test: `tests/unit/ai-provider-base-url.test.ts` (create), `tests/unit/ai-http-api.test.ts`, `tests/unit/ai-http-api-structured.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"`, `OPENAI_DEFAULT_BASE_URL = "https://api.openai.com"`
  - `type BaseUrlProviderKind = "anthropic" | "openai-compatible"`
  - `providerBaseUrl(kind: BaseUrlProviderKind, stored: string | null | undefined): string` returns the address with no trailing slash and no trailing `/v1`, or the kind's default when the stored value is empty. Exported from `@moss/ai`.
  - `PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@-]{1,200}$/`, the one policy for a provider model id: letters, digits and `.` `_` `:` `/` `@` `-`, 1 to 200 characters. Task 5 (Anthropic discovery at a custom address) and Task 7 (RPC check) import it. Exported from `@moss/ai`.

- [ ] **Step 1: Write the failing normalizer test**

`tests/unit/ai-provider-base-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
  PROVIDER_MODEL_ID_PATTERN,
  providerBaseUrl
} from "../../packages/ai/src/provider-base-url.js";

describe("providerBaseUrl", () => {
  it.each([
    ["anthropic", null, ANTHROPIC_DEFAULT_BASE_URL],
    ["anthropic", undefined, ANTHROPIC_DEFAULT_BASE_URL],
    ["anthropic", "   ", ANTHROPIC_DEFAULT_BASE_URL],
    ["anthropic", "http://proxy.test", "http://proxy.test"],
    ["anthropic", "http://proxy.test/", "http://proxy.test"],
    ["anthropic", "http://proxy.test/v1", "http://proxy.test"],
    ["anthropic", "http://proxy.test/v1/", "http://proxy.test"],
    ["anthropic", " http://proxy.test/gateway/v1 ", "http://proxy.test/gateway"],
    ["openai-compatible", null, OPENAI_DEFAULT_BASE_URL],
    ["openai-compatible", "http://proxy.test/v1//", "http://proxy.test"]
  ] as const)("%s %j gives %s", (kind, stored, expected) => {
    expect(providerBaseUrl(kind, stored)).toBe(expected);
  });

  it("keeps a last path segment that merely ends in v1", () => {
    expect(providerBaseUrl("anthropic", "http://proxy.test/apiv1")).toBe("http://proxy.test/apiv1");
  });
});

describe("PROVIDER_MODEL_ID_PATTERN", () => {
  it.each(["claude-sonnet-4-5", "org/model:tag@v2", "gpt-4.1-mini", "a"])("accepts %s", (id) => {
    expect(PROVIDER_MODEL_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(["", "has space", "semi;colon", "quote\"", "new\nline", "x".repeat(201)])(
    "refuses %j",
    (id) => {
      expect(PROVIDER_MODEL_ID_PATTERN.test(id)).toBe(false);
    }
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit tests/unit/ai-provider-base-url.test.ts`
Expected: FAIL, cannot resolve `provider-base-url.js`.

- [ ] **Step 3: Write the normalizer**

`packages/ai/src/provider-base-url.ts`:

```ts
export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com";

export type BaseUrlProviderKind = "anthropic" | "openai-compatible";

/** A provider model id Moss accepts from discovery and on the spawn RPC. */
export const PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@-]{1,200}$/;

/**
 * A provider row's address in the form callers append paths to: no trailing slash and no
 * trailing `/v1`. An empty stored value means the kind's public default.
 */
export function providerBaseUrl(
  kind: BaseUrlProviderKind,
  stored: string | null | undefined
): string {
  const trimmed = (stored ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "")
    .replace(/\/+$/, "");
  if (trimmed.length > 0) return trimmed;
  return kind === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : OPENAI_DEFAULT_BASE_URL;
}
```

Add to `packages/ai/src/index.ts`, next to the other `export *` lines:

```ts
export * from "./provider-base-url.js";
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm test:unit tests/unit/ai-provider-base-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing adapter tests**

Append inside `describe("HttpApiAdapter — anthropic", ...)` in `tests/unit/ai-http-api.test.ts`:

```ts
  it("sends Anthropic requests to the row's address, with one /v1", async () => {
    const urls: string[] = [];
    const fakeFetch = async (url: string | URL | Request) => {
      urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200
      });
    };
    const adapter = new HttpApiAdapter("anthropic", "sk-test-anthropic", {
      fetch: fakeFetch as typeof fetch,
      baseUrl: "http://proxy.test/v1/"
    });

    await adapter.generateChat({ model: anthropicModel, messages: [{ role: "user", content: "yo" }] });

    expect(urls).toEqual(["http://proxy.test/v1/messages"]);
  });
```

Append inside `describe("HttpApiAdapter — openai-compatible", ...)` in the same file:

```ts
  it("sends OpenAI-compatible requests to the row's address, with one /v1", async () => {
    const urls: string[] = [];
    const fakeFetch = async (url: string | URL | Request) => {
      urls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        { status: 200 }
      );
    };
    const adapter = new HttpApiAdapter("openai-compatible", "sk-test-openai", {
      fetch: fakeFetch as typeof fetch,
      baseUrl: "http://proxy.test/v1/"
    });

    await adapter.generateChat({ model: openaiModel, messages: [{ role: "user", content: "yo" }] });

    expect(urls).toEqual(["http://proxy.test/v1/chat/completions"]);
  });
```

Append to the structured test file, inside the describe that holds `"anthropic: forced tool call, x-api-key header, versioned"`:

```ts
  it("anthropic: uses the row's address without doubling /v1", () => {
    expect(buildStructuredRequest("anthropic", "sk-a", "http://proxy.test/v1/", makeInput()).url).toBe(
      "http://proxy.test/v1/messages"
    );
    expect(buildStructuredRequest("anthropic", "sk-a", null, makeInput()).url).toBe(
      "https://api.anthropic.com/v1/messages"
    );
  });

  it("openai-compatible: uses the row's address without doubling /v1", () => {
    expect(
      buildStructuredRequest("openai-compatible", "sk-o", "http://proxy.test/v1", makeInput()).url
    ).toBe("http://proxy.test/v1/chat/completions");
  });
```

- [ ] **Step 6: Run them and watch the first fail**

Run: `pnpm test:unit tests/unit/ai-http-api.test.ts` then `pnpm test:unit tests/unit/ai-http-api-structured.test.ts`
Expected: the Anthropic adapter test FAILS (url is `https://api.anthropic.com/v1/messages`) and the OpenAI-compatible one FAILS (`http://proxy.test/v1//v1/chat/completions`). The structured tests FAIL (`http://proxy.test/v1//v1/messages` and `http://proxy.test/v1/v1/chat/completions`).

- [ ] **Step 7: Use the normalizer in both adapters**

In `packages/ai/src/adapters/http-api.ts`, add the import after line 29 (`import type { ProviderKind } ...`):

```ts
import { providerBaseUrl } from "../provider-base-url.js";
```

and in the anthropic case of `buildRequest` replace

```ts
          url: "https://api.anthropic.com/v1/messages",
```

with

```ts
          url: `${providerBaseUrl("anthropic", this._baseUrl)}/v1/messages`,
```

and replace both occurrences (transcription at `:176`, OpenAI requests at `:241`) of

```ts
        const base = this._baseUrl ?? "https://api.openai.com";
```

with

```ts
        const base = providerBaseUrl("openai-compatible", this._baseUrl);
```

In `packages/ai/src/adapters/http-api-structured.ts`, add after line 3:

```ts
import { providerBaseUrl } from "../provider-base-url.js";
```

and replace

```ts
      const base = baseUrl ?? "https://api.anthropic.com";
```

with

```ts
      const base = providerBaseUrl("anthropic", baseUrl);
```

and in the `openai-compatible` case replace

```ts
      const base = baseUrl ?? "https://api.openai.com";
```

with

```ts
      const base = providerBaseUrl("openai-compatible", baseUrl);
```

- [ ] **Step 8: Run all three files and watch them pass**

Run each: `pnpm test:unit tests/unit/ai-provider-base-url.test.ts`, `pnpm test:unit tests/unit/ai-http-api.test.ts`, `pnpm test:unit tests/unit/ai-http-api-structured.test.ts`
Expected: PASS. The existing default-address and custom-address assertions (`https://my-proxy.example.com`, `https://self-hosted.example.test`, `https://llm.internal`) still pass, because an address without `/v1` is unchanged.

- [ ] **Step 9: Commit**

```bash
git add packages/ai/src/provider-base-url.ts packages/ai/src/index.ts \
  packages/ai/src/adapters/http-api.ts packages/ai/src/adapters/http-api-structured.ts \
  tests/unit/ai-provider-base-url.test.ts tests/unit/ai-http-api.test.ts \
  tests/unit/ai-http-api-structured.test.ts
git commit -m "feat(ai): normalize provider base URLs in HTTP adapters, add model id policy (#3410)"
```

### Task 5: Model discovery and key test share the address and model id policy; fixed messages become constants

**Files:**
- Modify: `packages/ai/src/model-discovery.ts:199` and `:216-219` (`doFetch` anthropic and openai-compatible cases), `:179` and `:246-277` (`extractModelEntries`), `:373-414` (`inferModel`)
- Modify: `packages/ai/src/provider-validation.ts:34,50,60,97,111`, `:150` and `:164-168` (`fetchModels` anthropic and openai-compatible cases)
- Test: `tests/unit/ai-model-discovery.test.ts`, `tests/unit/ai-provider-validation.test.ts`, `tests/unit/ai-discover-and-persist-models.test.ts`

**Interfaces:**
- Consumes: `providerBaseUrl`, `ANTHROPIC_DEFAULT_BASE_URL`, `PROVIDER_MODEL_ID_PATTERN` (Task 4).
- Behaviour after this task:
  - Discovery and the key test call `providerBaseUrl` for anthropic, openai-compatible, ollama and custom rows, so `/v1` and `/v1/` addresses give exactly one `/v1/models`.
  - Anthropic discovery at the public address keeps today's filter. At a custom address it keeps every id that matches `PROVIDER_MODEL_ID_PATTERN`, so `org/model:tag@v2` survives.
  - The supported model contract is chat models. `inferModel` returns null for ids naming embedding, moderation, rerank, text-to-speech or image-generation models, as it already does for transcription. A list holding only such ids yields no models and no error reason.
- Produces (exported from `packages/ai/src/provider-validation.ts`, so from `@moss/ai`):
  - `PROVIDER_CREDENTIAL_MISSING_MESSAGE = "Provider credential is missing."`
  - `PROVIDER_CREDENTIAL_VALID_MESSAGE = "Provider credential is valid."`
  - `PROVIDER_REJECTED_CREDENTIAL_MESSAGE = "Provider rejected the credential."`
  - `PROVIDER_TEST_FAILED_MESSAGE = "Provider test failed."`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/ai-provider-validation.test.ts` (extend its import from `../../packages/ai/src/provider-validation.js` with `PROVIDER_CREDENTIAL_VALID_MESSAGE` and `PROVIDER_REJECTED_CREDENTIAL_MESSAGE`):

```ts
describe("Anthropic API-key checks use the row's address", () => {
  function recordingFetch(status: number) {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "claude-test-model" }] }), { status });
    }) as typeof globalThis.fetch;
    return { urls, fetch };
  }

  it("tests the key against the stored address", async () => {
    const { urls, fetch } = recordingFetch(200);
    const result = await testProviderCredential({
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: "http://proxy.test/v1",
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(urls).toEqual(["http://proxy.test/v1/models"]);
    expect(result).toMatchObject({ ok: true, message: PROVIDER_CREDENTIAL_VALID_MESSAGE });
  });

  it("reports a 401 from the stored address as a rejected credential", async () => {
    const { fetch } = recordingFetch(401);
    const result = await testProviderCredential({
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: "http://proxy.test",
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(result).toMatchObject({ ok: false, message: PROVIDER_REJECTED_CREDENTIAL_MESSAGE });
  });

  it("falls back to the public Anthropic address when none is stored", async () => {
    const { urls, fetch } = recordingFetch(200);
    await discoverProviderModels({
      providerKind: "anthropic",
      authMethod: "api_key",
      baseUrl: null,
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(urls).toEqual(["https://api.anthropic.com/v1/models"]);
  });
});
```

Append to `tests/unit/ai-model-discovery.test.ts`:

```ts
describe("Anthropic API-key discovery address", () => {
  it("lists models from the row's address", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "claude-test-model" }] }), {
        status: 200
      });
    }) as typeof globalThis.fetch;

    const result = await new ModelDiscoveryService().discoverModels("u1:p1", {
      providerKind: "anthropic",
      authMethod: "api_key",
      acpAgentId: null,
      baseUrl: "http://proxy.test/",
      credential: { apiKey: "sk-test" },
      fetch
    });

    expect(urls).toEqual(["http://proxy.test/v1/models"]);
    expect(result.reason).toBeUndefined();
  });
});
```

Append to `tests/unit/ai-provider-validation.test.ts`:

```ts
describe("OpenAI-compatible key test uses the normalized address", () => {
  it.each(["http://proxy.test/v1", "http://proxy.test/v1/"])("%s gives one /v1", async (baseUrl) => {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "org/model:tag@v2" }] }), { status: 200 });
    }) as typeof globalThis.fetch;
    await testProviderCredential({
      providerKind: "openai-compatible",
      authMethod: "api_key",
      baseUrl,
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(urls).toEqual(["http://proxy.test/v1/models"]);
  });
});
```

Append to `tests/unit/ai-model-discovery.test.ts`:

```ts
describe("API-key discovery model contract", () => {
  function listing(ids: readonly string[]) {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { urls, fetch };
  }

  it("keeps proxy ids at a custom Anthropic address and drops ids outside the policy", async () => {
    const { fetch } = listing(["org/model:tag@v2", "claude-test-model", "has space"]);
    const result = await new ModelDiscoveryService().discoverModels("u1:p2", {
      providerKind: "anthropic",
      authMethod: "api_key",
      acpAgentId: null,
      baseUrl: "http://proxy.test/v1",
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(result.models.map((model) => model.providerModelId)).toEqual([
      "org/model:tag@v2",
      "claude-test-model"
    ]);
  });

  it("keeps the public Anthropic filter at the default address", async () => {
    const { fetch } = listing(["org/model:tag@v2", "claude-test-model", "claude-old:1"]);
    const result = await new ModelDiscoveryService().discoverModels("u1:p3", {
      providerKind: "anthropic",
      authMethod: "api_key",
      acpAgentId: null,
      baseUrl: null,
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(result.models.map((model) => model.providerModelId)).toEqual(["claude-test-model"]);
  });

  it("drops embedding, moderation, rerank, speech and image models", async () => {
    const { fetch } = listing([
      "gpt-test-chat",
      "text-embedding-3-small",
      "nomic-embed-text",
      "omni-moderation-latest",
      "bge-reranker-v2",
      "gpt-4o-mini-tts",
      "dall-e-3",
      "gpt-image-1"
    ]);
    const result = await new ModelDiscoveryService().discoverModels("u1:p4", {
      providerKind: "openai-compatible",
      authMethod: "api_key",
      acpAgentId: null,
      baseUrl: "http://proxy.test",
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(result.models.map((model) => model.providerModelId)).toEqual(["gpt-test-chat"]);
  });

  it("returns no chat-capable model, and no error, for an embedding-only list", async () => {
    const { fetch } = listing(["text-embedding-3-small", "nomic-embed-text"]);
    const result = await new ModelDiscoveryService().discoverModels("u1:p5", {
      providerKind: "openai-compatible",
      authMethod: "api_key",
      acpAgentId: null,
      baseUrl: "http://proxy.test",
      credential: { apiKey: "sk-test" },
      fetch
    });
    expect(result.models).toEqual([]);
    expect(result.reason).toBeUndefined();
  });
});
```

Append to `tests/unit/ai-discover-and-persist-models.test.ts` (extend the vitest import with `afterEach`). This drives discovery through to the rows handed to the repository, with the global fetch stubbed because `discoverAndPersistModels` passes no fetch:

```ts
describe("discoverAndPersistModels for API-key rows at a proxy address", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubListing(ids: readonly string[]) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    });
    return urls;
  }

  it.each([
    ["openai-compatible", "http://proxy.test/v1"],
    ["openai-compatible", "http://proxy.test/v1/"],
    ["anthropic", "http://proxy.test/v1"],
    ["anthropic", "http://proxy.test/v1/"]
  ] as const)("%s at %s persists the proxy id from one /v1/models", async (kind, baseUrl) => {
    const urls = stubListing(["org/model:tag@v2", "text-embedding-3-small"]);
    const repository = {
      deleteModelsForProviderExceptSentinel: vi.fn().mockResolvedValue(0),
      upsertDiscoveredModels: vi.fn().mockResolvedValue(0)
    };
    const outcome = await discoverAndPersistModels(
      {} as never,
      {
        actorUserId: "user-a",
        providerId: `prov-${kind}`,
        providerKind: kind,
        acpAgentId: null,
        authMethod: "api_key",
        baseUrl,
        credential: { apiKey: "sk-test" }
      },
      { repository: repository as never, modelDiscovery: new ModelDiscoveryService() }
    );

    expect(outcome.reason).toBeUndefined();
    expect(urls).toEqual(["http://proxy.test/v1/models"]);
    expect(repository.deleteModelsForProviderExceptSentinel).not.toHaveBeenCalled();
    const rows = repository.upsertDiscoveredModels.mock.calls[0]?.[2] as {
      providerModelId: string;
      capabilities: string[];
    }[];
    expect(rows.map((row) => row.providerModelId)).toEqual(["org/model:tag@v2"]);
    expect(rows[0]?.capabilities).toContain("chat");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run each: `pnpm test:unit tests/unit/ai-provider-validation.test.ts`, `pnpm test:unit tests/unit/ai-model-discovery.test.ts`, `pnpm test:unit tests/unit/ai-discover-and-persist-models.test.ts`
Expected: FAIL. The imports of the new constants are undefined, the Anthropic urls are the public address, the OpenAI-compatible urls are `http://proxy.test/v1/v1/models`, `org/model:tag@v2` is dropped by the Anthropic filter, and the embedding, moderation, rerank, speech and image ids come back tagged `chat`.

- [ ] **Step 3: Implement**

`packages/ai/src/model-discovery.ts`: add `import { providerBaseUrl } from "./provider-base-url.js";` after line 9, and in `doFetch` replace

```ts
      return f("https://api.anthropic.com/v1/models", {
```

with

```ts
      return f(`${providerBaseUrl("anthropic", input.baseUrl)}/v1/models`, {
```

and in the `openai-compatible` / `ollama` / `custom` case replace

```ts
      const base = (input.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
```

with

```ts
      const base = providerBaseUrl("openai-compatible", input.baseUrl);
```

Change the import to `import { ANTHROPIC_DEFAULT_BASE_URL, PROVIDER_MODEL_ID_PATTERN, providerBaseUrl } from "./provider-base-url.js";`. In `fetchApiKeyModels` (`:179`) pass whether an Anthropic row points somewhere other than the public address:

```ts
    const customAddress =
      providerBaseUrl("anthropic", input.baseUrl) !== ANTHROPIC_DEFAULT_BASE_URL;
    const models = extractModelEntries(input.providerKind, await response.json(), customAddress)
```

Give `extractModelEntries` the parameter and replace its anthropic filter:

```ts
function extractModelEntries(
  providerKind: AiProviderKind,
  json: unknown,
  customAddress = false
): DiscoveredModelEntry[] {
```

```ts
    if (providerKind === "anthropic") {
      // The public API lists current claude- models plus legacy ":" snapshots. A custom address
      // (proxy, router) names models freely, so keep every id the model id policy accepts.
      entries = customAddress
        ? entries.filter((entry) => PROVIDER_MODEL_ID_PATTERN.test(entry.id))
        : entries.filter((entry) => entry.id.includes("claude-") && !entry.id.includes(":"));
    }
```

In `inferModel`, directly after the transcription early return, add:

```ts
  // Chat is the supported model contract: embedding, moderation, rerank, text-to-speech and
  // image-generation models have no chat capability, so discovery drops them.
  if (NON_CHAT_MODEL_ID.test(lower)) {
    return null;
  }
```

and above `inferModel`:

```ts
const NON_CHAT_MODEL_ID = /embed|moderation|rerank|(^|[-_/.:])tts([-_/.:]|$)|dall-e|gpt-image/;
```

`packages/ai/src/provider-validation.ts`: add `import { providerBaseUrl } from "./provider-base-url.js";` after line 11, then add below the imports:

```ts
export const PROVIDER_CREDENTIAL_MISSING_MESSAGE = "Provider credential is missing.";
export const PROVIDER_CREDENTIAL_VALID_MESSAGE = "Provider credential is valid.";
export const PROVIDER_REJECTED_CREDENTIAL_MESSAGE = "Provider rejected the credential.";
export const PROVIDER_TEST_FAILED_MESSAGE = "Provider test failed.";
```

Replace every literal `"Provider credential is missing."`, `"Provider credential is valid."`, `"Provider rejected the credential."` and `"Provider test failed."` in the file with the matching constant (use your editor's search; there are seven sites). In `fetchModels` replace

```ts
      return f("https://api.anthropic.com/v1/models", {
```

with

```ts
      return f(`${providerBaseUrl("anthropic", input.baseUrl)}/v1/models`, {
```

and in the `openai-compatible` / `ollama` / `custom` case replace

```ts
      const base = (input.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
```

with

```ts
      const base = providerBaseUrl("openai-compatible", input.baseUrl);
```

- [ ] **Step 4: Run them and watch them pass**

Run each: `pnpm test:unit tests/unit/ai-provider-validation.test.ts`, `pnpm test:unit tests/unit/ai-model-discovery.test.ts`, `pnpm test:unit tests/unit/ai-discover-and-persist-models.test.ts`, `pnpm test:unit tests/unit/ai-model-discovery-web-search.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/model-discovery.ts packages/ai/src/provider-validation.ts \
  tests/unit/ai-model-discovery.test.ts tests/unit/ai-provider-validation.test.ts \
  tests/unit/ai-discover-and-persist-models.test.ts
git commit -m "feat(ai): discovery and key test share base URL and model id policy; drop non-chat models (#3410)"
```

### Task 6: "Anthropic (API key)" add entry and its app-map sentence

**Files:**
- Modify: `apps/web/src/settings/settings-ai-provider-catalog.ts:28` (insert after the Anthropic CLI entry)
- Modify: `packages/shared/src/app-map-core.ts:283`
- Test: `tests/unit/settings-ai-provider-catalog.test.ts` (create); `tests/unit/app-map-build.test.ts`, `tests/unit/app-map-contract.test.ts`, `tests/unit/app-map-integrity.test.ts` (run only)

**Interfaces:**
- Consumes: nothing.
- Produces: catalog entry `{ label: "Anthropic (API key)", kind: "anthropic", authMethod: "api_key" }`. The existing generic API-key form shows the "Base URL" and "API key" fields for it. The server route already accepts this pair.

- [ ] **Step 1: Write the failing test**

`tests/unit/settings-ai-provider-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { PROVIDER_CATALOG } from "../../apps/web/src/settings/settings-ai-provider-catalog.js";

describe("provider catalog", () => {
  it("offers Anthropic by API key next to the Anthropic CLI entry", () => {
    const labels = PROVIDER_CATALOG.map((entry) => entry.label);
    expect(PROVIDER_CATALOG).toContainEqual({
      label: "Anthropic (API key)",
      kind: "anthropic",
      authMethod: "api_key"
    });
    expect(labels.indexOf("Anthropic (API key)")).toBe(labels.indexOf("Anthropic") + 1);
  });

  it("keeps every label unique, because added entries are matched by label", () => {
    const labels = PROVIDER_CATALOG.map((entry) => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit tests/unit/settings-ai-provider-catalog.test.ts`
Expected: FAIL on the first test.

- [ ] **Step 3: Add the entry**

In `apps/web/src/settings/settings-ai-provider-catalog.ts`, after

```ts
  { label: "Anthropic", kind: "anthropic", authMethod: "cli" },
```

add

```ts
  { label: "Anthropic (API key)", kind: "anthropic", authMethod: "api_key" },
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm test:unit tests/unit/settings-ai-provider-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Describe the entry in the app map**

In `packages/shared/src/app-map-core.ts`, replace line 283

```ts
      "OpenAI-compatible provider to CLI auth requires choosing its agent. The Codex ACP row hands " +
```

with

```ts
      "OpenAI-compatible provider to CLI auth requires choosing its agent. " +
      "The catalog also offers Anthropic (API key), whose optional Base URL field points it at any " +
      "Anthropic-compatible service; background jobs and model lists use that address. The Codex ACP row hands " +
```

- [ ] **Step 6: Run the app-map tests**

Run each: `pnpm test:unit tests/unit/app-map-build.test.ts`, `pnpm test:unit tests/unit/app-map-contract.test.ts`, `pnpm test:unit tests/unit/app-map-integrity.test.ts`
Expected: PASS. If a snapshot or a length budget fails, read the failure: update a committed snapshot only when the diff is exactly this sentence.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/settings/settings-ai-provider-catalog.ts packages/shared/src/app-map-core.ts \
  tests/unit/settings-ai-provider-catalog.test.ts
git commit -m "feat(settings): add Anthropic (API key) to the provider catalog (#3410)"
```

Phase 1 is shippable on its own: background jobs can use an Anthropic-compatible service at a custom address. Chat still refuses API-key rows.

---
## Phase 2: Key delivery and routing (gates stay shut)

Nothing in this phase is reachable by a person until Task 12 opens the gate. Each task still ships with its own tests.

### Task 7: The `acpSpawn` RPC carries an optional, validated credential

**Files:**
- Modify: `packages/chat/src/live/rpc-contract.ts:633-652`
- Create: `packages/cli-runner/src/acp-spawn-credential.ts`
- Modify: `packages/cli-runner/src/connection.ts:630-657` (`acpSpawn` case) and `:737` (`errorCode`)
- Modify: `packages/cli-runner/src/engine-host.ts:145-162`
- Modify: `packages/cli-runner/src/acp-host.ts:286-293` (signature only; the value is used in Task 9)
- Test: `tests/unit/cli-runner-protocol.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_MODEL_ID_PATTERN` from `@moss/ai` (Task 4). `@moss/cli-runner` already depends on `@moss/ai`.
- Produces:
  - `interface RpcAcpSpawnCredential { readonly baseUrl: string | null; readonly apiKey: string; readonly model: string }` and `RpcAcpSpawnParams.credential?: RpcAcpSpawnCredential` (exported from `@moss/chat/live`).
  - `class AcpCredentialBadRequestError extends Error`
  - `readAcpSpawnCredential(raw: unknown, providerKind: string, profile: string): RpcAcpSpawnCredential | null` - `null` when `raw` is `undefined`; throws `AcpCredentialBadRequestError` with a message that never contains a submitted value.
  - `CliChatEngineHost.acpSpawn(sessionKey, projectId, providerKind, userId, profile, useCandidate = false, credential: RpcAcpSpawnCredential | null = null)` and the same seventh parameter on `AcpHost.spawn`.

- [ ] **Step 1: Write the failing protocol tests**

In `tests/unit/cli-runner-protocol.test.ts`, change the existing expectation in the "acpSpawn" success test (around line 332) to include the new seventh argument:

```ts
    expect(host.acpSpawn).toHaveBeenCalledWith(
      "workshop:u:p",
      "p",
      "anthropic",
      "user-1",
      "chat",
      false,
      null
    );
```

Then add, next to the "refuses acpSpawn without a provider kind" test:

```ts
  const credential = {
    baseUrl: "http://proxy.test",
    apiKey: "sk-test-never-echo-0001",
    model: "org/model:tag@v2"
  };

  it("passes a valid chat credential through to the host", async () => {
    const host = fakeHost();
    const spawn = vi.spyOn(host, "acpSpawn").mockResolvedValue({
      cwd: "/tmp/neutral-base/chat:u:p/acp/p",
      generation: 1,
      home: null,
      pid: null,
      uid: 2001,
      gid: 2001
    });
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);

    channel.feed(
      encodeFrame({
        t: "req",
        id: 41,
        method: "acpSpawn",
        sessionKey: "chat:u:p",
        params: { projectId: "p", providerKind: "opencode", userId: "u", profile: "chat", credential }
      })
    );
    await new Promise((r) => setTimeout(r, 5));
    const ok = channel.decodeAll().find((f) => (f as RpcOk).id === 41) as RpcOk;
    expect(ok.t).toBe("ok");
    expect(spawn).toHaveBeenCalledWith("chat:u:p", "p", "opencode", "u", "chat", false, credential);
  });

  // The last column is the exact value submitted in the bad field, so each case asserts against
  // what was actually sent, plus the fragment every case shares.
  it.each([
    ["a credential on a workshop spawn", "anthropic", "workshop", credential, credential.apiKey],
    ["a credential for Codex", "openai", "chat", credential, credential.apiKey],
    ["an extra field", "anthropic", "chat", { ...credential, extra: "x" }, credential.apiKey],
    [
      "a key with a space",
      "anthropic",
      "chat",
      { ...credential, apiKey: "sk-test never-echo-0001" },
      "sk-test never-echo-0001"
    ],
    [
      "a non-http address",
      "anthropic",
      "chat",
      { ...credential, baseUrl: "file:///sk-test-never-echo-0001" },
      "file:///sk-test-never-echo-0001"
    ],
    [
      "a model with a space",
      "anthropic",
      "chat",
      { ...credential, model: "a b sk-test-never-echo-0001" },
      "a b sk-test-never-echo-0001"
    ]
  ])("refuses %s without echoing any value (stays open)", async (_label, providerKind, profile, value, submitted) => {
    const host = fakeHost();
    const spawn = vi.spyOn(host, "acpSpawn");
    const channel = new FakeChannel();
    serveConnection(channel, deps(host));
    authenticate(channel);

    channel.feed(
      encodeFrame({
        t: "req",
        id: 42,
        method: "acpSpawn",
        sessionKey: "chat:u:p",
        params: { projectId: "p", providerKind, userId: "u", profile, credential: value }
      })
    );
    await new Promise((r) => setTimeout(r, 5));
    const frames = channel.decodeAll();
    const err = frames.find((f) => (f as RpcErr).id === 42) as RpcErr;
    expect(err.t).toBe("err");
    expect(err.error.code).toBe("bad_request");
    expect(JSON.stringify(frames)).not.toContain(submitted);
    expect(JSON.stringify(frames)).not.toContain("never-echo-0001");
    expect(JSON.stringify(frames)).not.toContain("proxy.test");
    expect(spawn).not.toHaveBeenCalled();
    expect(channel.closed).toBe(false);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit tests/unit/cli-runner-protocol.test.ts`
Expected: FAIL. The existing test sees six arguments, and the refusal cases spawn.

- [ ] **Step 3: Add the contract type**

In `packages/chat/src/live/rpc-contract.ts`, add above `export interface RpcAcpSpawnParams`:

```ts
/**
 * API-key chat credential for one spawn. Lives only in this socket payload and the agent's
 * process env; never argv, logs or error text.
 */
export interface RpcAcpSpawnCredential {
  /** Stored provider address, or null for the provider's public default. */
  readonly baseUrl: string | null;
  readonly apiKey: string;
  /** Provider model id the agent must use. */
  readonly model: string;
}
```

and add inside `RpcAcpSpawnParams`, after `useCandidate`:

```ts
  /** Present only for API-key chat rows. CLI rows send none. */
  readonly credential?: RpcAcpSpawnCredential;
```

- [ ] **Step 4: Write the validator**

`packages/cli-runner/src/acp-spawn-credential.ts`:

```ts
import { PROVIDER_MODEL_ID_PATTERN } from "@moss/ai";
import type { RpcAcpSpawnCredential } from "@moss/chat/live";

/** Refusal for a malformed credential. Messages name the field, never its value. */
export class AcpCredentialBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpCredentialBadRequestError";
  }
}

const CREDENTIAL_KEYS = "apiKey,baseUrl,model";
const API_KEY = /^[\x21-\x7e]{1,4096}$/;

export function readAcpSpawnCredential(
  raw: unknown,
  providerKind: string,
  profile: string
): RpcAcpSpawnCredential | null {
  if (raw === undefined) return null;
  if ((providerKind !== "anthropic" && providerKind !== "opencode") || profile !== "chat") {
    throw new AcpCredentialBadRequestError(
      "acpSpawn.credential is accepted only for anthropic or opencode chat spawns"
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AcpCredentialBadRequestError("acpSpawn.credential must be an object");
  }
  if (Object.keys(raw).sort().join(",") !== CREDENTIAL_KEYS) {
    throw new AcpCredentialBadRequestError(
      "acpSpawn.credential must have exactly baseUrl, apiKey and model"
    );
  }
  const { apiKey, baseUrl, model } = raw as Record<string, unknown>;
  if (typeof apiKey !== "string" || !API_KEY.test(apiKey)) {
    throw new AcpCredentialBadRequestError("acpSpawn.credential.apiKey is malformed");
  }
  if (baseUrl !== null && !isHttpUrl(baseUrl)) {
    throw new AcpCredentialBadRequestError(
      "acpSpawn.credential.baseUrl must be null or an http(s) URL"
    );
  }
  if (typeof model !== "string" || !PROVIDER_MODEL_ID_PATTERN.test(model)) {
    throw new AcpCredentialBadRequestError("acpSpawn.credential.model is malformed");
  }
  return { apiKey, baseUrl, model };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Wire it through the connection, engine host and ACP host**

`packages/cli-runner/src/connection.ts`: add the import next to the other local imports (around line 53):

```ts
import { AcpCredentialBadRequestError, readAcpSpawnCredential } from "./acp-spawn-credential.js";
```

In the `acpSpawn` case, after the profile check and before `const spawned = ...`, add:

```ts
      const credential = readAcpSpawnCredential(
        params.credential,
        params.providerKind,
        params.profile
      );
```

and pass it as the seventh argument:

```ts
      const spawned = await host.acpSpawn(
        key,
        params.projectId,
        params.providerKind as AcpProviderKind,
        params.userId,
        params.profile,
        params.useCandidate === true,
        credential
      );
```

In `errorCode`, after the `BadRequestError` line:

```ts
  if (err instanceof AcpCredentialBadRequestError) return "bad_request";
```

`packages/cli-runner/src/engine-host.ts:145-162`: add `credential: RpcAcpSpawnCredential | null = null` after `useCandidate = false`, pass it as the seventh argument to `this.acp.spawn(...)`, and add `type RpcAcpSpawnCredential` to the existing multi-line `@moss/chat/live` import (lines 14-55; keep it sorted as the block is).

`packages/cli-runner/src/acp-host.ts:286-293`: change the end of the `spawn` parameter list to

```ts
    useCandidate = false,
    credential: AcpCredential | null = null
  ): Promise<AcpSpawnResult> {
```

Task 9 adds the `AcpCredential` import and uses the value. For this task only, add `void credential;` as the first line of the body so lint passes; Task 9 removes it. Check `wc -l packages/cli-runner/src/acp-host.ts packages/cli-runner/src/engine-host.ts` (must stay at or under 1000).

To keep this task compiling before Task 9 exists, add to `acp-host.ts` next to the other `@moss/chat/live` import:

```ts
import type { RpcAcpSpawnCredential as AcpCredential } from "@moss/chat/live";
```

Task 9 replaces this line.

- [ ] **Step 6: Run it and watch it pass**

Run: `pnpm test:unit tests/unit/cli-runner-protocol.test.ts`
Expected: PASS.

- [ ] **Step 7: Removal step (RPC error messages hold no key)**

Temporarily change the apiKey message in `acp-spawn-credential.ts` to

```ts
    throw new AcpCredentialBadRequestError(`acpSpawn.credential.apiKey is malformed: ${String(apiKey)}`);
```

Run: `pnpm test:unit tests/unit/cli-runner-protocol.test.ts`
Expected: FAIL on "a key with a space", at `not.toContain(submitted)` with `sk-test never-echo-0001` in the received frames. Record the failing case name and the assertion line in the PR body. Revert the change and run again: PASS.

Repeat with the model message changed to `` `acpSpawn.credential.model is malformed: ${String(model)}` ``. Expected: FAIL on "a model with a space", at `not.toContain(submitted)`. Record it the same way, revert, and run again: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/chat/src/live/rpc-contract.ts packages/cli-runner/src/acp-spawn-credential.ts \
  packages/cli-runner/src/connection.ts packages/cli-runner/src/engine-host.ts \
  packages/cli-runner/src/acp-host.ts tests/unit/cli-runner-protocol.test.ts
git commit -m "feat(cli-runner): accept a validated API-key credential on acpSpawn (#3410)"
```

### Task 8: The home-preparation script writes or removes the OpenCode provider entry

**Files:**
- Create: `packages/acp/src/opencode-provider.ts`
- Modify: `packages/acp/src/index.ts` (add the export)
- Modify: `packages/cli-runner/src/agent-home-prepare-run.ts:12-15`
- Modify: `packages/cli-runner/src/agent-home-prepare.mjs` (header comment at `:17-18`, new helpers, `main()` at `:196-237`)
- Modify: `tests/unit/cli-runner-acp-host.test.ts` (`fakeAgentHomePrepare` mirrors the new block)
- Test: `tests/unit/cli-runner-opencode-provider-entry.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MOSS_OPENCODE_PROVIDER_ID = "moss"`, `MOSS_OPENCODE_API_KEY_ENV = "MOSS_OPENCODE_API_KEY"` (from `@moss/acp`).
  - `interface AgentHomeOpencodeProvider { readonly path: string; readonly id: string; readonly entry: { readonly baseUrl: string; readonly model: string; readonly apiKeyEnv: string } | null }`
  - `AgentHomePrepareRequest.opencodeProvider?: AgentHomeOpencodeProvider`
  - Script behaviour: a non-null `entry` sets `provider[id]` to `{ npm: "@ai-sdk/openai-compatible", name: "Moss", options: { baseURL, apiKey: "{env:<apiKeyEnv>}" }, models: { [model]: {} } }`. A null `entry` deletes `provider[id]`, drops an empty `provider` object, and does nothing when the file does not exist. Other keys in the file are kept. The entry is applied after the deny settings, to the same file.

- [ ] **Step 1: Write the failing script test**

`tests/unit/cli-runner-opencode-provider-entry.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-entry-"));
  dirs.push(dir);
  const configDir = join(dir, "home", ".config", "opencode");
  return { dir, configDir, path: join(configDir, "opencode.json") };
}

function run(request: unknown) {
  return spawnSync(process.execPath, [SCRIPT, JSON.stringify(request)], {
    input: "",
    encoding: "utf8"
  });
}

const entry = {
  baseUrl: "http://proxy.test/v1",
  model: "org/model:tag@v2",
  apiKeyEnv: "MOSS_OPENCODE_API_KEY"
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent-home-prepare OpenCode provider entry", () => {
  it("writes the entry with an env reference and keeps the deny settings", () => {
    const { configDir, path } = setup();
    const result = run({
      dirs: [configDir],
      denyFile: { path, permissionKeys: ["bash"] },
      opencodeProvider: { path, id: "moss", entry }
    });
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.permission).toEqual({ bash: "deny" });
    expect(config.provider).toEqual({
      moss: {
        npm: "@ai-sdk/openai-compatible",
        name: "Moss",
        options: { baseURL: "http://proxy.test/v1", apiKey: "{env:MOSS_OPENCODE_API_KEY}" },
        models: { "org/model:tag@v2": {} }
      }
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removes only its own entry and keeps everything else", () => {
    const { configDir, path } = setup();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ permission: { bash: "deny" }, provider: { moss: {}, other: { name: "x" } } })
    );
    expect(run({ dirs: [configDir], denyFile: null, opencodeProvider: { path, id: "moss", entry: null } }).status).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      permission: { bash: "deny" },
      provider: { other: { name: "x" } }
    });
  });

  it("drops an empty provider object after removal", () => {
    const { configDir, path } = setup();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: { moss: {} } }));
    run({ dirs: [configDir], denyFile: null, opencodeProvider: { path, id: "moss", entry: null } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("creates no file when there is nothing to remove", () => {
    const { configDir, path } = setup();
    const result = run({
      dirs: [configDir],
      denyFile: null,
      opencodeProvider: { path, id: "moss", entry: null }
    });
    expect(result.status).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses an entry carrying any field beyond address, model and variable name", () => {
    const { configDir, path } = setup();
    const result = run({
      dirs: [configDir],
      denyFile: null,
      opencodeProvider: { path, id: "moss", entry: { ...entry, apiKey: "sk-test-never-land-0002" } }
    });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("sk-test-never-land-0002");
    expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain("sk-test-never-land-0002");
  });

  it.each([
    ["a file address", { ...entry, baseUrl: "file:///etc/passwd" }],
    ["a lowercase variable name", { ...entry, apiKeyEnv: "moss_key" }],
    ["a model with a space", { ...entry, model: "a b" }]
  ])("refuses %s", (_label, bad) => {
    const { configDir, path } = setup();
    expect(run({ dirs: [configDir], denyFile: null, opencodeProvider: { path, id: "moss", entry: bad } }).status).toBe(1);
  });

  it("replaces a planted symlink instead of writing through it", () => {
    const { dir, configDir, path } = setup();
    mkdirSync(configDir, { recursive: true });
    const outside = join(dir, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, path);
    expect(run({ dirs: [configDir], denyFile: null, opencodeProvider: { path, id: "moss", entry } }).status).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("{}");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit tests/unit/cli-runner-opencode-provider-entry.test.ts`
Expected: FAIL. The script ignores `opencodeProvider`, so no `provider` key is written and the refusals exit 0.

- [ ] **Step 3: Add the shared constants**

`packages/acp/src/opencode-provider.ts`:

```ts
/** Provider id Moss writes into OpenCode's settings file for an API-key chat row. */
export const MOSS_OPENCODE_PROVIDER_ID = "moss";

/** Agent env variable holding the API key. The settings file holds only `{env:<name>}`. */
export const MOSS_OPENCODE_API_KEY_ENV = "MOSS_OPENCODE_API_KEY";
```

In `packages/acp/src/index.ts` add:

```ts
export { MOSS_OPENCODE_API_KEY_ENV, MOSS_OPENCODE_PROVIDER_ID } from "./opencode-provider.js";
```

- [ ] **Step 4: Extend the request type**

In `packages/cli-runner/src/agent-home-prepare-run.ts`, replace the `AgentHomePrepareRequest` interface with:

```ts
/** OpenCode provider entry to write (entry set) or remove (entry null). Never holds a key. */
export interface AgentHomeOpencodeProvider {
  readonly path: string;
  readonly id: string;
  readonly entry: {
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKeyEnv: string;
  } | null;
}

/** Argument passed as one JSON string to agent-home-prepare.mjs. */
export interface AgentHomePrepareRequest {
  readonly dirs: readonly string[];
  readonly denyFile: { readonly path: string; readonly permissionKeys: readonly string[] } | null;
  readonly opencodeProvider?: AgentHomeOpencodeProvider;
}
```

Do not re-export the new type from `acp-host.ts`; that file is at the line limit. Code that needs the type imports it from `./agent-home-prepare-run.js`.

- [ ] **Step 5: Implement the script block**

In `packages/cli-runner/src/agent-home-prepare.mjs`, update the header comment shape (lines 17-18) to:

```js
// Invoked with exactly one argv element: a JSON string shaped like
// { dirs: string[], denyFile: null | { path: string, permissionKeys: string[] },
//   opencodeProvider?: { path: string, id: string,
//                        entry: null | { baseUrl: string, model: string, apiKeyEnv: string } } }
// The entry names the key's env variable; the key itself is never passed here.
```

Add these helpers after `readExistingConfig`:

```js
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// Mirrors PROVIDER_MODEL_ID_PATTERN (packages/ai/src/provider-base-url.ts); .mjs cannot import it.
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,200}$/;

async function writeJsonFile(path, value) {
  const handle = await open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
  } finally {
    await handle.close();
  }
}

function assertOpencodeProvider(spec) {
  if (!spec || typeof spec.path !== "string" || !PROVIDER_ID.test(String(spec.id))) {
    throw new Error("opencodeProvider needs a path and a valid id");
  }
  if (spec.entry === null) return;
  const entry = spec.entry;
  const keys = entry && typeof entry === "object" ? Object.keys(entry).sort().join(",") : "";
  if (keys !== "apiKeyEnv,baseUrl,model") {
    throw new Error("opencodeProvider.entry must have exactly baseUrl, model and apiKeyEnv");
  }
  if (!ENV_NAME.test(String(entry.apiKeyEnv))) {
    throw new Error("opencodeProvider.entry.apiKeyEnv is not a valid variable name");
  }
  if (!MODEL_ID.test(String(entry.model))) {
    throw new Error("opencodeProvider.entry.model is malformed");
  }
  let protocol = "";
  try {
    protocol = new URL(String(entry.baseUrl)).protocol;
  } catch {
    protocol = "";
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("opencodeProvider.entry.baseUrl must be an http(s) URL");
  }
}

async function applyOpencodeProvider(spec) {
  assertOpencodeProvider(spec);
  let first;
  try {
    first = await lstat(spec.path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!first && spec.entry === null) return;
  if (first && first.isSymbolicLink()) await rm(spec.path, { force: true });
  const config = await readExistingConfig(spec.path);
  const provider =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? { ...config.provider }
      : {};
  if (spec.entry === null) {
    if (!Object.hasOwn(provider, spec.id)) return;
    delete provider[spec.id];
  } else {
    const { baseUrl, model, apiKeyEnv } = spec.entry;
    provider[spec.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: "Moss",
      options: { baseURL: baseUrl, apiKey: `{env:${apiKeyEnv}}` },
      models: { [model]: {} }
    };
  }
  if (Object.keys(provider).length > 0) config.provider = provider;
  else delete config.provider;
  await writeJsonFile(spec.path, config);
}
```

In `main()`, replace the deny block's final write

```js
    const handle = await open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(config, null, 2), "utf8");
    } finally {
      await handle.close();
    }
  }
```

with

```js
    await writeJsonFile(path, config);
  }

  if (request.opencodeProvider) await applyOpencodeProvider(request.opencodeProvider);
```

- [ ] **Step 6: Mirror the block in the host test's fake**

In `tests/unit/cli-runner-acp-host.test.ts`, at the end of `fakeAgentHomePrepare` (after the `denyFile` block), add:

```ts
  const spec = request.opencodeProvider;
  if (spec) {
    if (!existsSync(spec.path) && spec.entry === null) return;
    const config: Record<string, unknown> = existsSync(spec.path)
      ? (JSON.parse(readFileSync(spec.path, "utf8")) as Record<string, unknown>)
      : {};
    const provider = { ...((config.provider as Record<string, unknown> | undefined) ?? {}) };
    if (spec.entry === null) delete provider[spec.id];
    else
      provider[spec.id] = {
        npm: "@ai-sdk/openai-compatible",
        name: "Moss",
        options: { baseURL: spec.entry.baseUrl, apiKey: `{env:${spec.entry.apiKeyEnv}}` },
        models: { [spec.entry.model]: {} }
      };
    if (Object.keys(provider).length > 0) config.provider = provider;
    else delete config.provider;
    writeFileSync(spec.path, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
```

- [ ] **Step 7: Run both tests and watch them pass**

Run: `pnpm test:unit tests/unit/cli-runner-opencode-provider-entry.test.ts` then `pnpm test:unit tests/unit/cli-runner-acp-host.test.ts`
Expected: PASS.

- [ ] **Step 8: Removal step (settings file never takes extra fields)**

Temporarily delete the `if (keys !== "apiKeyEnv,baseUrl,model") { ... }` check in `assertOpencodeProvider`.
Run: `pnpm test:unit tests/unit/cli-runner-opencode-provider-entry.test.ts`
Expected: FAIL on "refuses an entry carrying any field..." (exit status 0). Restore the check and run again: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/acp/src/opencode-provider.ts packages/acp/src/index.ts \
  packages/cli-runner/src/agent-home-prepare-run.ts packages/cli-runner/src/agent-home-prepare.mjs \
  tests/unit/cli-runner-acp-host.test.ts tests/unit/cli-runner-opencode-provider-entry.test.ts
git commit -m "feat(cli-runner): write and remove the OpenCode API-key provider entry (#3410)"
```


### Task 9: The sidecar puts the credential in the agent env and builds the OpenCode entry

**Files:**
- Create: `packages/cli-runner/src/acp-launch-credential.ts`
- Create: `packages/cli-runner/src/stderr-redactor.ts`
- Modify: `packages/cli-runner/src/acp-host.ts` (imports at `:14`, `:70`, `:79`; the token block in `spawn` at about `:377-380`; the prepare call; the stderr line at about `:586`; delete `readLoginToken` at about `:989-997`)
- Test: `tests/unit/cli-runner-acp-host-api-key.test.ts` (create), `tests/unit/cli-runner-stderr-redactor.test.ts` (create); `tests/unit/cli-runner-acp-host.test.ts` (run only)

**Interfaces:**
- Consumes: `RpcAcpSpawnCredential` and the seventh `spawn` parameter (Task 7); `MOSS_OPENCODE_PROVIDER_ID`, `MOSS_OPENCODE_API_KEY_ENV`, `AgentHomeOpencodeProvider`, `AgentHomePrepareRequest.opencodeProvider` (Task 8); `providerBaseUrl` (Task 4); `redactSecrets(text)` (already exported from `@moss/ai`).
- Produces:
  - `type AcpCredential = RpcAcpSpawnCredential`
  - `applyAgentCredential(env: NodeJS.ProcessEnv, launch: AgentCredentialLaunch): Promise<AgentHomeOpencodeProvider | undefined>`
  - Agent env for an API-key claude spawn: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and `ANTHROPIC_BASE_URL` only when the row has an address. No `CLAUDE_CODE_OAUTH_TOKEN`.
  - Agent env for an API-key OpenCode spawn: `MOSS_OPENCODE_API_KEY`. The settings entry gets the address with exactly one `/v1`.
  - Every OpenCode spawn without a credential (chat or workshop) asks the preparation step to remove the Moss entry.
  - `createStreamRedactor(secret: string | undefined): StreamRedactor` with `push(chunk: Buffer): string` and `flush(): string`, and `logRedactedStderr(stream, secret, log)`, in `stderr-redactor.ts`.

Adapter stderr is masked across chunk boundaries, with no disclosure waiver. The redactor holds back at most `key length - 1` characters, and only while they could still start the key, so ordinary diagnostics are logged at once. This keeps the stderr log, which is the only diagnostic for adapter and proxy failures in the first live runs. Dropping stderr for API-key sessions was the alternative; it is safe but leaves a failed live run with no evidence.

The model travels inside the credential because OpenCode needs the bare model id in its settings entry, and the claude agent needs it before the first prompt. `ANTHROPIC_MODEL` is set as well as the existing `setModelForChat` call, so the agent never starts on a default model the proxy does not serve.

- [ ] **Step 1: Write the failing host tests**

`tests/unit/cli-runner-acp-host-api-key.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpHost, type AgentHomePrepareRequest } from "../../packages/cli-runner/src/acp-host.js";

// Not shaped like any known key, so only the per-key mask can hide it.
const KEY = "localproxy0003neverlog";
const MODEL = "org/model:tag@v2";
const CREDENTIAL = { baseUrl: "http://proxy.test/v1/", apiKey: KEY, model: MODEL };

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: (): void => undefined };

  kill(): boolean {
    return true;
  }
}

const selfSlot = (): { uid: number; gid: number } => ({
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0
});

function makeHost(dir: string) {
  const homeBase = join(dir, "homes");
  mkdirSync(homeBase, { recursive: true });
  const child = new FakeChild();
  const spawns: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const requests: AgentHomePrepareRequest[] = [];
  const host = new AcpHost({
    neutralBase: dir,
    homeBase,
    perUserUid: true,
    allocateUidSlot: selfSlot,
    resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
    readTokenFile: async () => "tok_cli-login",
    spawnChild: (opts) => {
      spawns.push({ args: opts.args, env: opts.env });
      return child as never;
    },
    runAgentHomePrepare: async (request) => {
      requests.push(request);
      for (const path of request.dirs) mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    purgePrivateFolder: async (cwd) => {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  return { host, child, spawns, requests, agentHome: join(homeBase, "agents", "user-1") };
}

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "acp-api-key-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("AcpHost API-key launches", () => {
  it("gives the claude agent the row's address, key and model, and no login token", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns } = makeHost(dir);
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat", false, CREDENTIAL);
      const env = spawns[0]!.env;
      expect(env.ANTHROPIC_BASE_URL).toBe("http://proxy.test");
      expect(env.ANTHROPIC_API_KEY).toBe(KEY);
      expect(env.ANTHROPIC_MODEL).toBe(MODEL);
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(JSON.stringify(spawns[0]!.args)).not.toContain(KEY);
    });
  });

  it("leaves the claude address unset when the row has none", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns } = makeHost(dir);
      const credential = { ...CREDENTIAL, baseUrl: null };
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat", false, credential);
      expect(spawns[0]!.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(spawns[0]!.env.ANTHROPIC_API_KEY).toBe(KEY);
    });
  });

  it("keeps server-level key variables away from a CLI-login claude agent", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "server-level-value");
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://server-level.test");
    vi.stubEnv("ANTHROPIC_MODEL", "server-level-model");
    vi.stubEnv("MOSS_OPENCODE_API_KEY", "server-level-value");
    await inTempDir(async (dir) => {
      const { host, spawns } = makeHost(dir);
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat");
      const env = spawns[0]!.env;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_cli-login");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_MODEL).toBeUndefined();
      expect(env.MOSS_OPENCODE_API_KEY).toBeUndefined();
    });
  });

  it("writes an OpenCode entry with one /v1 and an env reference, never the key", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns, requests, agentHome } = makeHost(dir);
      await host.spawn("chat:user-1:a", "proj", "opencode", "user-1", "chat", false, CREDENTIAL);
      expect(requests[0]!.opencodeProvider).toEqual({
        path: join(agentHome, ".config", "opencode", "opencode.json"),
        id: "moss",
        entry: { baseUrl: "http://proxy.test/v1", model: MODEL, apiKeyEnv: "MOSS_OPENCODE_API_KEY" }
      });
      expect(requests[0]!.denyFile).not.toBeNull();
      expect(JSON.stringify(requests)).not.toContain(KEY);
      expect(spawns[0]!.env.MOSS_OPENCODE_API_KEY).toBe(KEY);
      expect(JSON.stringify(spawns[0]!.args)).not.toContain(KEY);
    });
  });

  it("removes the OpenCode entry on every CLI-login OpenCode spawn, chat or workshop", async () => {
    await inTempDir(async (dir) => {
      const { host, spawns, requests, agentHome } = makeHost(dir);
      await host.spawn("chat:user-1:a", "proj", "opencode", "user-1", "chat", false, CREDENTIAL);
      await host.spawn("chat:user-1:b", "proj", "opencode", "user-1", "chat");
      await host.spawn("workshop:user-1:proj", "proj", "opencode", "user-1", "workshop");
      const configDir = join(agentHome, ".config", "opencode");
      for (const request of requests.slice(1)) {
        expect(request.opencodeProvider).toEqual({
          path: join(configDir, "opencode.json"),
          id: "moss",
          entry: null
        });
        expect(request.dirs).toContain(configDir);
      }
      expect(spawns[1]!.env.MOSS_OPENCODE_API_KEY).toBeUndefined();
      expect(spawns[2]!.env.MOSS_OPENCODE_API_KEY).toBeUndefined();
    });
  });

  it("masks the key in the adapter's logged error output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await inTempDir(async (dir) => {
      const { host, child } = makeHost(dir);
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat", false, CREDENTIAL);
      child.stderr.emit("data", Buffer.from(`upstream said ${KEY} is not valid\n`));
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("[redacted]");
      expect(logged).not.toContain(KEY);
    });
  });

  it("masks a key split across stderr chunks, through the final flush", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await inTempDir(async (dir) => {
      const { host, child } = makeHost(dir);
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat", false, CREDENTIAL);
      const half = Math.floor(KEY.length / 2);
      child.stderr.emit("data", Buffer.from(`upstream said ${KEY.slice(0, half)}`));
      const rest = `${KEY.slice(half)} is not valid\nfatal: ${KEY.slice(0, 6)}`;
      child.stderr.emit("data", Buffer.from(rest));
      child.stderr.emit("end");
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("upstream said [redacted] is not valid");
      expect(logged).toContain("fatal: [redacted]");
      expect(logged).not.toContain(KEY.slice(0, 6));
      expect(logged).not.toContain(KEY.slice(half));
    });
  });
});
```
```

`tests/unit/cli-runner-stderr-redactor.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createStreamRedactor } from "../../packages/cli-runner/src/stderr-redactor.js";

// No "sk-" prefix, so the generic secret patterns cannot hide a redactor bug.
const KEY = "localproxy0004neverlog";
const LINE = `upstream said ${KEY} is not valid\n`;
const MASKED = "upstream said [redacted] is not valid\n";

function run(secret: string | undefined, chunks: readonly (string | Buffer)[]): string {
  const redactor = createStreamRedactor(secret);
  const pushed = chunks.map((chunk) => redactor.push(Buffer.from(chunk))).join("");
  return pushed + redactor.flush();
}

const splits = Array.from({ length: KEY.length - 1 }, (_, index) => index + 1);

describe("createStreamRedactor", () => {
  it("passes text through unchanged when there is no secret", () => {
    expect(run(undefined, ["plain ", "text\n"])).toBe("plain text\n");
  });

  it.each(splits)("masks a key split after its character %i", (split) => {
    const at = LINE.indexOf(KEY) + split;
    expect(run(KEY, [LINE.slice(0, at), LINE.slice(at)])).toBe(MASKED);
  });

  it("masks a key fed one character per chunk", () => {
    expect(run(KEY, [...LINE])).toBe(MASKED);
  });

  it("masks repeats, including back-to-back copies, at every split position", () => {
    const text = `${KEY}${KEY} and ${KEY}\n`;
    for (let at = 1; at < text.length; at += 1) {
      expect(run(KEY, [text.slice(0, at), text.slice(at)])).toBe(
        "[redacted][redacted] and [redacted]\n"
      );
    }
  });

  it.each(splits)("masks a stream that ends after %i characters of the key", (length) => {
    expect(run(KEY, ["fatal: ", KEY.slice(0, length)])).toBe("fatal: [redacted]");
  });

  it("releases text that cannot start the key without waiting for more", () => {
    const redactor = createStreamRedactor(KEY);
    expect(redactor.push(Buffer.from("no secret here\n"))).toBe("no secret here\n");
  });

  it("keeps a multi-byte character split across chunks intact", () => {
    const bytes = Buffer.from("café\n");
    expect(run(KEY, [bytes.subarray(0, 4), bytes.subarray(4)])).toBe("café\n");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test:unit tests/unit/cli-runner-acp-host-api-key.test.ts`
Expected: FAIL. The claude case has no `ANTHROPIC_API_KEY`, the OpenCode cases have no `opencodeProvider`, and both stderr cases log the key (the split case logs both halves). The server-level case already passes, because the sanitizer drops those variables; it stays as a guard.
Run: `pnpm test:unit tests/unit/cli-runner-stderr-redactor.test.ts`
Expected: FAIL, cannot resolve `stderr-redactor.js`.

- [ ] **Step 3: Write the helpers**

`packages/cli-runner/src/stderr-redactor.ts`:

```ts
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { redactSecrets } from "@moss/ai";

const MASK = "[redacted]";
const MAX_LOGGED = 2000;

export interface StreamRedactor {
  push(chunk: Buffer): string;
  flush(): string;
}

/**
 * Index where the trailing text could still be the start of `secret`, or `text.length` when no
 * tail can. The holdback is at most `secret.length - 1` characters.
 */
function heldFrom(text: string, secret: string): number {
  const start = Math.max(0, text.length - (secret.length - 1));
  for (let index = start; index < text.length; index += 1) {
    if (secret.startsWith(text.slice(index))) return index;
  }
  return text.length;
}

/**
 * Masks every copy of one secret in a byte stream, including copies split across chunks.
 * `push` returns the text that can no longer be part of a secret and holds the rest. `flush`
 * releases the held text, masking a trailing partial secret.
 */
export function createStreamRedactor(secret: string | undefined): StreamRedactor {
  const decoder = new StringDecoder("utf8");
  if (!secret) return { push: (chunk) => decoder.write(chunk), flush: () => decoder.end() };
  let held = "";
  return {
    push(chunk) {
      const text = (held + decoder.write(chunk)).split(secret).join(MASK);
      const cut = heldFrom(text, secret);
      held = text.slice(cut);
      return text.slice(0, cut);
    },
    flush() {
      const text = (held + decoder.end()).split(secret).join(MASK);
      held = "";
      const cut = heldFrom(text, secret);
      return cut < text.length ? `${text.slice(0, cut)}${MASK}` : text;
    }
  };
}

/** Logs an adapter's stderr with the session secret and generic token patterns masked. */
export function logRedactedStderr(
  stream: Readable,
  secret: string | undefined,
  log: (text: string) => void
): void {
  const redactor = createStreamRedactor(secret);
  const emit = (text: string) => {
    const safe = redactSecrets(text).slice(-MAX_LOGGED);
    if (safe.length > 0) log(safe);
  };
  stream.on("data", (chunk: Buffer) => emit(redactor.push(chunk)));
  stream.on("end", () => emit(redactor.flush()));
}
```

Then the credential helper.

`packages/cli-runner/src/acp-launch-credential.ts`:

```ts
/**
 * Puts a chat agent's credential into its environment. An API-key launch gets the row's
 * address, key and model; a CLI-login claude launch gets the stored login token. Keys travel
 * only by environment, never by argument or settings file.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MOSS_OPENCODE_API_KEY_ENV,
  MOSS_OPENCODE_PROVIDER_ID,
  type AcpProviderKind
} from "@moss/acp";
import { providerBaseUrl } from "@moss/ai";
import type { RpcAcpSpawnCredential } from "@moss/chat/live";

import type { AgentHomeOpencodeProvider } from "./agent-home-prepare-run.js";
import { providerTokenPath } from "./provider-token-store.js";

export type AcpCredential = RpcAcpSpawnCredential;

export interface AgentCredentialLaunch {
  readonly agentHome: string;
  readonly homeBase: string;
  readonly providerKind: AcpProviderKind;
  readonly credential: AcpCredential | null;
  readonly readTokenFile?: (path: string) => Promise<string>;
}

/**
 * Sets the credential variables on `env`. For OpenCode it also returns the settings change:
 * the Moss provider entry for an API-key launch, or its removal for any other launch.
 */
export async function applyAgentCredential(
  env: NodeJS.ProcessEnv,
  launch: AgentCredentialLaunch
): Promise<AgentHomeOpencodeProvider | undefined> {
  const { credential, providerKind } = launch;
  if (providerKind === "anthropic") {
    if (credential) {
      if (credential.baseUrl !== null) {
        env.ANTHROPIC_BASE_URL = providerBaseUrl("anthropic", credential.baseUrl);
      }
      env.ANTHROPIC_API_KEY = credential.apiKey;
      env.ANTHROPIC_MODEL = credential.model;
    } else {
      const token = await readLoginToken(launch);
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
    return undefined;
  }
  if (providerKind !== "opencode") return undefined;

  const path = join(launch.agentHome, ".config", "opencode", "opencode.json");
  if (!credential) return { path, id: MOSS_OPENCODE_PROVIDER_ID, entry: null };
  env[MOSS_OPENCODE_API_KEY_ENV] = credential.apiKey;
  return {
    path,
    id: MOSS_OPENCODE_PROVIDER_ID,
    entry: {
      baseUrl: `${providerBaseUrl("openai-compatible", credential.baseUrl)}/v1`,
      model: credential.model,
      apiKeyEnv: MOSS_OPENCODE_API_KEY_ENV
    }
  };
}

async function readLoginToken(launch: AgentCredentialLaunch): Promise<string | null> {
  try {
    const read = launch.readTokenFile ?? ((path: string) => readFile(path, "utf8"));
    const token = (await read(providerTokenPath(launch.homeBase, "anthropic"))).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Call it from the host**

In `packages/cli-runner/src/acp-host.ts`:

1. Line 14: `import { readFile, rm } from "node:fs/promises";` becomes `import { rm } from "node:fs/promises";`.
2. Delete line 70, `import { providerTokenPath } from "./provider-token-store.js";`.
3. Delete line 79, `import { redactSecrets } from "@moss/ai";`. Its only use is the stderr handler, which `logRedactedStderr` replaces in item 9.
4. Replace Task 7's temporary `import type { RpcAcpSpawnCredential as AcpCredential } from "@moss/chat/live";` with:

```ts
import { applyAgentCredential, type AcpCredential } from "./acp-launch-credential.js";
```

5. Delete Task 7's `void credential;` line at the top of `spawn`.
6. In the `setup` block, replace

```ts
        if (providerKind === "anthropic") {
          const token = await this.readLoginToken(homeBase);
          if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
        }
```

with

```ts
        const opencodeProvider = await applyAgentCredential(env, {
          agentHome,
          homeBase,
          providerKind,
          credential,
          readTokenFile: this.deps.readTokenFile
        });
```

7. Replace `if (denyFile) prepareDirs.push(join(agentHome, ".config", "opencode"));` with

```ts
        if (denyFile || opencodeProvider) prepareDirs.push(join(agentHome, ".config", "opencode"));
```

8. In the `runAgentHomePrepare(...)` call, replace the first argument `{ dirs: prepareDirs, denyFile }` with

```ts
          { dirs: prepareDirs, denyFile, ...(opencodeProvider ? { opencodeProvider } : {}) },
```

9. Replace the whole `child.stderr.on("data", ...)` handler, comment included, with

```ts
      // Adapter diagnostics ride stderr by design (stdout is protocol). Keep the
      // tail in the runner log, truncated and masked across chunk boundaries.
      logRedactedStderr(child.stderr, credential?.apiKey, (text) =>
        console.warn(`[acp-host] ${key} stderr: ${text}`)
      );
```

and add `import { logRedactedStderr } from "./stderr-redactor.js";` with the other local imports.

10. Delete the whole `private async readLoginToken(homeBase: string)` method at the end of the class.

Then run `wc -l packages/cli-runner/src/acp-host.ts`. Expected: about 991, and never over 1000.

The entry gives the model an empty object, so OpenCode 1.18.29 reads its context and output limits as 0 and never compacts on overflow. Moss supplies no limits. Its bounded replay (40 messages, 8000 tokens) starts each fresh session small, and Task 2 Step 6 proved that an overflowing conversation ends in a clean error, not a hang, and that a fresh session recovers. If that proof failed, this task does not start.

- [ ] **Step 5: Run the new tests and the existing host tests**

Run: `pnpm test:unit tests/unit/cli-runner-acp-host-api-key.test.ts`
Expected: PASS.
Run: `pnpm test:unit tests/unit/cli-runner-stderr-redactor.test.ts`
Expected: PASS.
Run: `pnpm test:unit tests/unit/cli-runner-acp-host.test.ts`
Expected: PASS. The "passes the Claude token to Claude alone" test still proves the CLI token path.

- [ ] **Step 6: Removal steps (each protection is observed failing)**

Make each change alone, run the named test's file, see the named test fail, record the failing test name and assertion in the PR body, then undo it.

| Temporary change | Test that must fail |
| --- | --- |
| In `applyAgentCredential`, add `apiKey: credential.apiKey` to the OpenCode `entry` object (cast as needed) | "writes an OpenCode entry with one /v1..." |
| In `acp-host.ts`, build `env` from `...process.env` instead of `...buildSanitizedCliEnv(process.env)` | "keeps server-level key variables away..." |
| In `applyAgentCredential`, read the login token before the `if (credential)` check and always set `CLAUDE_CODE_OAUTH_TOKEN` | "gives the claude agent the row's address..." |
| In `logRedactedStderr`, pass `null` instead of `secret` to `createStreamRedactor` | "masks the key in the adapter's logged error output" and "masks a key split across stderr chunks..." |
| In `push`, return the whole masked text and hold nothing (per-chunk masking) | "masks a key split after its character %i" (every split), "masks a key split across stderr chunks..." |
| In `flush`, return `text` without masking the held tail | "masks a stream that ends after %i characters of the key", "masks a key split across stderr chunks..." (at `fatal: [redacted]`) |
| In `logRedactedStderr`, drop the `stream.on("end", ...)` line | "masks a key split across stderr chunks..." (at `fatal: [redacted]`) |
| In `applyAgentCredential`, return `undefined` for OpenCode when there is no credential | "removes the OpenCode entry on every CLI-login OpenCode spawn..." |

To prove the key never reaches the command line, temporarily change `args: target.args` in the `spawnChild({...})` call to `args: [...target.args, credential?.apiKey ?? ""]`. The first test must fail. Undo it.

- [ ] **Step 7: Commit**

```bash
git add packages/cli-runner/src/acp-launch-credential.ts packages/cli-runner/src/acp-host.ts \
  packages/cli-runner/src/stderr-redactor.ts tests/unit/cli-runner-acp-host-api-key.test.ts \
  tests/unit/cli-runner-stderr-redactor.test.ts
git commit -m "feat(cli-runner): launch chat agents with an API-key credential (#3410)"
```

### Task 10: The chat engine routes API-key rows, names a rejected key and masks launch errors

**Files:**
- Modify: `packages/chat/src/live/auth-errors.ts`
- Modify: `packages/chat/src/live/acp-chat-engine.ts` (options at `:32-44`, `toAcpProviderKind` at `:47-60`, constructor default at `:433`, launch catch at `:607-612`, prompt catch at `:661-666`, `RpcAcpTunnel` at `:723-745`, `isAuthRequired` at `:782`)
- Modify: `packages/chat/src/live/runtime.ts` (`ChatEngineFactory` opts at `:143-161`, the two non-ACP factories at `:236` and `:309`, the ACP factory at `:416-421`)
- Test: `packages/chat/src/live/acp-chat-engine.test.ts`, `tests/unit/chat-runtime-selection.test.ts`, `tests/unit/chat-auth-remediation-routes.test.ts`

**Interfaces:**
- Consumes: `RpcAcpSpawnCredential` (Task 7).
- Produces:
  - `API_KEY_REJECTED_MESSAGE = "The provider rejected the API key. An admin can check it under Settings, AI providers."` and `API_KEY_UNREADABLE_MESSAGE = "The API key for this provider could not be read. An admin can enter it again under Settings, AI providers."`, both in `auth-errors.ts` and both allowed through `knownAuthFailureMessage`, so the live route shows them with a 503.
  - `toAcpProviderKind(provider: ProviderKind, acpAgentId?: string, authMethod?: AiAuthMethod): AcpProviderKind`. For `api_key`, `anthropic` gives `"anthropic"`, `openai-compatible` gives `"opencode"`, anything else throws `CliChatUnavailableError`.
  - `AcpChatEngineOptions.authMethod?: AiAuthMethod`
  - `AcpChatEngineOptions.apiKey?: string`, used only to mask launch error text
  - `new RpcAcpTunnel(connection, sessionKey, { useCandidate?, credential?: RpcAcpSpawnCredential })`
  - `ChatEngineFactory` opts gain `authMethod?: AiAuthMethod` and `credential?: RpcAcpSpawnCredential`. Only the ACP chat factory accepts `authMethod: "api_key"`; the other two refuse it.

An API-key auth failure carries no `cause`. The cause holds the agent's own error text, which can echo request details, and the live route logs causes.

Any other launch failure on an API-key row is rethrown with only its message, the key and token patterns masked, and no cause or protocol data. A Moss-made `CliChatUnavailableError` passes unchanged, and an `AcpSessionOpenError` is rebuilt with masked messages so its cleanup retry still works. Prompt failures need no change: `normalizeAcpPromptFailure` already drops provider text and causes.

- [ ] **Step 1: Write the failing engine tests**

In `packages/chat/src/live/acp-chat-engine.test.ts`, extend the `./acp-chat-engine.js` import with `RpcAcpTunnel`, and add:

```ts
import { API_KEY_REJECTED_MESSAGE } from "./auth-errors.js";
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import { CliChatUnavailableError } from "./errors.js";
```

Give `PromptErrorTunnel` a third constructor parameter for the `session/new` failure, defaulting to today's value, and use it in the `session/new` branch (`error: this.sessionNewError` in place of the literal):

```ts
    private readonly sessionNewError: { code: number; message: string; data?: unknown } = {
      code: -32000,
      message: "Authentication required"
    }
```

Append at the end of the file:

```ts
describe("API-key chat", () => {
  const launchOpts = { neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" };

  it("routes API-key rows by provider kind alone", () => {
    expect(toAcpProviderKind("anthropic", undefined, "api_key")).toBe("anthropic");
    expect(toAcpProviderKind("openai-compatible", undefined, "api_key")).toBe("opencode");
    expect(toAcpProviderKind("openai-compatible", "codex-acp", "api_key")).toBe("opencode");
    expect(toAcpProviderKind("openai-compatible", undefined, "cli")).toBe("openai");
    expect(() => toAcpProviderKind("google", undefined, "api_key")).toThrow(
      CliChatUnavailableError
    );
  });

  it("names the key, not a CLI sign-in, when the provider refuses a prompt", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-prompt", {
      tunnel: new PromptErrorTunnel(),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-prompt",
      reportLoginRejected: loginRejected
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failure = await engine.readNew(0).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CliChatUnavailableError",
      message: API_KEY_REJECTED_MESSAGE
    });
    expect(failure).not.toHaveProperty("cause");
    expect(loginRejected).not.toHaveBeenCalled();
    await engine.kill();
  });

  it("names the key when an OpenCode API-key launch is refused", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:api-key-launch", {
      tunnel: new PromptErrorTunnel(true),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-launch",
      reportLoginRejected: loginRejected
    });
    const failure = await engine.launch(launchOpts).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CliChatUnavailableError",
      message: API_KEY_REJECTED_MESSAGE
    });
    expect(failure).not.toHaveProperty("cause");
    expect(loginRejected).not.toHaveBeenCalled();
  });

  it("treats a provider 401 during an API-key prompt as a rejected key", async () => {
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:api-key-401", {
      tunnel: new PromptErrorTunnel(false, { code: -32603, message: "Upstream 401: invalid api key" }),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-401"
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(engine.readNew(0)).rejects.toMatchObject({ message: API_KEY_REJECTED_MESSAGE });
    await engine.kill();
  });

  it("sends the credential with the spawn request, and only when one is given", async () => {
    const acpSpawn = vi.fn(async () => ({ cwd: "/tmp/acp", home: "/tmp/home", pid: 1, uid: 1, gid: 1 }));
    const connection = { acpSpawn } as unknown as RpcConnection;
    const credential = { baseUrl: null, apiKey: "sk-test-never-echo-0002", model: "org/model" };
    await new RpcAcpTunnel(connection, "chat:u1:a", { credential }).spawn(
      "chat:u1:a",
      "a",
      "anthropic",
      "u1",
      "chat"
    );
    await new RpcAcpTunnel(connection, "chat:u1:b").spawn("chat:u1:b", "b", "anthropic", "u1", "chat");
    expect(acpSpawn.mock.calls[0]?.[1]).toEqual({
      projectId: "a",
      providerKind: "anthropic",
      userId: "u1",
      profile: "chat",
      credential
    });
    expect(acpSpawn.mock.calls[1]?.[1]).not.toHaveProperty("credential");
  });

  // No "sk-" prefix, so the generic secret patterns cannot hide a missing exact mask.
  const LAUNCH_KEY = "localproxy0005neverlog";

  it.each([
    ["at the start", `${LAUNCH_KEY} rejected by upstream`],
    ["in the middle", `upstream said ${LAUNCH_KEY} is over quota`],
    ["at the end", `quota exceeded for ${LAUNCH_KEY}`],
    ["repeated", `${LAUNCH_KEY}/${LAUNCH_KEY} twice`]
  ])("masks the key %s of a non-auth API-key launch error", async (_label, message) => {
    const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-mask", {
      tunnel: new PromptErrorTunnel(true, undefined, {
        code: -32603,
        message,
        data: { echo: LAUNCH_KEY }
      }),
      authMethod: "api_key",
      apiKey: LAUNCH_KEY,
      userId: "u1",
      projectId: "api-key-mask"
    });
    const failure = await engine.launch(launchOpts).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[redacted]");
    expect((failure as Error).message).not.toContain(LAUNCH_KEY);
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(LAUNCH_KEY);
  });
});
```

(Prettier may rewrap long lines; run `pnpm exec prettier --write` on the file before committing.)

- [ ] **Step 2: Write the failing factory and route tests**

In `tests/unit/chat-runtime-selection.test.ts`, inside the `selectEngineFactory` describe block, add:

```ts
  it("refuses API-key rows outside the ACP chat path", async () => {
    const inProcess = selectEngineFactory({ env: {} as NodeJS.ProcessEnv });
    await expect(
      Promise.resolve().then(() => inProcess.factory("anthropic", "user-a", { authMethod: "api_key" }))
    ).rejects.toBeInstanceOf(CliChatUnavailableError);

    const rpc = selectEngineFactory({
      env: {
        JARVIS_CLI_RUNNER_SOCKET: SOCKET,
        JARVIS_CLI_RUNNER_RPC_SECRET: "boot-secret"
      } as NodeJS.ProcessEnv
    });
    try {
      await expect(
        Promise.resolve().then(() => rpc.factory("anthropic", "user-a", { authMethod: "api_key" }))
      ).rejects.toBeInstanceOf(CliChatUnavailableError);
    } finally {
      rpc.connection?.close();
    }
  });
```

In `tests/unit/chat-auth-remediation-routes.test.ts`, extend the `auth-errors.js` import with `API_KEY_REJECTED_MESSAGE` and `API_KEY_UNREADABLE_MESSAGE`, and change line 25 to:

```ts
const AUTH_MESSAGES = [
  CODEX_SIGN_IN_REQUIRED_MESSAGE,
  CLAUDE_SIGN_IN_EXPIRED_MESSAGE,
  API_KEY_REJECTED_MESSAGE,
  API_KEY_UNREADABLE_MESSAGE
] as const;
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm test:unit packages/chat/src/live/acp-chat-engine.test.ts`
Expected: FAIL to compile or run, because `authMethod`, `apiKey` and `credential` are unknown options and the messages do not exist.
Run: `pnpm test:unit tests/unit/chat-runtime-selection.test.ts`
Expected: FAIL on "refuses API-key rows outside the ACP chat path".
Run: `pnpm test:unit tests/unit/chat-auth-remediation-routes.test.ts`
Expected: FAIL, the new imports are missing.

- [ ] **Step 4: Add the messages**

In `packages/chat/src/live/auth-errors.ts`, after `CODEX_SIGN_IN_REQUIRED_MESSAGE`:

```ts
export const API_KEY_REJECTED_MESSAGE =
  "The provider rejected the API key. An admin can check it under Settings, AI providers.";

export const API_KEY_UNREADABLE_MESSAGE =
  "The API key for this provider could not be read. An admin can enter it again under Settings, AI providers.";
```

and change the set to:

```ts
const AUTH_FAILURE_MESSAGES = new Set([
  CODEX_SIGN_IN_REQUIRED_MESSAGE,
  API_KEY_REJECTED_MESSAGE,
  API_KEY_UNREADABLE_MESSAGE,
  ...Object.values(SIGN_IN_EXPIRED_MESSAGES)
]);
```

- [ ] **Step 5: Route and classify in the engine**

In `packages/chat/src/live/acp-chat-engine.ts`:

1. Line 15 becomes `import type { AiAuthMethod, ChatTurnUsageDto } from "@moss/shared";`.
2. Line 19 becomes `import { API_KEY_REJECTED_MESSAGE, authFailureMessage } from "./auth-errors.js";`.
3. Line 26 becomes `import type { RpcAcpKillParams, RpcAcpSpawnCredential, RpcAcpSpawnParams } from "./rpc-contract.js";`.
4. In `AcpChatEngineOptions`, after `acpAgentId?`, add:

```ts
  /** API-key rows run with the row's key; their auth failures never touch CLI login state. */
  readonly authMethod?: AiAuthMethod;
  /** The API-key row's key, used only to mask launch error text. */
  readonly apiKey?: string;
```

5. Replace `toAcpProviderKind` with:

```ts
const INCOMPATIBLE_AGENT_MESSAGE = "The selected ACP agent is not compatible with this provider.";

/** API-key rows carry no agent id; the provider kind alone picks the agent. */
const API_KEY_AGENTS: Partial<Record<ProviderKind, AcpProviderKind>> = {
  anthropic: "anthropic",
  "openai-compatible": "opencode"
};

/** ACP's provider names and Moss's configured provider names are deliberately different. */
export function toAcpProviderKind(
  provider: ProviderKind,
  acpAgentId?: string,
  authMethod?: AiAuthMethod
): AcpProviderKind {
  if (authMethod === "api_key") {
    const kind = API_KEY_AGENTS[provider];
    if (!kind) throw new CliChatUnavailableError(INCOMPATIBLE_AGENT_MESSAGE);
    return kind;
  }
  if (provider === "openai-compatible") {
    if (acpAgentId === undefined || acpAgentId === "codex-acp") return "openai";
    if (acpAgentId === "opencode") return "opencode";
  }
  if (provider === "anthropic" && (acpAgentId === undefined || acpAgentId === "claude-acp")) {
    return "anthropic";
  }
  if (provider === "google" && (acpAgentId === undefined || acpAgentId === "antigravity-acp")) {
    return "google";
  }
  throw new CliChatUnavailableError(INCOMPATIBLE_AGENT_MESSAGE);
}
```

6. Every other call of `toAcpProviderKind(this.provider, ...)` in the file (the constructor default `reportLoginRejected`, `launch`, the prompt catch) passes `this.opts.authMethod` (or `opts.authMethod` in the constructor) as the third argument.

7. Add this private method next to `wrapPermissionDecider`:

```ts
  private isAuthFailure(error: unknown): boolean {
    if (isAuthRequired(error)) return true;
    return this.opts.authMethod === "api_key" && isApiKeyRejected(error);
  }

  /** A rejected API key names the key and records no CLI login rejection. */
  private authFailure(kind: AcpProviderKind, error: unknown): CliChatUnavailableError {
    if (this.opts.authMethod === "api_key") {
      return new CliChatUnavailableError(API_KEY_REJECTED_MESSAGE);
    }
    this.reportLoginRejected();
    return new CliChatUnavailableError(authFailureMessage(kind), { cause: error });
  }
```

8. In `launch`'s catch, replace the `isAuthRequired` block with:

```ts
      if (this.isAuthFailure(error)) {
        const failure = this.authFailure(kind, error);
        await this.closeQuietly();
        throw failure;
      }
```

   At the end of the same catch, replace `await this.closeQuietly(); throw error;` with:

```ts
      await this.closeQuietly();
      throw this.opts.authMethod === "api_key" ? maskedLaunchError(error, this.opts.apiKey) : error;
```

   Line 14 becomes `import { type ProviderKind, redactExact, redactSecrets } from "@moss/ai";`, and add `AcpSessionOpenError` to the `@moss/acp` import at lines 2-13. Add at the end of the file:

```ts
/**
 * An API-key launch failure keeps only its message, with the key and token patterns masked.
 * Causes and protocol data are dropped because the agent's error text can echo the request.
 */
function maskedLaunchError(error: unknown, apiKey: string | undefined): unknown {
  if (error instanceof CliChatUnavailableError) return error;
  const mask = (value: unknown) =>
    redactSecrets(redactExact(value instanceof Error ? value.message : String(value), apiKey));
  if (error instanceof AcpSessionOpenError) {
    return new AcpSessionOpenError(
      new Error(mask(error.startupError)),
      new Error(mask(error.cleanupError)),
      error.cleanup
    );
  }
  const masked = new Error(mask(error));
  if (error instanceof Error) masked.name = error.name;
  return masked;
}
```

9. In the prompt `.catch`, replace the `isAuthRequired` block with:

```ts
        if (this.isAuthFailure(error)) {
          this.promptError = this.authFailure(
            toAcpProviderKind(this.provider, this.opts.acpAgentId, this.opts.authMethod),
            error
          );
        } else if (isCliVersionTooOldError(error)) {
```

10. After `isAuthRequired` at the end of the file, add:

```ts
/** Provider wording for a refused key; applied only to API-key rows. */
function isApiKeyRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid[_ ]?api[_ ]?key|\b401\b|unauthori[sz]ed|authentication_error/i.test(message);
}
```

If Task 3 recorded a wrong-key error whose text matches neither `isAuthRequired` nor this pattern, add one more case to the "treats a provider 401..." test with that text (any key removed) and widen the pattern to match it.

11. Change `RpcAcpTunnel`:

```ts
export class RpcAcpTunnel implements AcpTunnel {
  constructor(
    private readonly connection: RpcConnection,
    _sessionKey: string,
    private readonly options: {
      readonly useCandidate?: boolean;
      readonly credential?: RpcAcpSpawnCredential;
    } = {}
  ) {}

  async spawn(
    sessionKey: string,
    projectId: string,
    providerKind: AcpProviderKind,
    userId: string,
    profile: "chat" | "workshop"
  ) {
    const params: RpcAcpSpawnParams = {
      projectId,
      providerKind,
      userId,
      profile,
      ...(this.options.useCandidate ? { useCandidate: true } : {}),
      ...(this.options.credential ? { credential: this.options.credential } : {})
    };
    return this.connection.acpSpawn(sessionKey, params);
  }
```

- [ ] **Step 6: Pass the auth method and credential through the runtime**

In `packages/chat/src/live/runtime.ts`:

1. Line 58 becomes `import type { PersistentRuntimeLaunchConfig, RpcAcpSpawnCredential } from "./rpc-contract.js";`. Add `AiAuthMethod` to the `@moss/shared` import that ends at line 39 (as `type AiAuthMethod` if that import is not type-only).
2. In the `ChatEngineFactory` opts, after `acpModel?`, add:

```ts
    /** API-key rows run only through the ACP chat factory. */
    readonly authMethod?: AiAuthMethod;
    /** The row's decrypted key, address and model; set only for API-key rows. */
    readonly credential?: RpcAcpSpawnCredential;
```

3. In both non-ACP factories (the `return async (provider, sessionKey, engineOpts) => {` at `:235` and `const factory: ChatEngineFactory = ...` at `:308`), right after the OpenCode refusal add:

```ts
    if (engineOpts?.authMethod === "api_key") {
      throw new CliChatUnavailableError("API-key chat requires an ACP chat session.");
    }
```

4. In the ACP chat factory, change the engine options to:

```ts
          return new AcpChatEngine(provider, acpSessionKey, {
            tunnel: new RpcAcpTunnel(
              connection,
              acpSessionKey,
              engineOpts.credential ? { credential: engineOpts.credential } : {}
            ),
            acpAgentId: engineOpts.acpAgentId ?? undefined,
            ...(engineOpts.authMethod ? { authMethod: engineOpts.authMethod } : {}),
            ...(engineOpts.credential ? { apiKey: engineOpts.credential.apiKey } : {}),
```

Leave the rest of that object as it is. Run `wc -l packages/chat/src/live/runtime.ts` (must stay at or under 1000; expected about 965).

- [ ] **Step 7: Run the tests and watch them pass**

Run: `pnpm test:unit packages/chat/src/live/acp-chat-engine.test.ts`
Run: `pnpm test:unit tests/unit/chat-runtime-selection.test.ts`
Run: `pnpm test:unit tests/unit/chat-auth-remediation-routes.test.ts`
Expected: PASS for all three.

- [ ] **Step 8: Removal steps (a rejected key never marks a CLI login rejected; launch errors hold no key)**

Temporarily delete the `if (this.opts.authMethod === "api_key") { ... }` block in `authFailure`.
Run: `pnpm test:unit packages/chat/src/live/acp-chat-engine.test.ts`
Expected: FAIL on "names the key, not a CLI sign-in..." (`loginRejected` called, wrong message) and on "names the key when an OpenCode API-key launch is refused". Record the failures in the PR body. Restore the block and run again: PASS.

Then temporarily change the launch catch's last line back to `throw error;`.
Run: `pnpm test:unit packages/chat/src/live/acp-chat-engine.test.ts`
Expected: FAIL on all four "masks the key ... of a non-auth API-key launch error" cases, at `not.toContain(LAUNCH_KEY)`. Record the failure in the PR body, restore the line, and run again: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/chat/src/live/auth-errors.ts packages/chat/src/live/acp-chat-engine.ts \
  packages/chat/src/live/acp-chat-engine.test.ts packages/chat/src/live/runtime.ts \
  tests/unit/chat-runtime-selection.test.ts tests/unit/chat-auth-remediation-routes.test.ts
git commit -m "feat(chat): route API-key rows to their agent and name a rejected key (#3410)"
```

### Task 11: Chat persistence decrypts the row's key, stamps a launch revision and picks the OpenCode model value

**Files:**
- Create: `packages/chat/src/live/api-key-launch.ts`
- Modify: `packages/chat/src/live/persistence.ts` (import at `:11`, deps at `:71-85`, constructor at `:165-174`, `resolveActiveProvider` at `:176-213`)
- Modify: `packages/chat/src/live/chat-session-ports.ts:39-50` (`ChatPersistencePort`)
- Modify: `packages/chat/src/live/runtime.ts:13-19` (import) and `:645-654` (persistence wiring)
- Test: `tests/unit/chat-api-key-launch.test.ts` (create)

**Interfaces:**
- Consumes: `MOSS_OPENCODE_PROVIDER_ID` (Task 8).
- Produces:
  - `interface ChatCredential { readonly apiKey: string; readonly baseUrl: string | null; readonly revision: string }`
  - `providerLaunchRevision(row: Pick<AiProviderWithSealedCredential, "provider_kind" | "base_url" | "encrypted_credential">): string`, the sha256 hex of `JSON.stringify([provider_kind, base_url ?? null, encrypted_credential])`. It hashes ciphertext only, so it holds no key material. It changes when a new key is saved (new ciphertext) or the address or kind changes, and not when only the status or default flag changes.
  - `resolveActiveProvider` adds `providerConfigRevision?: string` for API-key rows, read in the same data-context run as the model. CLI rows carry none. Task 12 compares it.
  - `chatAcpModel(row: ChatModelRow, savedOpenCodeModel: string | null | undefined): string | undefined`. An API-key OpenAI-compatible row gives `"moss/<row model id>"`; other API-key rows give `undefined`; CLI OpenCode rows keep the saved choice.
  - `openChatCredential(row, cipher): ChatCredential | null`. It returns `null` for a missing row or cipher, a non-API-key row, a row that is not active, a revoked row, a row with no stored key, or any failure to decrypt or parse.
  - `DataContextChatPersistence.resolveChatCredential(actorUserId: string, providerConfigId: string): Promise<ChatCredential | null>`
  - `ChatPersistencePort.resolveChatCredential?(actorUserId: string, providerConfigId: string): Promise<ChatCredential | null>`
  - `DataContextChatPersistenceDeps.resolveAiSecretCipher?: () => AiSecretCipher`

Meeting chat already decrypts provider keys inside the user's data context (`packages/chat/src/live/meeting-chat-runtime.ts:73`); this follows the same path.

The provider row's `updated_at` is not the revision. `updateProvider` sets it on every save, including a status-only save and a default toggle, so it would drop live chats for changes that do not touch the key or address.

- [ ] **Step 1: Write the failing tests**

`tests/unit/chat-api-key-launch.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiRepository,
  createAiSecretCipher,
  type AiConfiguredModelSafeRow,
  type AiProviderWithSealedCredential
} from "@moss/ai";
import { DataContextRunner } from "@moss/db";

import {
  chatAcpModel,
  openChatCredential,
  providerLaunchRevision
} from "../../packages/chat/src/live/api-key-launch.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const KEY = "sk-test-never-echo-0003";
const cipher = createAiSecretCipher();

function sealed(overrides: Partial<AiProviderWithSealedCredential> = {}) {
  return {
    provider_kind: "openai-compatible",
    auth_method: "api_key",
    status: "active",
    revoked_at: null,
    has_credential: true,
    base_url: "http://proxy.test",
    encrypted_credential: cipher.encryptJson({ apiKey: ` ${KEY} ` }),
    ...overrides
  } as AiProviderWithSealedCredential;
}

const apiKeyRow = {
  provider_kind: "openai-compatible",
  provider_auth_method: "api_key",
  provider_acp_agent_id: null,
  provider_model_id: "org/model:tag@v2"
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chatAcpModel", () => {
  it("prefixes an API-key OpenAI-compatible model with the Moss provider id", () => {
    expect(chatAcpModel(apiKeyRow, "muse-spark-1.3-free")).toBe("moss/org/model:tag@v2");
  });

  it("leaves Anthropic API-key rows to the row model", () => {
    expect(chatAcpModel({ ...apiKeyRow, provider_kind: "anthropic" }, undefined)).toBeUndefined();
  });

  it("keeps the saved choice for CLI OpenCode rows only", () => {
    const cliOpencode = { ...apiKeyRow, provider_auth_method: "cli", provider_acp_agent_id: "opencode" } as const;
    expect(chatAcpModel(cliOpencode, "muse-spark-1.3-free")).toBe("muse-spark-1.3-free");
    expect(chatAcpModel(cliOpencode, undefined)).toBeUndefined();
    expect(chatAcpModel({ ...cliOpencode, provider_acp_agent_id: "codex-acp" }, "default")).toBeUndefined();
  });
});

describe("openChatCredential", () => {
  it("returns the trimmed key, the row's address and the row's launch revision", () => {
    const row = sealed();
    expect(openChatCredential(row, cipher)).toEqual({
      apiKey: KEY,
      baseUrl: "http://proxy.test",
      revision: providerLaunchRevision(row)
    });
  });

  it.each([
    ["no row", undefined],
    ["a CLI row", sealed({ auth_method: "cli" })],
    ["a disabled row", sealed({ status: "disabled" })],
    ["a revoked row", sealed({ revoked_at: new Date("2026-10-01") })],
    ["no stored key", sealed({ has_credential: false })],
    ["an empty key", sealed({ encrypted_credential: cipher.encryptJson({ apiKey: "  " }) })]
  ])("returns null for %s", (_label, row) => {
    expect(openChatCredential(row, cipher)).toBeNull();
  });

  it("returns null, and throws nothing, when the key cannot be decrypted", () => {
    const broken = {
      decryptJson: () => {
        throw new Error(`bad tag near ${KEY}`);
      }
    };
    expect(openChatCredential(sealed(), broken)).toBeNull();
    expect(openChatCredential(sealed(), undefined)).toBeNull();
  });
});

describe("providerLaunchRevision", () => {
  const row = sealed();

  it("is a key-free hash that is stable for the same stored row", () => {
    const revision = providerLaunchRevision(row);
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(revision).not.toContain(KEY);
    expect(providerLaunchRevision({ ...row })).toBe(revision);
  });

  it("changes when the same row gets a new key", () => {
    const rotated = sealed({
      encrypted_credential: cipher.encryptJson({ apiKey: "sk-test-never-echo-0004" })
    });
    expect(providerLaunchRevision(rotated)).not.toBe(providerLaunchRevision(row));
  });

  it("changes when the same row gets a new address", () => {
    const moved = { ...row, base_url: "http://proxy.test/other" };
    expect(providerLaunchRevision(moved)).not.toBe(providerLaunchRevision(row));
  });
});

describe("DataContextChatPersistence API-key launch", () => {
  function fixture(cipherFactory?: () => ReturnType<typeof createAiSecretCipher>) {
    const { scoped } = makeRecordingDb();
    const dataContext = Object.create(DataContextRunner.prototype) as DataContextRunner;
    vi.spyOn(dataContext, "withDataContext").mockImplementation((_access, work) => work(scoped));
    const ai = Object.create(AiRepository.prototype) as AiRepository;
    const persistence = new DataContextChatPersistence({
      dataContext,
      chatRepository: new ChatRepository(),
      aiRepository: ai,
      ...(cipherFactory ? { resolveAiSecretCipher: cipherFactory } : {})
    });
    return { persistence, ai };
  }

  it("decrypts the selected row's key inside the user's data context", async () => {
    const { persistence, ai } = fixture(() => cipher);
    const select = vi.spyOn(ai, "selectProviderWithCredential").mockResolvedValue(sealed());
    await expect(persistence.resolveChatCredential("user-1", "provider-1")).resolves.toEqual({
      apiKey: KEY,
      baseUrl: "http://proxy.test",
      revision: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(select).toHaveBeenCalledWith(expect.anything(), "provider-1");
  });

  it("returns null when the server cannot build a cipher", async () => {
    const { persistence, ai } = fixture(() => {
      throw new Error("JARVIS_AI_SECRET_KEY is required");
    });
    const select = vi.spyOn(ai, "selectProviderWithCredential").mockResolvedValue(sealed());
    await expect(persistence.resolveChatCredential("user-1", "provider-1")).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("gives an API-key OpenAI-compatible row the Moss OpenCode model value and a revision", async () => {
    const { persistence, ai } = fixture(() => cipher);
    const row = sealed();
    vi.spyOn(ai, "selectChatModelForUser").mockResolvedValue({
      ...apiKeyRow,
      provider_config_id: "provider-1"
    } as unknown as AiConfiguredModelSafeRow);
    const select = vi.spyOn(ai, "selectProviderWithCredential").mockResolvedValue(row);
    await expect(persistence.resolveActiveProvider("user-1")).resolves.toMatchObject({
      provider: "openai-compatible",
      model: "org/model:tag@v2",
      authMethod: "api_key",
      acpModel: "moss/org/model:tag@v2",
      providerConfigRevision: providerLaunchRevision(row)
    });
    expect(select).toHaveBeenCalledWith(expect.anything(), "provider-1");
  });

  it("gives a CLI row no revision and reads no sealed credential", async () => {
    const { persistence, ai } = fixture(() => cipher);
    vi.spyOn(ai, "selectChatModelForUser").mockResolvedValue({
      ...apiKeyRow,
      provider_auth_method: "cli",
      provider_acp_agent_id: "opencode",
      provider_config_id: "provider-2"
    } as unknown as AiConfiguredModelSafeRow);
    const select = vi.spyOn(ai, "selectProviderWithCredential");
    const active = await persistence.resolveActiveProvider("user-1");
    expect(active).not.toHaveProperty("providerConfigRevision");
    expect(select).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit tests/unit/chat-api-key-launch.test.ts`
Expected: FAIL, `api-key-launch.js` does not exist.

- [ ] **Step 3: Write the helper**

`packages/chat/src/live/api-key-launch.ts`:

```ts
/**
 * Launch values for API-key chat rows. A failure to read the stored key becomes `null`,
 * never an error, so no decryption text can carry key material into a log.
 */
import { createHash } from "node:crypto";

import { MOSS_OPENCODE_PROVIDER_ID } from "@moss/acp";
import {
  parseAiApiKeyCredential,
  type AiProviderWithSealedCredential,
  type AiSecretCipher
} from "@moss/ai";
import type { AiAuthMethod } from "@moss/shared";

export interface ChatCredential {
  readonly apiKey: string;
  readonly baseUrl: string | null;
  /** `providerLaunchRevision` of the row the key was read from. */
  readonly revision: string;
}

export interface ChatModelRow {
  readonly provider_kind: string;
  readonly provider_auth_method: AiAuthMethod;
  readonly provider_acp_agent_id: string | null;
  readonly provider_model_id: string;
}

type SealedChatProvider = Pick<
  AiProviderWithSealedCredential,
  | "provider_kind"
  | "auth_method"
  | "status"
  | "revoked_at"
  | "has_credential"
  | "base_url"
  | "encrypted_credential"
>;

/**
 * Non-secret identity of what a launch connects to. Hashes the kind, address and sealed
 * credential (ciphertext, never the key), so saving a new key or address changes it.
 */
export function providerLaunchRevision(
  row: Pick<AiProviderWithSealedCredential, "provider_kind" | "base_url" | "encrypted_credential">
): string {
  return createHash("sha256")
    .update(JSON.stringify([row.provider_kind, row.base_url ?? null, row.encrypted_credential]))
    .digest("hex");
}

/** The ACP model value for a live launch; `undefined` lets the engine use the row model. */
export function chatAcpModel(
  row: ChatModelRow,
  savedOpenCodeModel: string | null | undefined
): string | undefined {
  if (row.provider_auth_method === "api_key") {
    return row.provider_kind === "openai-compatible"
      ? `${MOSS_OPENCODE_PROVIDER_ID}/${row.provider_model_id}`
      : undefined;
  }
  if (row.provider_acp_agent_id !== "opencode") return undefined;
  return savedOpenCodeModel || undefined;
}

export function openChatCredential(
  row: SealedChatProvider | undefined,
  cipher: Pick<AiSecretCipher, "decryptJson"> | undefined
): ChatCredential | null {
  if (!row || !cipher) return null;
  if (row.auth_method !== "api_key" || row.status !== "active") return null;
  if (row.revoked_at || !row.has_credential) return null;
  try {
    const parsed = parseAiApiKeyCredential(cipher.decryptJson(row.encrypted_credential));
    return parsed
      ? { apiKey: parsed.apiKey, baseUrl: row.base_url, revision: providerLaunchRevision(row) }
      : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Wire persistence, port and runtime**

In `packages/chat/src/live/persistence.ts`:

1. Line 11 becomes:

```ts
import type {
  AiConfiguredModelSafeRow,
  AiRepository,
  AiSecretCipher,
  ProviderKind
} from "@moss/ai";
```

and add next to the other local imports:

```ts
import {
  chatAcpModel,
  openChatCredential,
  providerLaunchRevision,
  type ChatCredential
} from "./api-key-launch.js";
```

2. In `DataContextChatPersistenceDeps`, after `chatPreferences?`, add:

```ts
  /** Builds the cipher that opens API-key provider credentials for chat launches. */
  readonly resolveAiSecretCipher?: () => AiSecretCipher;
```

3. Add the field `private readonly resolveAiSecretCipher: (() => AiSecretCipher) | undefined;` next to the other fields, and `this.resolveAiSecretCipher = deps.resolveAiSecretCipher;` at the end of the constructor.

4. In `resolveActiveProvider`, add `providerConfigRevision?: string;` to the return type after `acpModel?`, and replace the `this.run(...)` block with:

```ts
    const { model, openCodeModel, revision } = await this.run(
      actorUserId,
      "resolve-provider",
      async (scopedDb) => {
        // Sequential: model selection can write through a savepoint.
        const model = await this.ai.selectChatModelForUser(scopedDb);
        const rawChatSettings = await this.chatPreferences?.get(
          scopedDb,
          CHAT_SETTINGS_PREFERENCE_KEY
        );
        const sealed =
          model?.provider_auth_method === "api_key"
            ? await this.ai.selectProviderWithCredential(scopedDb, model.provider_config_id)
            : undefined;
        return {
          model,
          openCodeModel: normalizeChatSettings(rawChatSettings).openCodeModel,
          revision: sealed ? providerLaunchRevision(sealed) : undefined
        };
      }
    );
```

   Then replace the returned object with:

```ts
    const provider = toLiveProvider(model);
    const acpModel = chatAcpModel(model, openCodeModel);
    return {
      provider,
      model: model.provider_model_id,
      providerConfigId: model.provider_config_id,
      authMethod: model.provider_auth_method,
      acpAgentId: model.provider_acp_agent_id,
      ...(acpModel ? { acpModel } : {}),
      ...(revision ? { providerConfigRevision: revision } : {})
    };
  }

  /** The API-key row's key and address, or `null` when they cannot be read. */
  async resolveChatCredential(
    actorUserId: string,
    providerConfigId: string
  ): Promise<ChatCredential | null> {
    let cipher: AiSecretCipher | undefined;
    try {
      cipher = this.resolveAiSecretCipher?.();
    } catch {
      return null;
    }
    if (!cipher) return null;
    const row = await this.run(actorUserId, "resolve-chat-credential", (scopedDb) =>
      this.ai.selectProviderWithCredential(scopedDb, providerConfigId)
    );
    return openChatCredential(row, cipher);
  }
```

In `packages/chat/src/live/chat-session-ports.ts`, add `import type { ChatCredential } from "./api-key-launch.js";` with the other local imports, add `providerConfigRevision?: string;` after `acpModel?: string;` in the `resolveActiveProvider` return type, and inside `ChatPersistencePort`, after `resolveActiveProvider`, add:

```ts
  /** Decrypted key and address of an API-key row; `null` when they cannot be read. */
  resolveChatCredential?(
    actorUserId: string,
    providerConfigId: string
  ): Promise<ChatCredential | null>;
```

In `packages/chat/src/live/runtime.ts`, add `createAiSecretCipher,` to the `@moss/ai` import at `:13-19`, and add `resolveAiSecretCipher: () => createAiSecretCipher(),` to the `new DataContextChatPersistence({ ... })` call at `:645`. The cipher is built per launch, so a missing secret key fails one launch, not server start.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm test:unit tests/unit/chat-api-key-launch.test.ts`
Expected: PASS.
Run: `pnpm test:unit tests/unit/chat-persistence-bound-replay.test.ts`
Expected: PASS (the CLI path is unchanged).

- [ ] **Step 6: Removal steps (a decryption failure never escapes; a new key changes the revision)**

Temporarily replace the `try { ... } catch { return null; }` in `openChatCredential` with its body alone.
Run: `pnpm test:unit tests/unit/chat-api-key-launch.test.ts`
Expected: FAIL on "returns null, and throws nothing, when the key cannot be decrypted", with an error that names the key. Record the failure in the PR body. Restore the `try` and run again: PASS.

Then temporarily drop `row.encrypted_credential` from the array `providerLaunchRevision` hashes.
Run: `pnpm test:unit tests/unit/chat-api-key-launch.test.ts`
Expected: FAIL on "changes when the same row gets a new key". Record it, restore the line, and run again: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/chat/src/live/api-key-launch.ts packages/chat/src/live/persistence.ts \
  packages/chat/src/live/chat-session-ports.ts packages/chat/src/live/runtime.ts \
  tests/unit/chat-api-key-launch.test.ts
git commit -m "feat(chat): read the API-key chat credential inside the user's data context (#3410)"
```

## Phase 3: Open the gates, readiness, docs and the live proof

### Task 12: Chat accepts Anthropic and OpenAI-compatible API-key rows and follows their key and address

**Files:**
- Modify: `packages/chat/src/live/errors.ts:138-146` (replace the old refusal)
- Modify: `packages/chat/src/live/chat-session-provider-identity.ts:1-11` (imports) and `:55-60` (the gate); add `resolveApiKeyLaunchCredential`
- Modify: `packages/chat/src/live/chat-session-launch.ts:11-16`, `:56-57`, `:81-90`
- Modify: `packages/chat/src/live/persistence.ts:55` and `toLiveProvider` at about `:660`
- Modify: `packages/chat/src/live/chat-session-provider-identity.ts:32-44` (`sameActiveChatProvider`) and `:98-113` (`dropSessionsForProvider`)
- Modify: `packages/chat/src/live/chat-session-manager.ts:15`, `:28`, `:313-317` and `:798-806`
- Modify: `packages/chat/src/live-routes.ts:58-59` and `:766-768`
- Modify: `packages/chat/src/routes.ts:206` (one line in place; the file stays at exactly 1000 lines)
- Modify: `packages/ai/src/routes.ts:123` (`AiRoutesDependencies`), `:422-424` (PATCH), `:451` (revoke), and a helper at the end of the file
- Modify: `packages/module-registry/src/index.ts` at `:726` (route deps type), `:2223` (ai route deps), above `registerBuiltInApiRoutes` (`:3559`), `:3607-3609`, `:3854` and `:3865`
- Test: `tests/unit/chat-session-manager-provider-identity.test.ts`, `tests/unit/chat-auth-remediation-routes.test.ts`, `tests/unit/chat-api-key-launch.test.ts`, `tests/unit/chat-session-manager-provider-drop.test.ts`, `tests/unit/ai-provider-config-update-route.test.ts`

**Interfaces:**
- Consumes: `API_KEY_UNREADABLE_MESSAGE` and the factory's `authMethod` and `credential` options (Task 10); `ChatPersistencePort.resolveChatCredential`, `ChatCredential.revision` and `providerConfigRevision` (Task 11).
- Produces:
  - `UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE = "Chat supports API-key providers of type Anthropic or OpenAI-compatible. Choose one of those, or a CLI provider, in Admin > AI providers."` and `class UnsupportedApiKeyChatProviderError extends CliChatUnavailableError` (live route: 400 with that message).
  - `class ApiKeyUnreadableError extends CliChatUnavailableError` with `API_KEY_UNREADABLE_MESSAGE` (live route: 503 with that message, through the existing auth allowlist).
  - `assertLiveChatProvider(provider: ActiveChatProvider): void` replaces `assertLiveCliProvider`.
  - `resolveApiKeyLaunchCredential(actorUserId: string, provider: ActiveChatProvider, persistence: ChatPersistencePort): Promise<RpcAcpSpawnCredential | undefined>`
    It throws `ActiveProviderChangedDuringLaunchError` when the key's `revision` differs from `provider.providerConfigRevision`, so the launch loop re-reads the provider and retries with replay.
  - `sameActiveChatProvider` also compares `providerConfigRevision`. Engine reuse, the pending-turn check and the post-launch check all use it, so a saved key or address on the same row discards the engine and replays into a fresh one.
  - `type ChatSessionDropTarget = ProviderKind | { readonly providerConfigId: string }`; `ChatSessionManager.dropSessionsForProvider(target: ChatSessionDropTarget)`.
  - `AiRoutesDependencies.dropChatSessionsForProviderConfig?: (providerConfigId: string) => Promise<void>`, called best-effort after a PATCH that changes the key, address, kind, auth method or agent, and after revoke.
  - `ApiKeyLiveChatUnavailableError` and `API_KEY_LIVE_CHAT_UNAVAILABLE_MESSAGE` no longer exist.

The key is read before the launch opens or creates a conversation, so an unreadable key leaves no empty conversation behind.

The revision check is the correctness guard: a session launched with an old key never matches the row once a new key is saved, wherever the next check runs. The targeted drop is the prompt path: it kills those sessions as soon as the admin saves, instead of at the user's next turn.

- [ ] **Step 1: Rewrite the manager tests**

In `tests/unit/chat-session-manager-provider-identity.test.ts`, change the errors import to:

```ts
import {
  ApiKeyUnreadableError,
  ChatProviderChangedError,
  UnsupportedApiKeyChatProviderError
} from "../../packages/chat/src/live/errors.js";
import { assertProviderIdentityForPendingTurn } from "../../packages/chat/src/live/chat-session-provider-identity.js";
```

Replace the first test ("rejects API-key live chat before creating or launching an engine") with:

```ts
  const KEY = "sk-test-never-echo-0004";
  const NEW_KEY = "localproxy0006neverlog";
  const apiKeyProvider = {
    provider: "anthropic",
    model: "claude-test-model",
    providerConfigId: "provider-1",
    authMethod: "api_key",
    acpAgentId: null,
    providerConfigRevision: "rev-1"
  } as const;
  type TestCredential = { apiKey: string; baseUrl: string | null; revision: string };

  function apiKeyManager(credential: TestCredential | null) {
    const engine = new FakeEngine(0);
    const engineFactory = vi.fn(() => engine);
    const deps = makeMinimalDeps({ engineFactory });
    const resolveChatCredential = vi.fn().mockResolvedValue(credential);
    const persistence = {
      ...deps.persistence,
      resolveChatCredential,
      getCurrentThreadState: vi.fn().mockResolvedValue(null)
    };
    vi.mocked(persistence.resolveActiveProvider).mockResolvedValue(apiKeyProvider);
    const manager = new ChatSessionManager({ ...deps, persistence });
    return { manager, engine, engineFactory, persistence, resolveChatCredential };
  }

  it("refuses an API-key row whose key cannot be read, before any conversation or engine", async () => {
    const { manager, engineFactory, persistence } = apiKeyManager(null);
    await expect(manager.ensureSession("u1", "Ada")).rejects.toBeInstanceOf(ApiKeyUnreadableError);
    expect(engineFactory).not.toHaveBeenCalled();
    expect(persistence.openNewConversation).not.toHaveBeenCalled();
  });

  it("launches an API-key row with its key, address and model", async () => {
    const { manager, engineFactory, resolveChatCredential } = apiKeyManager({
      apiKey: KEY,
      baseUrl: "http://proxy.test",
      revision: "rev-1"
    });
    await manager.ensureSession("u1", "Ada");
    expect(resolveChatCredential).toHaveBeenCalledWith("u1", "provider-1");
    expect(engineFactory).toHaveBeenCalledWith(
      "anthropic",
      "u1:drawer",
      expect.objectContaining({
        authMethod: "api_key",
        credential: { apiKey: KEY, baseUrl: "http://proxy.test", model: "claude-test-model" }
      })
    );
  });

  it("keeps the key out of logs, stored calls and the agent's input", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    try {
      const { manager, engine, persistence } = apiKeyManager({
        apiKey: KEY,
        baseUrl: null,
        revision: "rev-1"
      });
      await manager.ensureSession("u1", "Ada");
      const storedCalls = Object.entries(persistence)
        .filter(([name]) => name !== "resolveChatCredential")
        .map(([, fn]) => vi.mocked(fn).mock.calls);
      expect(JSON.stringify(logged)).not.toContain(KEY);
      expect(JSON.stringify(storedCalls)).not.toContain(KEY);
      expect(JSON.stringify(engine.submitted)).not.toContain(KEY);
      expect(JSON.stringify(engine.launchOpts)).not.toContain(KEY);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    ["a new key", { apiKey: NEW_KEY, baseUrl: "http://proxy.test" }],
    ["a new address", { apiKey: KEY, baseUrl: "http://proxy.test/other" }]
  ])("discards the engine and relaunches when the same row gets %s", async (_label, next) => {
    const engines: FakeEngine[] = [];
    const engineFactory = vi.fn(() => {
      const engine = new FakeEngine(0);
      engines.push(engine);
      return engine;
    });
    const deps = makeMinimalDeps({ engineFactory });
    let revision = "rev-1";
    let credential: TestCredential = { apiKey: KEY, baseUrl: "http://proxy.test", revision };
    const persistence = {
      ...deps.persistence,
      resolveChatCredential: vi.fn(async () => credential),
      getCurrentThreadState: vi.fn().mockResolvedValue(null)
    };
    vi.mocked(persistence.resolveActiveProvider).mockImplementation(async () => ({
      ...apiKeyProvider,
      providerConfigRevision: revision
    }));
    const manager = new ChatSessionManager({ ...deps, persistence });

    await manager.ensureSession("u1", "Ada");
    revision = "rev-2";
    credential = { ...next, revision };
    await manager.ensureSession("u1", "Ada");

    expect(engines).toHaveLength(2);
    expect(engines[0]?.killed).toBe(true);
    expect(engineFactory).toHaveBeenLastCalledWith(
      "anthropic",
      "u1:drawer",
      expect.objectContaining({ credential: { ...next, model: "claude-test-model" } })
    );
  });

  it("retries with the new row when the key changes between the provider read and the key read", async () => {
    const { manager, engineFactory, persistence, resolveChatCredential } = apiKeyManager(null);
    vi.mocked(persistence.resolveActiveProvider)
      .mockResolvedValueOnce(apiKeyProvider)
      .mockResolvedValue({ ...apiKeyProvider, providerConfigRevision: "rev-2" });
    resolveChatCredential.mockResolvedValue({ apiKey: NEW_KEY, baseUrl: null, revision: "rev-2" });

    await manager.ensureSession("u1", "Ada");

    expect(engineFactory).toHaveBeenCalledTimes(1);
    expect(engineFactory).toHaveBeenCalledWith(
      "anthropic",
      "u1:drawer",
      expect.objectContaining({
        credential: { apiKey: NEW_KEY, baseUrl: null, model: "claude-test-model" }
      })
    );
  });

  it("refuses a pending turn once the row's key or address changed", async () => {
    await expect(
      assertProviderIdentityForPendingTurn(apiKeyProvider, {
        ...apiKeyProvider,
        providerConfigRevision: "rev-2"
      })
    ).rejects.toBeInstanceOf(ChatProviderChangedError);
  });
```

Replace the third test ("evicts a cached CLI engine when the provider changes to API-key auth") with:

```ts
  it("evicts a cached CLI engine when the provider changes to an unsupported API-key kind", async () => {
    const oldEngine = new FakeEngine(0);
    const engineFactory = vi.fn(() => oldEngine);
    const deps = makeMinimalDeps({ engineFactory });
    const cliProvider = {
      provider: "openai-compatible",
      model: "gpt-5.6",
      providerConfigId: "provider-1",
      authMethod: "cli",
      acpAgentId: "codex-acp",
      executionMode: "non_interactive"
    } as const;
    const googleKey = { ...cliProvider, provider: "google", authMethod: "api_key", acpAgentId: null } as const;
    let activeProvider: typeof cliProvider | typeof googleKey = cliProvider;
    vi.mocked(deps.persistence.resolveActiveProvider).mockImplementation(
      async () => activeProvider
    );
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ada");
    activeProvider = googleKey;
    await expect(manager.ensureSession("u1", "Ada")).rejects.toBeInstanceOf(
      UnsupportedApiKeyChatProviderError
    );

    expect(oldEngine.killed).toBe(true);
    expect(engineFactory).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Update the route and persistence tests**

In `tests/unit/chat-auth-remediation-routes.test.ts`, replace `API_KEY_LIVE_CHAT_UNAVAILABLE_MESSAGE` and `ApiKeyLiveChatUnavailableError` in the errors import with `ApiKeyUnreadableError`, `UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE` and `UnsupportedApiKeyChatProviderError`. Change the first row of the 400 `it.each` to:

```ts
    [new UnsupportedApiKeyChatProviderError(), UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE],
```

and add after that `it.each`:

```ts
  it("tells the user an API-key row's key could not be read", async () => {
    const app = buildLiveApp(new ApiKeyUnreadableError());
    apps.push(app);
    await assertSerializedError(
      app,
      { method: "POST", url: "/api/chat/turn", payload: { text: "hello" } },
      503,
      API_KEY_UNREADABLE_MESSAGE
    );
  });
```

In `tests/unit/chat-api-key-launch.test.ts`, add `import { UnsupportedApiKeyChatProviderError } from "../../packages/chat/src/live/errors.js";` and, inside the "DataContextChatPersistence API-key launch" describe, add:

```ts
  it("names the supported API-key kinds when the row has another kind", async () => {
    const { persistence, ai } = fixture(() => cipher);
    vi.spyOn(ai, "selectChatModelForUser").mockResolvedValue({
      ...apiKeyRow,
      provider_kind: "ollama",
      provider_config_id: "provider-1"
    } as unknown as AiConfiguredModelSafeRow);
    await expect(persistence.resolveActiveProvider("user-1")).rejects.toBeInstanceOf(
      UnsupportedApiKeyChatProviderError
    );
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm test:unit tests/unit/chat-session-manager-provider-identity.test.ts`
Run: `pnpm test:unit tests/unit/chat-auth-remediation-routes.test.ts`
Run: `pnpm test:unit tests/unit/chat-api-key-launch.test.ts`
Expected: FAIL, the new error classes do not exist yet, and the relaunch, retry and pending-turn tests fail because the identity ignores `providerConfigRevision`.

- [ ] **Step 4: Replace the errors**

In `packages/chat/src/live/errors.ts`, add `import { API_KEY_UNREADABLE_MESSAGE } from "./auth-errors.js";` under the existing imports, and replace lines 138-146 (the `API_KEY_LIVE_CHAT_UNAVAILABLE_MESSAGE` constant and `ApiKeyLiveChatUnavailableError` class) with:

```ts
export const UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE =
  "Chat supports API-key providers of type Anthropic or OpenAI-compatible. Choose one of those, or a CLI provider, in Admin > AI providers.";

export class UnsupportedApiKeyChatProviderError extends CliChatUnavailableError {
  constructor() {
    super(UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE);
    this.name = "UnsupportedApiKeyChatProviderError";
  }
}

/** The row's stored key could not be read or decrypted; the message names no value. */
export class ApiKeyUnreadableError extends CliChatUnavailableError {
  constructor() {
    super(API_KEY_UNREADABLE_MESSAGE);
    this.name = "ApiKeyUnreadableError";
  }
}
```

- [ ] **Step 5: Open the gate and resolve the credential**

In `packages/chat/src/live/chat-session-provider-identity.ts`, change the errors import to bring in `ApiKeyUnreadableError`, `ChatProviderChangedError`, `CliChatUnavailableError`, `UnsupportedApiKeyChatProviderError` and `UnsupportedLegacyCliProviderError`, add `import type { RpcAcpSpawnCredential } from "./rpc-contract.js";`, and replace `assertLiveCliProvider` with:

```ts
/** Kinds whose API-key rows have an agent: the claude agent and OpenCode. */
const API_KEY_CHAT_KINDS: readonly ProviderKind[] = ["anthropic", "openai-compatible"];

export function assertLiveChatProvider(provider: ActiveChatProvider): void {
  if (provider.authMethod === "api_key") {
    if (!API_KEY_CHAT_KINDS.includes(provider.provider)) {
      throw new UnsupportedApiKeyChatProviderError();
    }
    return;
  }
  if (provider.authMethod === "cli" && !provider.acpAgentId) {
    throw new UnsupportedLegacyCliProviderError();
  }
}

/** The credential an API-key launch sends to the runner; `undefined` for CLI rows. */
export async function resolveApiKeyLaunchCredential(
  actorUserId: string,
  provider: ActiveChatProvider,
  persistence: ChatPersistencePort
): Promise<RpcAcpSpawnCredential | undefined> {
  if (provider.authMethod !== "api_key") return undefined;
  const opened = provider.providerConfigId
    ? await persistence.resolveChatCredential?.(actorUserId, provider.providerConfigId)
    : null;
  if (!opened) throw new ApiKeyUnreadableError();
  // The key must come from the row revision this launch's identity names.
  if (opened.revision !== provider.providerConfigRevision) {
    throw new ActiveProviderChangedDuringLaunchError();
  }
  return { apiKey: opened.apiKey, baseUrl: opened.baseUrl, model: provider.model };
}
```

In the same file, in `sameActiveChatProvider`, replace the last compared line, `left.acpModel === right.acpModel`, with:

```ts
    left.acpModel === right.acpModel &&
    left.providerConfigRevision === right.providerConfigRevision
```

If `CliChatUnavailableError` is no longer used in the file after this change, drop it from the import.

In `packages/chat/src/live/chat-session-launch.ts`:

1. In the identity import, replace `assertLiveCliProvider,` with `assertLiveChatProvider,` and add `resolveApiKeyLaunchCredential,`.
2. Replace line 57, `assertLiveCliProvider(providerIdentity);`, with:

```ts
  assertLiveChatProvider(providerIdentity);
  const credential = await resolveApiKeyLaunchCredential(
    actorUserId,
    providerIdentity,
    deps.persistence
  );
```

3. In the `deps.engineFactory(provider, sessionKey, { ... })` call, after `acpAgentId,` add:

```ts
    ...(providerIdentity.authMethod ? { authMethod: providerIdentity.authMethod } : {}),
    ...(credential ? { credential } : {}),
```

In `packages/chat/src/live/persistence.ts`, change line 55 to `import { UnsupportedApiKeyChatProviderError, UnsupportedLegacyCliProviderError } from "./errors.js";`, and in `toLiveProvider` add, before the legacy CLI check:

```ts
  if (model.provider_auth_method === "api_key") throw new UnsupportedApiKeyChatProviderError();
```

In `packages/chat/src/live/chat-session-manager.ts`, in the errors import replace `ApiKeyLiveChatUnavailableError,` with `ApiKeyUnreadableError,` and `UnsupportedApiKeyChatProviderError,`. In the retry guard at `:313-317`, replace `err instanceof ApiKeyLiveChatUnavailableError ||` with:

```ts
          err instanceof ApiKeyUnreadableError ||
          err instanceof UnsupportedApiKeyChatProviderError ||
```

Run `wc -l packages/chat/src/live/chat-session-manager.ts` (must stay at or under 1000; expected about 980).

In `packages/chat/src/live-routes.ts`, in the errors import replace `API_KEY_LIVE_CHAT_UNAVAILABLE_MESSAGE,` and `ApiKeyLiveChatUnavailableError,` with `UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE,` and `UnsupportedApiKeyChatProviderError,` (keep the block's order), and replace the mapping at `:766-768` with:

```ts
  if (error instanceof UnsupportedApiKeyChatProviderError) {
    return reply.code(400).send({ error: UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE });
  }
```

`ApiKeyUnreadableError` needs no route change: it is a `CliChatUnavailableError` whose message is on the auth allowlist.

Search for leftovers. Expected: no matches.

```bash
rg -n "ApiKeyLiveChatUnavailableError|API_KEY_LIVE_CHAT_UNAVAILABLE_MESSAGE|assertLiveCliProvider" packages apps tests
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm test:unit tests/unit/chat-session-manager-provider-identity.test.ts`
Run: `pnpm test:unit tests/unit/chat-auth-remediation-routes.test.ts`
Run: `pnpm test:unit tests/unit/chat-api-key-launch.test.ts`
Run: `pnpm test:unit tests/unit/chat-session-manager.test.ts`
Expected: PASS for all four.

- [ ] **Step 7: Write the targeted drop tests**

In `tests/unit/chat-session-manager-provider-drop.test.ts`, inside `makeMultiProviderManager`, change the `resolveActiveProvider` mock's returned object to:

```ts
      resolveActiveProvider: vi.fn().mockImplementation(async (userId: string) => ({
        provider: userId === "u-codex" ? "openai-compatible" : "anthropic",
        model: "default",
        providerConfigId: `row-${userId}`
      })),
```

and add, after the first `it`:

```ts
  it("drops only the sessions bound to the given provider row", async () => {
    const { manager, engines } = makeMultiProviderManager();
    await manager.ensureSession("u-claude-1", "Alice");
    await manager.ensureSession("u-claude-2", "Bob");
    await manager.ensureSession("u-codex", "Cara");

    await manager.dropSessionsForProvider({ providerConfigId: "row-u-claude-1" });

    expect(engines.get("u-claude-1:drawer")?.kill).toHaveBeenCalledTimes(1);
    expect(engines.get("u-claude-2:drawer")?.kill).not.toHaveBeenCalled();
    expect(engines.get("u-codex:drawer")?.kill).not.toHaveBeenCalled();
  });
```

Both Anthropic sessions share a kind, so only a match on the row id passes.

At the end of `tests/unit/ai-provider-config-update-route.test.ts`, add:

```ts
describe("provider saves drop the row's live chats", () => {
  const now = new Date("2026-10-11T00:00:00Z");
  const provider = {
    id: "provider-key",
    owner_user_id: "admin-1",
    provider_kind: "openai-compatible",
    acp_agent_id: null,
    display_name: "Proxy",
    base_url: "http://proxy.test",
    status: "active",
    auth_method: "api_key",
    execution_mode: "non_interactive",
    has_credential: true,
    is_instance_default: false,
    purpose: "assistant",
    revoked_at: null,
    created_at: now,
    updated_at: now
  };

  function app(drop = vi.fn().mockResolvedValue(undefined)) {
    const repository = {
      getUserById: vi.fn().mockResolvedValue({ is_instance_admin: true }),
      listProviders: vi.fn().mockResolvedValue([provider]),
      updateProvider: vi.fn().mockResolvedValue(provider),
      revokeProvider: vi.fn().mockResolvedValue({ ...provider, status: "revoked", revoked_at: now }),
      selectProviderWithCredential: vi.fn().mockResolvedValue(undefined)
    };
    const server = Fastify();
    registerAiRoutes(server, {
      resolveAccessContext: async () => ({ actorUserId: "admin-1", requestId: "req-1" }),
      dataContext: {
        withDataContext: async (
          _accessContext: unknown,
          run: (db: DataContextDb) => Promise<unknown>
        ) => run({} as DataContextDb)
      },
      resolveActiveModules: () => [],
      repository,
      secretCipher: { encryptJson: vi.fn(() => ({ sealed: true })), decryptJson: vi.fn() },
      dropChatSessionsForProviderConfig: drop
    } as unknown as AiRoutesDependencies);
    return { server, drop };
  }

  it.each([
    ["a new key", { credentialPayload: { apiKey: "localproxy0007neverlog" } }],
    ["a new address", { baseUrl: "http://proxy.test/other" }]
  ])("drops them after saving %s", async (_label, payload) => {
    const { server, drop } = app();
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-key",
        payload
      });
      expect(response.statusCode).toBe(200);
      expect(drop).toHaveBeenCalledWith("provider-key");
    } finally {
      await server.close();
    }
  });

  it("keeps them when only the status changes", async () => {
    const { server, drop } = app();
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-key",
        payload: { status: "disabled" }
      });
      expect(response.statusCode).toBe(200);
      expect(drop).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("drops them after revoke", async () => {
    const { server, drop } = app();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/ai/providers/provider-key/revoke"
      });
      expect(response.statusCode).toBe(200);
      expect(drop).toHaveBeenCalledWith("provider-key");
    } finally {
      await server.close();
    }
  });

  it("still saves when the drop fails", async () => {
    const { server } = app(vi.fn().mockRejectedValue(new Error("runner unavailable")));
    try {
      const response = await server.inject({
        method: "PATCH",
        url: "/api/ai/providers/provider-key",
        payload: { credentialPayload: { apiKey: "localproxy0007neverlog" } }
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 8: Run them and watch them fail**

Run: `pnpm test:unit tests/unit/chat-session-manager-provider-drop.test.ts`
Expected: FAIL on "drops only the sessions bound to the given provider row" (the object is not a kind, so no session matches and nothing is killed; TypeScript errors are reported by the type check, not Vitest).
Run: `pnpm test:unit tests/unit/ai-provider-config-update-route.test.ts`
Expected: FAIL on "drops them after saving a new key", "drops them after saving a new address" and "drops them after revoke"; the other two pass.

- [ ] **Step 9: Drop live sessions by provider row**

In `packages/chat/src/live/chat-session-provider-identity.ts`, add above `dropSessionsForProvider`:

```ts
/** A provider kind (binary replacement) or one provider row (key or address change). */
export type ChatSessionDropTarget = ProviderKind | { readonly providerConfigId: string };
```

and replace `dropSessionsForProvider`'s input field `readonly provider: ProviderKind;` with `readonly target: ChatSessionDropTarget;` and its `if (session.provider !== input.provider) continue;` line with:

```ts
    const matches =
      typeof input.target === "string"
        ? session.provider === input.target
        : session.providerIdentity.providerConfigId === input.target.providerConfigId;
    if (!matches) continue;
```

In `packages/chat/src/live/chat-session-manager.ts`, add `type ChatSessionDropTarget,` to the `./chat-session-provider-identity.js` import after `dropSessionsForProvider,` (line 15), and replace `:797-806` with:

```ts
  /** Drop live sessions for a provider kind or for one provider row. */
  async dropSessionsForProvider(target: ChatSessionDropTarget): Promise<void> {
    await this.withMaintenanceLock(() =>
      dropSessionsForProvider({
        target,
        sessions: this.sessions,
        revokeMcpToken: this.deps.revokeMcpToken
      })
    );
  }
```

Run `wc -l packages/chat/src/live/chat-session-manager.ts` (must stay at or under 1000; expected about 981).

In `packages/chat/src/routes.ts`, replace line 206 in place, keeping one line so the file stays at 1000 lines:

```ts
    dropSessionsForProvider: (target: ProviderKind | { providerConfigId: string }) => Promise<void>
```

The publisher at `:573-575` passes its argument through unchanged and needs no edit.

In `packages/ai/src/routes.ts`, add to `AiRoutesDependencies` after `modelDiscovery?`:

```ts
  // Drops live chat sessions bound to one provider row once its key or address changes.
  readonly dropChatSessionsForProviderConfig?: (providerConfigId: string) => Promise<void>;
```

In the PATCH handler, after the `if (!reconnectChanged) { ... }` block at `:422-424`, add:

```ts
        if (reconnectChanged) await dropLiveChatSessions(dependencies, request.params.id);
```

In the revoke handler, after `modelDiscovery.invalidate(accessContext.actorUserId, request.params.id);` at `:451`, add:

```ts
        await dropLiveChatSessions(dependencies, request.params.id);
```

At the end of the file, add:

```ts
/**
 * A failed drop never fails a saved provider change. The next turn's revision check still
 * relaunches the session with the row's current key and address.
 */
async function dropLiveChatSessions(
  dependencies: AiRoutesDependencies,
  providerConfigId: string
): Promise<void> {
  try {
    await dependencies.dropChatSessionsForProviderConfig?.(providerConfigId);
  } catch {
    // Best effort; see above.
  }
}
```

In `packages/module-registry/src/index.ts`:

1. Directly above `export function registerBuiltInApiRoutes(` (`:3559`), add:

```ts
type DropChatSessions = Parameters<
  NonNullable<ChatRoutesDependencies["adoptDropSessionsForProvider"]>
>[0];
```

2. Replace `:3607-3609` (the `dropSessionsForProvider` variable and its getter) with:

```ts
  let dropSessionsForProvider: DropChatSessions | undefined;
  const getDropSessionsForProvider = (): DropChatSessions | undefined => dropSessionsForProvider;
```

3. At `:3854`, change `adoptDropSessionsForProvider: (fn: (provider: ProviderKind) => Promise<void>) => {` to `adoptDropSessionsForProvider: (fn: DropChatSessions) => {`.
4. At `:3865`, after `getResolveActionRequestFn,`, add `getDropSessionsForProvider,`.
5. In the route deps type, after `getResolveActionRequestFn?` (`:726-728`), add:

```ts
  /** Per-server getter over the drop function {@link adoptDropSessionsForProvider} publishes. */
  readonly getDropSessionsForProvider?: () => DropChatSessions | undefined;
```

6. In the ai module's `registerAiRoutes(server, { ... })` call (`:2223`), after `dataContext: deps.dataContext,`, add:

```ts
        // A saved key or address must not stay live in a running chat.
        dropChatSessionsForProviderConfig: async (providerConfigId) => {
          const drop = deps.getDropSessionsForProvider?.();
          if (drop) await drop({ providerConfigId });
        },
```

The onboarding caller at `:3707-3710` passes a kind and needs no edit. If `ProviderKind` is no longer used in the file, drop it from the import.

Run: `wc -l packages/chat/src/routes.ts`
Expected: `1000 packages/chat/src/routes.ts`

- [ ] **Step 10: Run the drop tests and watch them pass**

Run: `pnpm test:unit tests/unit/chat-session-manager-provider-drop.test.ts`
Run: `pnpm test:unit tests/unit/ai-provider-config-update-route.test.ts`
Run: `pnpm test:unit tests/unit/chat-routes-thread-binding.test.ts`
Expected: PASS for all three.
Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 11: Removal steps**

| Temporary change | Test that must fail |
| --- | --- |
| In `chat-session-launch.ts`, move the `resolveApiKeyLaunchCredential` call to just before `deps.engineFactory(...)` | "refuses an API-key row whose key cannot be read..." (`openNewConversation` was called) |
| In `chat-session-launch.ts`, add `console.info("[chat] launch", credential);` after the credential is resolved | "keeps the key out of logs, stored calls and the agent's input" |
| In `assertLiveChatProvider`, replace the kind check with a bare `return;` | "evicts a cached CLI engine when the provider changes to an unsupported API-key kind" |
| In `sameActiveChatProvider`, delete the `providerConfigRevision` line (and the `&&` before it) | "discards the engine and relaunches when the same row gets a new key" and "...a new address" (one engine), and "refuses a pending turn once the row's key or address changed" |
| In `resolveApiKeyLaunchCredential`, delete the revision check | "retries with the new row when the key changes between the provider read and the key read" (two engines launched) |

Run `pnpm test:unit tests/unit/chat-session-manager-provider-identity.test.ts` after each, see the named test fail, record the failure in the PR body, then undo it.

| Temporary change | Test that must fail | Run |
| --- | --- | --- |
| In `dropSessionsForProvider`, replace the row branch with `true` | "drops only the sessions bound to the given provider row" | `pnpm test:unit tests/unit/chat-session-manager-provider-drop.test.ts` |
| In the PATCH handler, delete the `dropLiveChatSessions` line | "drops them after saving a new key" | `pnpm test:unit tests/unit/ai-provider-config-update-route.test.ts` |
| In the revoke handler, delete the `dropLiveChatSessions` line | "drops them after revoke" | `pnpm test:unit tests/unit/ai-provider-config-update-route.test.ts` |
| In `dropLiveChatSessions`, remove the `try`/`catch` and keep the call | "still saves when the drop fails" | `pnpm test:unit tests/unit/ai-provider-config-update-route.test.ts` |

Run the named file after each, see the named test fail, record it in the PR body, then undo it.

- [ ] **Step 12: Commit**

```bash
git add packages/chat/src/live/errors.ts packages/chat/src/live/chat-session-provider-identity.ts \
  packages/chat/src/live/chat-session-launch.ts packages/chat/src/live/persistence.ts \
  packages/chat/src/live/chat-session-manager.ts packages/chat/src/live-routes.ts \
  packages/chat/src/routes.ts packages/ai/src/routes.ts packages/module-registry/src/index.ts \
  tests/unit/chat-session-manager-provider-identity.test.ts \
  tests/unit/chat-auth-remediation-routes.test.ts tests/unit/chat-api-key-launch.test.ts \
  tests/unit/chat-session-manager-provider-drop.test.ts \
  tests/unit/ai-provider-config-update-route.test.ts
git commit -m "feat(chat): open live chat to API-key rows; relaunch on same-row key or address change (#3410)"
```

### Task 13: Readiness check for API-key chat rows

**Files:**
- Create: `packages/shared/src/ai-chat-readiness-api.ts`
- Modify: `packages/shared/src/index.ts:11` (export the new file)
- Create: `packages/ai/src/api-key-chat-readiness.ts`
- Modify: `packages/ai/src/index.ts` (export the new file next to `provider-validation.js`)
- Modify: `packages/ai/src/provider-validation-routes.ts` (new route; deps gain two optional fields)
- Modify: `packages/ai/src/routes.ts:493-499` (pass the tool-version reader)
- Test: `tests/unit/ai-api-key-chat-readiness.test.ts`

**Interfaces:**
- Consumes: `testProviderCredential`, `PROVIDER_CREDENTIAL_MISSING_MESSAGE`, `PROVIDER_REJECTED_CREDENTIAL_MESSAGE` (Task 5); `providerBaseUrl` (Task 4); `readCliToolVersions`, `CliToolVersionReader`, `CliToolVersions` (already in `packages/ai/src/cli-tool-versions.ts`).
- Produces:
  - `@moss/shared`: `API_KEY_CHAT_READINESS_STATUSES`, `type ApiKeyChatReadinessStatus = "ready" | "rejected_key" | "unreachable" | "needs_key" | "agent_missing" | "runner_unavailable"`, `interface ApiKeyChatReadinessResponse { readonly status: ApiKeyChatReadinessStatus }`, `apiKeyChatReadinessRouteSchema`.
  - `@moss/ai`: `type ApiKeyChatProviderKind = "anthropic" | "openai-compatible"`, `isApiKeyChatProviderKind(kind: string): kind is ApiKeyChatProviderKind`, `class ApiKeyChatReadiness` with `constructor(options?: { cliToolVersionReader?; fetch?; now?: () => number })` and `check(input: ApiKeyChatReadinessInput): Promise<ApiKeyChatReadinessStatus>`.
  - `GET /api/ai/providers/:id/chat-readiness` returns `{ status }` (admin only; 400 for rows that are not API-key Anthropic or OpenAI-compatible).

Readiness uses the sidecar's installed-tools report (`cliToolVersionReader`, the same source the provider cards use for versions) rather than `probeProvider`. `probeProvider` runs `claude --print` with the CLI login and has no API-key mode; the tools report answers the spec's question ("is the agent program installed") without a login. The claude agent counts as installed when `providers.anthropic` has a version; OpenCode when `opencode` has one.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/ai-api-key-chat-readiness.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";

import {
  ApiKeyChatReadiness,
  type ApiKeyChatReadinessInput
} from "../../packages/ai/src/api-key-chat-readiness.js";
import type { CliToolVersions } from "../../packages/ai/src/cli-tool-versions.js";
import {
  registerAiProviderValidationRoutes,
  type AiProviderValidationRouteDependencies
} from "../../packages/ai/src/provider-validation-routes.js";

const KEY = "ada-readiness-key-0001";
const INSTALLED: CliToolVersions = {
  providers: { anthropic: "2.1.0", "openai-compatible": "0.40.0", google: null },
  opencode: "1.18.29"
};

function fakeFetch(status = 200) {
  return vi.fn(async () => new Response('{"data":[]}', { status }));
}

function input(overrides: Partial<ApiKeyChatReadinessInput> = {}): ApiKeyChatReadinessInput {
  return {
    providerId: "provider-1",
    providerKind: "anthropic",
    baseUrl: "http://proxy.test",
    updatedAt: new Date("2026-10-10T00:00:00Z"),
    openCredential: () => ({ apiKey: KEY }),
    ...overrides
  };
}

describe("ApiKeyChatReadiness", () => {
  it("is ready when the claude agent is installed and the models list answers", async () => {
    const fetch = fakeFetch();
    const readiness = new ApiKeyChatReadiness({ cliToolVersionReader: async () => INSTALLED, fetch });

    await expect(readiness.check(input())).resolves.toBe("ready");
    expect(fetch).toHaveBeenCalledWith(
      "http://proxy.test/v1/models",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": KEY }) })
    );
  });

  it("names a rejected key on 401 and an unreachable provider on other failures", async () => {
    const reader = async () => INSTALLED;
    const refused = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch(401) }).check(input())
    ).resolves.toBe("rejected_key");
    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch(500) }).check(input())
    ).resolves.toBe("unreachable");
    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: refused }).check(input())
    ).resolves.toBe("unreachable");
  });

  it("checks OpenCode for OpenAI-compatible rows and sends exactly one /v1", async () => {
    const fetch = fakeFetch();
    const readiness = new ApiKeyChatReadiness({ cliToolVersionReader: async () => INSTALLED, fetch });

    await expect(
      readiness.check(input({ providerKind: "openai-compatible", baseUrl: "http://proxy.test/v1/" }))
    ).resolves.toBe("ready");
    expect(fetch).toHaveBeenCalledWith(
      "http://proxy.test/v1/models",
      expect.objectContaining({ headers: { authorization: `Bearer ${KEY}` } })
    );

    const noOpencode = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => ({ ...INSTALLED, opencode: null }),
      fetch: fakeFetch()
    });
    await expect(noOpencode.check(input({ providerKind: "openai-compatible" }))).resolves.toBe(
      "agent_missing"
    );
  });

  it("reports a missing claude agent without calling the provider", async () => {
    const fetch = fakeFetch();
    const readiness = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => ({
        ...INSTALLED,
        providers: { ...INSTALLED.providers, anthropic: null }
      }),
      fetch
    });

    await expect(readiness.check(input())).resolves.toBe("agent_missing");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a missing key when it cannot be decrypted or is empty", async () => {
    const reader = async () => INSTALLED;
    const unreadable = input({
      openCredential: () => {
        throw new Error("bad auth tag");
      }
    });

    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch() }).check(unreadable)
    ).resolves.toBe("needs_key");
    await expect(
      new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch() }).check(
        input({ openCredential: () => ({}) })
      )
    ).resolves.toBe("needs_key");
  });

  it("never caches a runner outage", async () => {
    const reader = vi
      .fn<() => Promise<CliToolVersions>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValue(INSTALLED);
    const readiness = new ApiKeyChatReadiness({ cliToolVersionReader: reader, fetch: fakeFetch() });

    await expect(readiness.check(input())).resolves.toBe("runner_unavailable");
    await expect(readiness.check(input())).resolves.toBe("ready");
    await expect(new ApiKeyChatReadiness({ fetch: fakeFetch() }).check(input())).resolves.toBe(
      "runner_unavailable"
    );
  });

  it("caches by row and update time, and a cache hit opens no key", async () => {
    const fetch = fakeFetch();
    const openCredential = vi.fn(() => ({ apiKey: KEY }));
    let now = 1_000;
    const readiness = new ApiKeyChatReadiness({
      cliToolVersionReader: async () => INSTALLED,
      fetch,
      now: () => now
    });

    await readiness.check(input({ openCredential }));
    await readiness.check(input({ openCredential }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(openCredential).toHaveBeenCalledTimes(1);

    await readiness.check(input({ openCredential, updatedAt: new Date("2026-10-10T00:05:00Z") }));
    expect(fetch).toHaveBeenCalledTimes(2);

    now += 60_001;
    await readiness.check(input({ openCredential }));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

const apiKeyRow = {
  id: "provider-1",
  provider_kind: "anthropic",
  auth_method: "api_key",
  base_url: "http://proxy.test",
  purpose: "assistant",
  status: "active",
  updated_at: new Date("2026-10-10T00:00:00Z"),
  encrypted_credential: { sealed: true }
};

async function routeServer(row: Record<string, unknown>, isAdmin = true) {
  const server = Fastify();
  const dependencies = {
    resolveAccessContext: async () => ({ actorUserId: "admin-1", requestId: "req-1" }),
    dataContext: {
      withDataContext: async (
        _accessContext: unknown,
        run: (db: DataContextDb) => Promise<unknown>
      ) => run({} as DataContextDb)
    },
    repository: {
      getUserById: vi.fn(async () => ({ id: "admin-1", is_instance_admin: isAdmin })),
      selectProviderWithCredential: vi.fn(async () => row)
    },
    secretCipher: { encryptJson: vi.fn(), decryptJson: vi.fn(() => ({ apiKey: KEY })) },
    modelDiscovery: {},
    chatReadiness: new ApiKeyChatReadiness({
      cliToolVersionReader: async () => INSTALLED,
      fetch: fakeFetch()
    })
  } as unknown as AiProviderValidationRouteDependencies;
  registerAiProviderValidationRoutes(server, dependencies);
  await server.ready();
  return server;
}

describe("GET /api/ai/providers/:id/chat-readiness", () => {
  it("returns only the status, never the key", async () => {
    const server = await routeServer(apiKeyRow);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/ai/providers/provider-1/chat-readiness"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
      expect(response.body).not.toContain(KEY);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["a CLI row", { ...apiKeyRow, auth_method: "cli" }],
    ["a Google API-key row", { ...apiKeyRow, provider_kind: "google" }]
  ])("refuses %s with 400", async (_label, row) => {
    const server = await routeServer(row);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/ai/providers/provider-1/chat-readiness"
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("refuses a non-admin with 403", async () => {
    const server = await routeServer(apiKeyRow, false);
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/ai/providers/provider-1/chat-readiness"
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm test:unit tests/unit/ai-api-key-chat-readiness.test.ts`
Expected: FAIL, cannot resolve `../../packages/ai/src/api-key-chat-readiness.js`.

- [ ] **Step 3: Add the shared contract**

Create `packages/shared/src/ai-chat-readiness-api.ts`:

```ts
import { errorResponseSchema, idParamsSchema } from "./schema-fragments.js";

// #3410: whether an API-key provider row can drive chat right now.

export const API_KEY_CHAT_READINESS_STATUSES = [
  "ready",
  "rejected_key",
  "unreachable",
  "needs_key",
  "agent_missing",
  "runner_unavailable"
] as const;

export type ApiKeyChatReadinessStatus = (typeof API_KEY_CHAT_READINESS_STATUSES)[number];

export interface ApiKeyChatReadinessResponse {
  readonly status: ApiKeyChatReadinessStatus;
}

export const apiKeyChatReadinessResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: API_KEY_CHAT_READINESS_STATUSES }
  }
} as const;

export const apiKeyChatReadinessRouteSchema = {
  params: idParamsSchema,
  response: {
    200: apiKeyChatReadinessResponseSchema,
    400: errorResponseSchema,
    401: errorResponseSchema,
    403: errorResponseSchema,
    404: errorResponseSchema
  }
} as const;
```

In `packages/shared/src/index.ts`, add after `export * from "./ai-api.js";`:

```ts
export * from "./ai-chat-readiness-api.js";
```

- [ ] **Step 4: Add the readiness check**

Create `packages/ai/src/api-key-chat-readiness.ts`:

```ts
import type { ApiKeyChatReadinessStatus } from "@moss/shared";

import {
  readCliToolVersions,
  type CliToolVersionReader,
  type CliToolVersions
} from "./cli-tool-versions.js";
import { providerBaseUrl } from "./provider-base-url.js";
import {
  PROVIDER_CREDENTIAL_MISSING_MESSAGE,
  PROVIDER_REJECTED_CREDENTIAL_MESSAGE,
  testProviderCredential
} from "./provider-validation.js";

/** Kinds whose API-key rows can drive chat: the claude agent and OpenCode. */
export type ApiKeyChatProviderKind = "anthropic" | "openai-compatible";

export function isApiKeyChatProviderKind(kind: string): kind is ApiKeyChatProviderKind {
  return kind === "anthropic" || kind === "openai-compatible";
}

export interface ApiKeyChatReadinessInput {
  readonly providerId: string;
  readonly providerKind: ApiKeyChatProviderKind;
  readonly baseUrl: string | null;
  /** Moves when the key is edited, so it invalidates the cache. */
  readonly updatedAt: Date;
  /** Decrypts the stored credential. Called only on a cache miss. */
  readonly openCredential: () => unknown;
}

export interface ApiKeyChatReadinessOptions {
  readonly cliToolVersionReader?: CliToolVersionReader;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

interface CachedStatus {
  readonly status: ApiKeyChatReadinessStatus;
  readonly expiresAt: number;
}

/**
 * Readiness for an API-key chat row. The sidecar must report the agent program installed, and the
 * provider's models list must answer with the stored address and key. Results are cached by row
 * id and update time, never by key.
 */
export class ApiKeyChatReadiness {
  private readonly cache = new Map<string, CachedStatus>();

  constructor(private readonly options: ApiKeyChatReadinessOptions = {}) {}

  async check(input: ApiKeyChatReadinessInput): Promise<ApiKeyChatReadinessStatus> {
    const now = this.options.now?.() ?? Date.now();
    const cacheKey = `${input.providerId}:${input.updatedAt.getTime()}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.status;

    const status = await this.probe(input);

    // A runner outage says nothing about the row, so it is never cached.
    if (status !== "runner_unavailable") {
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(key);
      }
      this.cache.set(cacheKey, { status, expiresAt: now + CACHE_TTL_MS });
    }
    return status;
  }

  private async probe(input: ApiKeyChatReadinessInput): Promise<ApiKeyChatReadinessStatus> {
    const versions = await readCliToolVersions(this.options.cliToolVersionReader);
    if (!versions) return "runner_unavailable";
    if (agentVersion(versions, input.providerKind) === null) return "agent_missing";

    let credential: unknown;
    try {
      credential = input.openCredential();
    } catch {
      return "needs_key";
    }

    const baseFetch = this.options.fetch ?? fetch;
    const result = await testProviderCredential({
      providerKind: input.providerKind,
      authMethod: "api_key",
      baseUrl: providerBaseUrl(input.providerKind, input.baseUrl),
      credential,
      fetch: (url, init) =>
        baseFetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    });
    if (result.ok) return "ready";
    if (result.message === PROVIDER_CREDENTIAL_MISSING_MESSAGE) return "needs_key";
    if (result.message === PROVIDER_REJECTED_CREDENTIAL_MESSAGE) return "rejected_key";
    return "unreachable";
  }
}

function agentVersion(versions: CliToolVersions, kind: ApiKeyChatProviderKind): string | null {
  return kind === "anthropic" ? versions.providers.anthropic : versions.opencode;
}
```

`providerBaseUrl` strips a trailing `/v1` and `testProviderCredential` adds `/v1/models`, so an OpenAI-compatible address saved with `/v1` is checked at the same place OpenCode will call.

In `packages/ai/src/index.ts`, add next to the provider-validation exports:

```ts
export * from "./api-key-chat-readiness.js";
```

- [ ] **Step 5: Add the route**

In `packages/ai/src/provider-validation-routes.ts`:

1. Add `apiKeyChatReadinessRouteSchema` to the `@moss/shared` import (alphabetical, first in the list).
2. Add the imports:

```ts
import { ApiKeyChatReadiness, isApiKeyChatProviderKind } from "./api-key-chat-readiness.js";
import type { CliToolVersionReader } from "./cli-tool-versions.js";
```

3. Add below `interface IdParams`:

```ts
const CHAT_READINESS_NOT_APPLICABLE_MESSAGE =
  "Chat readiness applies only to Anthropic and OpenAI-compatible API-key providers";
```

4. Add two fields to `AiProviderValidationRouteDependencies`:

```ts
  /** Installed agent programs, from the cli-runner. Absent when the runner is not configured. */
  readonly cliToolVersionReader?: CliToolVersionReader;
  /** Test seam. Production builds one per registration so its cache spans requests. */
  readonly chatReadiness?: ApiKeyChatReadiness;
```

5. At the top of `registerAiProviderValidationRoutes`, before the first route:

```ts
  const chatReadiness =
    dependencies.chatReadiness ??
    new ApiKeyChatReadiness({ cliToolVersionReader: dependencies.cliToolVersionReader });
```

6. Add the route after the `/test` route:

```ts
  server.get<{ Params: IdParams }>(
    "/api/ai/providers/:id/chat-readiness",
    { schema: apiKeyChatReadinessRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const provider = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
          loadTestableProvider(dependencies, scopedDb, accessContext, request.params.id)
        );
        const providerKind = provider.provider_kind;
        if (provider.auth_method !== "api_key" || !isApiKeyChatProviderKind(providerKind)) {
          throw new HttpError(400, CHAT_READINESS_NOT_APPLICABLE_MESSAGE);
        }

        // The provider call runs outside the database transaction.
        const status = await chatReadiness.check({
          providerId: provider.id,
          providerKind,
          baseUrl: provider.base_url,
          updatedAt: provider.updated_at,
          openCredential: () => dependencies.secretCipher.decryptJson(provider.encrypted_credential)
        });
        return { status };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
```

In `packages/ai/src/routes.ts`, add one line to the `registerAiProviderValidationRoutes(server, { ... })` call at `:493-499`:

```ts
    cliToolVersionReader: dependencies.cliToolVersionReader,
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm test:unit tests/unit/ai-api-key-chat-readiness.test.ts`
Expected: PASS (11 tests).
Run: `pnpm test:unit tests/unit/ai-provider-validation.test.ts`
Expected: PASS (unchanged behaviour).

- [ ] **Step 7: Removal steps**

| Temporary change | Test that must fail |
| --- | --- |
| In the route, return `{ status, credential: dependencies.secretCipher.decryptJson(provider.encrypted_credential) }` and set the 200 schema's `additionalProperties` to `true` | "returns only the status, never the key". Then restore `additionalProperties: false` but keep the leaking return: the test passes again, which shows the closed schema strips extra fields. Undo both. |
| In `check`, change the cache key to `` `${input.providerId}:${JSON.stringify(input.openCredential())}` `` | "caches by row and update time, and a cache hit opens no key" |
| In `check`, delete the `if (status !== "runner_unavailable")` guard (cache every status) | "never caches a runner outage" |

Run `pnpm test:unit tests/unit/ai-api-key-chat-readiness.test.ts` after each, see the named test fail, then undo it.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/ai-chat-readiness-api.ts packages/shared/src/index.ts \
  packages/ai/src/api-key-chat-readiness.ts packages/ai/src/index.ts \
  packages/ai/src/provider-validation-routes.ts packages/ai/src/routes.ts \
  tests/unit/ai-api-key-chat-readiness.test.ts
git commit -m "feat(ai): chat readiness check for API-key provider rows (#3410)"
```

### Task 14: API-key provider cards show chat readiness

**Files:**
- Create: `apps/web/src/settings/settings-ai-chat-readiness.ts`
- Modify: `apps/web/src/api/client.ts` (after `testAiProvider`, about `:1267-1272`; add the response type to the `@moss/shared` import list near `:182`)
- Modify: `apps/web/src/api/query-keys.ts:59-60`
- Modify: `apps/web/src/settings/settings-ai-provider-models.tsx:13-24`, `:156-183`, `:223-227`
- Test: `tests/unit/settings-ai-chat-readiness.test.ts` (create), `tests/unit/settings-ai-provider-models.test.tsx`, `tests/unit/settings-ai-admin-pane.test.tsx`

**Interfaces:**
- Consumes: `ApiKeyChatReadinessResponse`, `ApiKeyChatReadinessStatus` (Task 13); `GET /api/ai/providers/:id/chat-readiness` (Task 13).
- Produces: `getAiProviderChatReadiness(id: string): Promise<ApiKeyChatReadinessResponse>`; `queryKeys.ai.providerChatReadiness(providerId: string, updatedAt: string)`; `showsChatReadiness(provider)`, `describeChatReadiness(status): string | null`.

The query key carries the row's `updatedAt`, so editing the key starts a fresh check instead of showing the old result for a minute.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/settings-ai-chat-readiness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { ApiKeyChatReadinessStatus } from "@moss/shared";

import {
  describeChatReadiness,
  showsChatReadiness
} from "../../apps/web/src/settings/settings-ai-chat-readiness.js";

describe("chat readiness text", () => {
  it.each<[ApiKeyChatReadinessStatus, string | null]>([
    ["ready", null],
    ["rejected_key", "The provider rejected the API key"],
    ["unreachable", "Could not reach the provider"],
    ["needs_key", "No API key is saved"],
    ["agent_missing", "The chat program for this provider is not installed"],
    ["runner_unavailable", "The sign-in helper is not running"]
  ])("describes %s", (status, text) => {
    expect(describeChatReadiness(status)).toBe(text);
  });

  it("applies only to Anthropic and OpenAI-compatible API-key rows", () => {
    expect(showsChatReadiness({ authMethod: "api_key", providerKind: "anthropic" })).toBe(true);
    expect(showsChatReadiness({ authMethod: "api_key", providerKind: "openai-compatible" })).toBe(
      true
    );
    expect(showsChatReadiness({ authMethod: "api_key", providerKind: "google" })).toBe(false);
    expect(showsChatReadiness({ authMethod: "cli", providerKind: "anthropic" })).toBe(false);
  });
});
```

In `tests/unit/settings-ai-provider-models.test.tsx`, add to the `client.js` mock factory (line 9-13):

```ts
  getAiProviderChatReadiness: vi.fn(async () => ({ status: "ready" })),
```

and append inside the top-level `describe`:

```ts
  it("shows a rejected API key on an API-key chat row", async () => {
    const clientModule = await import("../../apps/web/src/api/client.js");
    vi.mocked(clientModule.getAiProviderChatReadiness).mockResolvedValueOnce({
      status: "rejected_key"
    });
    const { renderer } = await render([]);

    expect(clientModule.getAiProviderChatReadiness).toHaveBeenCalledWith("p1");
    expect(
      renderer.root
        .findAllByProps({ role: "status" })
        .map((node) => node.children.join(" "))
        .some((text) => text === "The provider rejected the API key")
    ).toBe(true);
  });

  it("does not check chat readiness for a CLI row", async () => {
    const clientModule = await import("../../apps/web/src/api/client.js");
    vi.mocked(clientModule.getAiProviderChatReadiness).mockClear();
    await render([], vi.fn(), { ...provider, authMethod: "cli" } as AiProviderConfigDto);

    expect(clientModule.getAiProviderChatReadiness).not.toHaveBeenCalled();
  });
```

In `tests/unit/settings-ai-admin-pane.test.tsx`, add the same line to the `client.js` mock factory (next to `refreshAiProviderModels` at `:49`):

```ts
  getAiProviderChatReadiness: vi.fn(async () => ({ status: "ready" })),
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm test:unit tests/unit/settings-ai-chat-readiness.test.ts`
Expected: FAIL, cannot resolve `settings-ai-chat-readiness.js`.
Run: `pnpm test:unit tests/unit/settings-ai-provider-models.test.tsx`
Expected: FAIL on the two new tests (the component never calls the readiness function).

- [ ] **Step 3: Add the client call and the query key**

In `apps/web/src/api/client.ts`, add `ApiKeyChatReadinessResponse,` to the `@moss/shared` type import list (keep alphabetical order), and add after `testAiProvider`:

```ts
/** #3410: whether an API-key provider row can drive chat right now. */
export async function getAiProviderChatReadiness(id: string): Promise<ApiKeyChatReadinessResponse> {
  return requestJson<ApiKeyChatReadinessResponse>(
    `/api/ai/providers/${encodeURIComponent(id)}/chat-readiness`
  );
}
```

In `apps/web/src/api/query-keys.ts`, add after `providerInitialization`:

```ts
    providerChatReadiness: (providerId: string, updatedAt: string) =>
      ["ai", "provider-chat-readiness", providerId, updatedAt] as const,
```

- [ ] **Step 4: Add the display helper**

Create `apps/web/src/settings/settings-ai-chat-readiness.ts`:

```ts
import type { AiProviderConfigDto, ApiKeyChatReadinessStatus } from "@moss/shared";

/** #3410: API-key rows that can drive chat show a readiness line on their card. */
export function showsChatReadiness(
  provider: Pick<AiProviderConfigDto, "authMethod" | "providerKind">
): boolean {
  return (
    provider.authMethod === "api_key" &&
    (provider.providerKind === "anthropic" || provider.providerKind === "openai-compatible")
  );
}

/** The card's status line for an API-key chat row; null when chat is ready. */
export function describeChatReadiness(status: ApiKeyChatReadinessStatus): string | null {
  switch (status) {
    case "ready":
      return null;
    case "rejected_key":
      return "The provider rejected the API key";
    case "unreachable":
      return "Could not reach the provider";
    case "needs_key":
      return "No API key is saved";
    case "agent_missing":
      return "The chat program for this provider is not installed";
    case "runner_unavailable":
      return "The sign-in helper is not running";
  }
}
```

- [ ] **Step 5: Show it on the card**

In `apps/web/src/settings/settings-ai-provider-models.tsx`:

1. Change the client import to `import { getAiProviderChatReadiness, refreshAiProviderModels } from "../api/client.js";` and add `import { describeChatReadiness, showsChatReadiness } from "./settings-ai-chat-readiness.js";` after the `settings-types.js` import.
2. Add after the `initializationQuery` declaration:

```ts
  const chatReadinessQuery = useQuery({
    queryKey: queryKeys.ai.providerChatReadiness(provider.id, provider.updatedAt),
    queryFn: () => getAiProviderChatReadiness(provider.id),
    enabled: showsChatReadiness(provider),
    staleTime: 60_000,
    retry: false
  });
```

3. Add after the `initializationOutcome` declaration:

```ts
  const chatReadinessOutcome = chatReadinessQuery.data
    ? describeChatReadiness(chatReadinessQuery.data.status)
    : null;
  const statusLine = initializationOutcome ?? chatReadinessOutcome;
```

4. In the JSX, replace `initializationOutcome` with `statusLine` in both places of the `prov__synced` block:

```tsx
      {statusLine !== null ? (
        <div className="prov__synced" role="status">
          {statusLine}
        </div>
      ) : null}
```

The two queries never run for the same row (one needs a CLI row, the other an API-key row), so `??` only picks whichever applies.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm test:unit tests/unit/settings-ai-chat-readiness.test.ts`
Run: `pnpm test:unit tests/unit/settings-ai-provider-models.test.tsx`
Run: `pnpm test:unit tests/unit/settings-ai-admin-pane.test.tsx`
Expected: PASS for all three.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/settings/settings-ai-chat-readiness.ts apps/web/src/api/client.ts \
  apps/web/src/api/query-keys.ts apps/web/src/settings/settings-ai-provider-models.tsx \
  tests/unit/settings-ai-chat-readiness.test.ts tests/unit/settings-ai-provider-models.test.tsx \
  tests/unit/settings-ai-admin-pane.test.tsx
git commit -m "feat(web): show chat readiness on API-key provider cards (#3410)"
```

### Task 15: App map and ADR 0003

**Files:**
- Modify: `packages/shared/src/app-map-core.ts` (the Task 6 sentence near `:283-285`; chat sentence near `:299-300` after Task 6 shifts it; error entry near `:476-481`; remediation near `:559-564`)
- Modify: `docs/architecture/decisions/0003-interactive-chat-is-cli-transport.md:3`
- Test: `tests/unit/app-map-api-key-chat.test.ts` (create)

Find each anchor by its text, not its line number. Task 6 added two lines above the later anchors.

**Interfaces:**
- Consumes: the error class names from Task 12 (the app map names the error by code, not by class).
- Produces: error code `core.ai.api_key_chat_provider_unsupported`; remediation id `core.ai.connect_cli_provider` is kept, with new text.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/app-map-api-key-chat.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  CORE_APP_ERRORS,
  CORE_APP_REMEDIATIONS,
  CORE_APP_SCREENS,
  CORE_APP_SETTINGS
} from "../../packages/shared/src/app-map-core.js";

describe("app map: API-key chat (#3410)", () => {
  it("names the unsupported-kind error and drops the old refusal", () => {
    const codes = CORE_APP_ERRORS.map((error) => error.code);
    expect(codes).toContain("core.ai.api_key_chat_provider_unsupported");
    expect(codes).not.toContain("core.ai.api_key_live_chat_unavailable");
  });

  it("tells admins that API-key providers can run chat", () => {
    const remediation = CORE_APP_REMEDIATIONS.find(
      (entry) => entry.id === "core.ai.connect_cli_provider"
    );
    expect(remediation?.description).toMatch(/Anthropic or OpenAI-compatible API-key provider/);

    const text = JSON.stringify([CORE_APP_SCREENS, CORE_APP_SETTINGS]);
    expect(text).not.toMatch(/API-key providers are not available yet/);
    expect(text).toMatch(/API-key provider card also shows whether chat can use it/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm test:unit tests/unit/app-map-api-key-chat.test.ts`
Expected: FAIL on both tests.

- [ ] **Step 3: Update the app map**

In `packages/shared/src/app-map-core.ts`:

1. In the sentence Task 6 added, replace

```ts
      "Anthropic-compatible service; background jobs and model lists use that address. The Codex ACP row hands " +
```

with

```ts
      "Anthropic-compatible service; chat, background jobs and model lists use that address. " +
      "An Anthropic or OpenAI-compatible API-key provider card also shows whether chat can use it: " +
      "ready, key rejected, provider unreachable, no key saved, chat program not installed, or " +
      "sign-in helper not running. The Codex ACP row hands " +
```

2. Replace the chat line

```ts
      "General live chat reports that API-key providers are not available yet and does not start an engine; " +
```

with

```ts
      "General live chat runs on a CLI provider or on an Anthropic or OpenAI-compatible API-key " +
      "provider. API-key chat runs the claude agent or OpenCode with the provider's saved address, " +
      "key and model, and keeps Moss tools and confirmation cards. " +
```

and on the next line delete the leading `choose a CLI provider for general live chat. ` so the string starts with `"The normal docked drawer`. Keep the rest of that string unchanged.

3. Replace the error entry `core.ai.api_key_live_chat_unavailable` with:

```ts
  {
    code: "core.ai.api_key_chat_provider_unsupported",
    class: "prerequisite",
    remediationRef: "core.ai.connect_cli_provider",
    description:
      "General live chat cannot start with an API-key provider of a type other than Anthropic or OpenAI-compatible. Selected-meeting questions are the separate API-key-only capability in the same drawer."
  },
```

4. In the remediation `core.ai.connect_cli_provider`, replace the description with:

```ts
    description:
      "Ask an administrator to choose an Anthropic or OpenAI-compatible API-key provider, or a supported CLI provider, for general live chat.",
```

Keep the id: other entries point at it.

- [ ] **Step 4: Amend ADR 0003**

In `docs/architecture/decisions/0003-interactive-chat-is-cli-transport.md`, replace line 3

```markdown
- **Status:** Accepted
```

with

```markdown
- **Status:** Superseded in part (interactive transport) by `docs/superpowers/specs/2026-10-10-api-key-chat-design.md`
```

- [ ] **Step 5: Run the app-map tests**

Run each: `pnpm test:unit tests/unit/app-map-api-key-chat.test.ts`, `pnpm test:unit tests/unit/app-map-build.test.ts`, `pnpm test:unit tests/unit/app-map-contract.test.ts`, `pnpm test:unit tests/unit/app-map-integrity.test.ts`
Expected: PASS. If a snapshot or length budget fails, update a committed snapshot only when the diff is exactly these sentences.

Search for leftovers. Expected: no matches.

```bash
rg -n "api_key_live_chat_unavailable|API-key providers are not available yet" packages apps tests
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/app-map-core.ts tests/unit/app-map-api-key-chat.test.ts \
  docs/architecture/decisions/0003-interactive-chat-is-cli-transport.md
git commit -m "docs(app-map): describe API-key chat; ADR 0003 superseded in part (#3410)"
```

### Task 16: Gate, release note and the live-path proof

**Files:** none changed unless the gate finds something. The release note goes in the PR body; the proof goes in a PR comment.

This task needs a person or agent with the proxy on the host. It uses `$PROXY_URL`, `$PROXY_KEY_FILE`, `$PROXY_ANTHROPIC_MODEL` and `$PROXY_OPENAI_MODEL` from the shell. Never print the key or the key file. Leak searches use `/tmp/acp-proof/key-scan.mjs` from the phase 0 shared setup; if `/tmp` was cleared, recreate it from that block first. No key text, or any slice of it, goes on a command line.

- [ ] **Step 1: verify-gate**

Run the full gate through the verify-gate skill. Do not run it any other way. Expected: green. Then confirm the line limits:

```bash
wc -l packages/cli-runner/src/acp-host.ts packages/shared/src/ai-api.ts \
  packages/cli-runner/src/engine-host.ts packages/chat/src/live/chat-session-manager.ts \
  packages/chat/src/live/runtime.ts
```

Expected: every count at or below 1000.

- [ ] **Step 2: Release note in the PR body**

Fill in the PR template's "Release note" section:

```markdown
Category: Added
Title: Chat can now use an API-key provider
Description: Admins can pick an Anthropic or OpenAI-compatible (Chat Completions) provider that uses an API key, including one at its own web address, and chat works with it the same way, tools and confirmation cards included.
```

Also add a "Known limits" section to the PR body with these three lines and nothing about key masking (Tasks 9 and 10 mask a key split across chunks and launch errors, with no exception):

- OpenAI-compatible means a service that speaks Chat Completions. It was proved against one proxy, not every service that uses the name.
- The agent's environment holds the key, so a tool that can read the agent's own environment could read it. This is the spec's recorded risk.
- In shared-user mode (dev), agents of different users run as one system user.

- [ ] **Step 3: Start a dev instance with this branch**

Start a dev instance the usual way (`scripts/dev-instance`, CLI defaults). Claim its web port with `devports claim <your-agent-name>`. The cli-runner runs on the host, so agents reach `$PROXY_URL` directly.

- [ ] **Step 4: Prove the claude agent path through the UI**

Through the real UI, signed in as the dev admin, set up the row:

1. Settings, AI providers, Add, "Anthropic (API key)". Put `$PROXY_URL` in "Base URL" and the key from `$PROXY_KEY_FILE` in the key field. Save.
2. Refresh models on the new card. Expect the list to contain `$PROXY_ANTHROPIC_MODEL`. Turn on chat for it and make the row the default.
3. Expect no status line under the card's models (readiness is "ready").

Then run each case in the chat drawer and record its evidence. Every case must pass.

| Case | Do | Expect |
| --- | --- | --- |
| A. Deny, no write | Ask "Add a task called Deny check". Press Deny on the confirmation card. | The turn ends with a reply. No "Deny check" task on the Tasks screen. |
| B. Cancel, no write | Ask "Add a task called Cancel check". Before answering the card, press the drawer's stop control. | The turn ends. No "Cancel check" task. The next message gets a normal reply. |
| C. Approve, then another turn | Ask "Add a task called Ada's test task". Approve. Then ask "What task did you just add?" | The task exists on the Tasks screen. The second reply names it. |
| D. Streamed tool result | Ask "List my open tasks." | The reply streams after the tool result, names "Ada's test task", and the turn completes with no spinner left. |
| E. Cancel and retry | Ask "Count slowly from one to forty, one number per line." Press stop part-way. Send the same message again. | The first turn stops. The second runs to forty. |
| F. Provider switch with replay | Make a different chat-capable row the default (the CLI row, or the other API-key row once Step 5 has added it). Ask "What task did I ask you to add earlier?" Then switch back. | The other provider names "Ada's test task", so history was replayed into the new session. |
| G. Same-row key rotation | Run `pgrep -fn claude-agent-acp` and note the pid. Edit this row and save the same key again (a fresh save re-seals it). Ask "What task did I ask you to add earlier?" Run `pgrep -fn claude-agent-acp` again. | The pid changed, so the old session was dropped. The reply names "Ada's test task". |

Record bounded evidence per case: the request id from the api log for the turn, the tool name from any confirmation card, the task titles from the UI as text, and the two pids for case G. Never record a log line, only ids, names and titles.

- [ ] **Step 5: Prove the OpenCode path through the UI**

Add a second row with Add, "OpenAI-compatible", `$PROXY_URL` as "Base URL", the same key, and `$PROXY_OPENAI_MODEL` as the chat model. Make it the default. Run cases A to G from Step 4 against it, with these changes:

- Use the task titles "Deny check 2", "Cancel check 2" and "Ada's second task", and expect those titles.
- In case F, switch to the Anthropic API-key row from Step 4 and back.
- In case G, use `pgrep -fn 'opencode acp'`.

Every case must pass with the same expectations.

- [ ] **Step 6: Prove a wrong key is named, not mistaken for a sign-in problem**

Edit the Anthropic row and save a wrong key. Expect the card to read "The provider rejected the API key". Send a chat message and expect "The provider rejected the API key. An admin can check it under Settings, AI providers." Expect no CLI sign-in prompt. Put the right key back.

- [ ] **Step 7: Search for the key**

With both agents having chatted, search everything the key must not reach. Start one slow turn in the drawer ("Count slowly from one to forty, one number per line.") so an agent is running, then:

```bash
node /tmp/acp-proof/key-scan.mjs "$PROXY_KEY_FILE" --argv
node /tmp/acp-proof/key-scan.mjs "$PROXY_KEY_FILE" <dev-instance log directory> <dev-instance agent homes>
```

Expected: `ARGV_HITS 0` and `FILE_HITS 0` from the first command, then `FILE_HITS 0`. The scanner checks the whole key and every 12-character piece of it, and prints counts, pids and file names only. Use the dev instance's log and agent-home directories as printed by `scripts/dev-instance` at start; the agent homes include `.config/opencode/opencode.json`. Report "no matches" or the pids and file names that matched, never content.

- [ ] **Step 8: Post the proof**

Post one `gh pr comment` on the implementation PR with:

- what ran: dev instance from this branch, both agents, through the real UI
- the bounded evidence from Steps 4-7, per agent and per case A to G (request ids, tool names, task titles, pids, "no matches")
- a disclosure: the provider was a local stand-in proxy that forwards to real model services. Moss's own path ran unaltered; the claim is about what Moss sends to the provider.

If any step fails, the status is "code-complete, unverified". Say so on the PR and on #3410, and do not merge.

- [ ] **Step 9: Stop the dev instance**

Stop it and run `devports release <port>`.

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
| --- | --- |
| Phase 0 proofs, stop on failure | 1, 2, 3 |
| Anthropic address in the HTTP adapter, model discovery and key test | 4, 5 |
| "Anthropic (API key)" add entry, app map for it | 6 |
| Key crosses into the sidecar on `acpSpawn` only, value-free errors | 7 |
| OpenCode provider entry with an env reference, removed on CLI spawns | 8, 9 |
| Agent env for the claude agent, no OAuth token on API-key spawns | 9 |
| Key never in argv, logs, RPC errors, browser or `opencode.json`, including a key split across stderr chunks and launch errors | 7, 9, 10, 12, 13 (removal steps), 16 Step 7 |
| Leak scans read the key file themselves | 1, 2, 16 Step 7 |
| Effective model proved through Moss's client; history replay and a near-limit OpenCode conversation | 1, 2 |
| Routing by auth method, never to Codex | 10 |
| A 401 names the rejected key, not a CLI sign-in | 10, 14, 16 Step 6 |
| Chat persistence decrypts the key | 11 |
| Same-row key or address change relaunches the session; drop by provider row | 11, 12, 16 Step 4 case G |
| Gate opens for Anthropic and OpenAI-compatible; other kinds get the new error and a 400 | 12 |
| Readiness: agent installed plus `/v1/models`, cached by id plus update time | 13, 14 |
| Discovery and the key test use the launch address normalizer and one model id policy; chat models only | 4, 5 |
| OpenAI-compatible bounded to Chat Completions | Global Constraints, 16 Step 2 |
| UI proof cases A to G for both agents | 16 Steps 4-5 |
| App map, ADR 0003, release note, live-path proof | 15, 16 |
| Dev-instance seeding | seeding plan, Tasks 17-18 |
| UAT | seeding plan, Tasks 19-21 |

### Deviations from the spec, found in the code

- Readiness uses the sidecar's installed-tools report, not `probeProvider`, which has no API-key mode (Task 13).
- The model travels with the credential, and the claude agent gets `ANTHROPIC_MODEL` at spawn. This answers the spec's open question (Task 9).
- The add form labels the field "Base URL", not "Address" (Tasks 6 and 16).
- The confirmation-card proof sits in phase 3, where chat first works (Task 16).
- The key-test route also hardcoded the Anthropic address (Task 5).
- The structured adapter already honoured an address but did not strip `/v1` (Task 4).
- `acp-host.ts` is at 997 lines, so its logic moves into helper files (Tasks 7-9).
- Workshop OpenCode spawns also clear the provider entry (Task 9).
- Chat persistence had no secret cipher (Task 11).
- The prompt-time auth mapping is a second site (Task 10).
- Agent error output is logged in chunks, so it needs a mask that holds back a possible key start across chunks (Task 9). Launch errors carry agent text too, so they get the same mask (Task 10).
- The provider row's `updated_at` changes on status and default saves, so the launch revision hashes kind, address and sealed key instead (Task 11).
- Provider saves did not reach live chat sessions; the drop seam gains a by-row target (Task 12).
- Discovery built its own URLs and Anthropic discovery kept only "claude-" ids, so a proxy's ids were lost (Task 5).
- Non-ACP chat factories refuse API-key rows (Task 10).
- `ai-api.ts` is at 984 lines, so the readiness contract gets its own file (Task 13).

### Placeholder scan

No "TBD", "TODO" or "similar to Task N". Task 16's `<dev-instance log directory>` and `<dev-instance agent homes>` are filled from the dev-instance start output on the day, because those paths include the runner's home.

### Type consistency

- `RpcAcpSpawnCredential { baseUrl, apiKey, model }`: Tasks 7, 9, 10, 11, 12.
- `ChatCredential { apiKey, baseUrl, revision }` and `providerLaunchRevision`: Tasks 11 and 12.
- `providerConfigRevision` on the active provider: Tasks 11 (produces) and 12 (compares).
- `PROVIDER_MODEL_ID_PATTERN`: Tasks 4 (defines), 5 and 7 (import), 8 (mirrors in `.mjs`).
- `createStreamRedactor` and `logRedactedStderr`: Task 9. `maskedLaunchError`: Task 10.
- `ChatSessionDropTarget` and `dropChatSessionsForProviderConfig`: Task 12.
- `ApiKeyChatReadinessStatus` values: Tasks 13 and 14 use the same six.
- `providerBaseUrl(kind, stored)`: Tasks 4, 5, 9, 13.
- `discoveredModelIds`: seeding plan Task 18.
- `API_KEY_REJECTED_MESSAGE`, `API_KEY_UNREADABLE_MESSAGE`: Tasks 10, 12, 16.
