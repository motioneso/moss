# API-key Providers Drive Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin pick an Anthropic or OpenAI-compatible API-key provider (including one at a custom address, such as a local proxy) as the chat provider, and have the chat drawer work through the existing agent programs with tools and confirmation cards.

**Architecture:** Chat keeps its one engine (ACP over the cli-runner sidecar). The app decrypts the API key at chat launch and sends it, with the row's address and model, on the `acpSpawn` RPC. The sidecar puts it in the agent's process env only: `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` for the claude agent, or a Moss-named variable referenced from a provider entry in `opencode.json` for OpenCode. Readiness for API-key rows is the app's own `/v1/models` call plus the sidecar's installed-tools report.

**Tech Stack:** TypeScript (strict), Node 24, Fastify, React with TanStack Query, Vitest, pnpm workspaces (`@moss/*` packages), ACP adapters pinned in `packages/cli-runner/package.json` (`@agentclientprotocol/claude-agent-acp` 0.75.1, `opencode-ai` 1.18.29).

**Spec:** `docs/superpowers/specs/2026-10-10-api-key-chat-design.md` (approved 2026-10-10). Task issue: #3410. Phases 4 and 5 (dev-instance seeding, UAT) are in `docs/superpowers/plans/2026-10-10-api-key-chat-seeding.md`.

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
- The key must never appear in any process argv, in api or cli-runner logs, in RPC error messages, in pg-boss payloads, in anything sent to the browser, or in `opencode.json`. CLI-row spawns carry no API-key variables. Each of these has a test that is observed failing with its protection removed ("removal step").
- Chat, status updates, PR text and handoff docs are plain English for a non-engineer reader: name things by what they do, at most one code-formatted name per sentence, plain ASCII punctuation, no invented shorthand. Pass this instruction on to every agent you spawn. Commit messages and code comments stay precise and technical.

## Review Focus

1. An address saved with a trailing slash or a trailing `/v1` (people paste either). Expect the same requests as the bare address, never `/v1/v1/...`. Pinned in Task 4 (`providerBaseUrl` cases) and Task 9 (OpenCode entry gets exactly one `/v1`).
2. An API-key row whose key is missing, revoked or cannot be decrypted (secret key rotated). Expect chat to refuse with one fixed message before any thread or engine work, and no error text containing key material. Pinned in Task 11 (`openChatCredential` returns null on every failure) and Task 12 (launch refuses before `openNewConversation`).
3. Switching from an API-key OpenAI-compatible row to an OpenCode CLI row. Expect the old provider entry gone from `opencode.json` before the CLI agent starts. Pinned in Task 8 (script removes the entry) and Task 9 (every OpenCode spawn sends a removal).
4. A key the provider rejects mid-chat. Expect the fixed "provider rejected the API key" message, and no CLI login rejection recorded (which would mark an unrelated CLI login bad). Pinned in Task 10.
5. Model ids containing `/`, `:` or `@` (common on proxies and routers). Expect them accepted on the RPC and written into the entry unchanged. Pinned in Task 7 and Task 8.

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

Never `cat` the key file, and never pass the key on a command line. The harness and the checks below read it from the file.

### Task 1: Prove the claude agent answers through the proxy

**Files:**
- Create (not committed): `/tmp/acp-proof/acp-proof.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the go/no-go facts for Task 3, and the value of `$PROXY_ANTHROPIC_MODEL`.

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
child.stderr.on("data", (chunk) => process.stderr.write(mask(chunk)));
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
- `MODEL_SET <id>` with no error. This is the `setModelForChat` proof.
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

Start a slow prompt in the background and check every process's argv while it runs, then search the agent home after it ends.

```bash
node /tmp/acp-proof/acp-proof.mjs claude "$PROXY_ANTHROPIC_MODEL" \
  'Count slowly from one to forty, one number per line.' > /tmp/acp-proof/run.log 2>&1 &
sleep 5
KEY_TAIL=$(tr -d '\n' < "$PROOF_KEY_FILE" | tail -c 8)
for pid in $(pgrep -u "$(id -u)"); do
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$KEY_TAIL" && echo "ARGV_HIT $pid"
done; echo ARGV_DONE
wait
grep -rlF -- "$KEY_TAIL" "$PROOF_HOME" && echo FOUND || echo CLEAN
grep -cF -- "$KEY_TAIL" /tmp/acp-proof/run.log
unset KEY_TAIL
```

Expected: `ARGV_DONE` with no `ARGV_HIT`, `CLEAN`, and `0`. A `FOUND` names the file holding a key fragment (the spec's open risk about the claude CLI config); stop and report the file name only, never its content.

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
KEY_TAIL=$(tr -d '\n' < "$PROOF_KEY_FILE" | tail -c 8)
grep -cF -- "$KEY_TAIL" "$PROOF_HOME/.config/opencode/opencode.json"   # expect 0
grep -c '{env:MOSS_OPENCODE_API_KEY}' "$PROOF_HOME/.config/opencode/opencode.json"   # expect 1
unset KEY_TAIL
```

Record the wrong-key error shape. OpenCode may report it as a prompt error rather than auth-required; record exactly what it is.

### Task 3: Record go or no-go on the task issue

**Files:** none.

- [ ] **Step 1: Post the results**

Write a plain-English comment on #3410 covering, for each agent: answered through the proxy (yes/no), model choice accepted (and whether `ANTHROPIC_MODEL` was needed), tool call worked, wrong-key error shape, argv clean, agent home clean. Say that a Moss tool call with its confirmation card is proved later, in Task 16, because the harness has no Moss tool server. Never include the proxy address, key, or model ids that reveal a private setup.

```bash
gh issue comment 3410 --body-file /tmp/acp-proof/results.md
rm -rf /tmp/acp-proof /tmp/acp-proof-home.*
```

- [ ] **Step 2: Decide**

All proofs pass: continue to Phase 1. Any proof fails: stop and wait for Ben.

---
## Phase 1: Anthropic address and the add entry (gates stay shut)

### Task 4: One normalizer for provider addresses, used by the Anthropic HTTP adapters

**Files:**
- Create: `packages/ai/src/provider-base-url.ts`
- Modify: `packages/ai/src/index.ts` (add the export)
- Modify: `packages/ai/src/adapters/http-api.ts:223` (anthropic `buildRequest` url)
- Modify: `packages/ai/src/adapters/http-api-structured.ts:127`
- Test: `tests/unit/ai-provider-base-url.test.ts` (create), `tests/unit/ai-http-api.test.ts`, `tests/unit/ai-http-api-structured.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com"`, `OPENAI_DEFAULT_BASE_URL = "https://api.openai.com"`
  - `type BaseUrlProviderKind = "anthropic" | "openai-compatible"`
  - `providerBaseUrl(kind: BaseUrlProviderKind, stored: string | null | undefined): string` returns the address with no trailing slash and no trailing `/v1`, or the kind's default when the stored value is empty. Exported from `@moss/ai`.

- [ ] **Step 1: Write the failing normalizer test**

`tests/unit/ai-provider-base-url.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
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
```

- [ ] **Step 6: Run them and watch the first fail**

Run: `pnpm test:unit tests/unit/ai-http-api.test.ts` then `pnpm test:unit tests/unit/ai-http-api-structured.test.ts`
Expected: the adapter test FAILS (url is `https://api.anthropic.com/v1/messages`). The structured test FAILS (`http://proxy.test/v1//v1/messages`).

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

- [ ] **Step 8: Run all three files and watch them pass**

Run each: `pnpm test:unit tests/unit/ai-provider-base-url.test.ts`, `pnpm test:unit tests/unit/ai-http-api.test.ts`, `pnpm test:unit tests/unit/ai-http-api-structured.test.ts`
Expected: PASS. The existing default-address assertions still pass.

- [ ] **Step 9: Commit**

```bash
git add packages/ai/src/provider-base-url.ts packages/ai/src/index.ts \
  packages/ai/src/adapters/http-api.ts packages/ai/src/adapters/http-api-structured.ts \
  tests/unit/ai-provider-base-url.test.ts tests/unit/ai-http-api.test.ts \
  tests/unit/ai-http-api-structured.test.ts
git commit -m "feat(ai): honour the Anthropic row's base URL in HTTP adapters (#3410)"
```

### Task 5: Model discovery and key test use the Anthropic address; fixed messages become constants

**Files:**
- Modify: `packages/ai/src/model-discovery.ts:199` (`doFetch` anthropic case)
- Modify: `packages/ai/src/provider-validation.ts:34,50,60,97,111` and `:150` (`fetchModels` anthropic case)
- Test: `tests/unit/ai-model-discovery.test.ts`, `tests/unit/ai-provider-validation.test.ts`

**Interfaces:**
- Consumes: `providerBaseUrl` (Task 4).
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

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test:unit tests/unit/ai-provider-validation.test.ts` then `pnpm test:unit tests/unit/ai-model-discovery.test.ts`
Expected: FAIL. The imports of the new constants are undefined and the urls are the public address.

- [ ] **Step 3: Implement**

`packages/ai/src/model-discovery.ts`: add `import { providerBaseUrl } from "./provider-base-url.js";` after line 9, and in `doFetch` replace

```ts
      return f("https://api.anthropic.com/v1/models", {
```

with

```ts
      return f(`${providerBaseUrl("anthropic", input.baseUrl)}/v1/models`, {
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

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm test:unit tests/unit/ai-provider-validation.test.ts` then `pnpm test:unit tests/unit/ai-model-discovery.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/model-discovery.ts packages/ai/src/provider-validation.ts \
  tests/unit/ai-model-discovery.test.ts tests/unit/ai-provider-validation.test.ts
git commit -m "feat(ai): list and test Anthropic API-key models at the row's base URL (#3410)"
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
- Consumes: nothing.
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

  it.each([
    ["a credential on a workshop spawn", "anthropic", "workshop", credential],
    ["a credential for Codex", "openai", "chat", credential],
    ["an extra field", "anthropic", "chat", { ...credential, extra: "x" }],
    ["a key with a space", "anthropic", "chat", { ...credential, apiKey: "sk-test never-echo-0001" }],
    ["a non-http address", "anthropic", "chat", { ...credential, baseUrl: "file:///sk-test-never-echo-0001" }],
    ["a model with a space", "anthropic", "chat", { ...credential, model: "a b sk-test-never-echo-0001" }]
  ])("refuses %s without echoing any value (stays open)", async (_label, providerKind, profile, value) => {
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
    expect(JSON.stringify(frames)).not.toContain("sk-test-never-echo-0001");
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
const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,200}$/;

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
  if (typeof model !== "string" || !MODEL_ID.test(model)) {
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
Expected: FAIL on "a key with a space" (`not.toContain("sk-test-never-echo-0001")`). Revert the change and run again: PASS.

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
- Modify: `packages/cli-runner/src/acp-host.ts` (imports at `:14`, `:70`, `:79`; the token block in `spawn` at about `:377-380`; the prepare call; the stderr line at about `:586`; delete `readLoginToken` at about `:989-997`)
- Test: `tests/unit/cli-runner-acp-host-api-key.test.ts` (create); `tests/unit/cli-runner-acp-host.test.ts` (run only)

**Interfaces:**
- Consumes: `RpcAcpSpawnCredential` and the seventh `spawn` parameter (Task 7); `MOSS_OPENCODE_PROVIDER_ID`, `MOSS_OPENCODE_API_KEY_ENV`, `AgentHomeOpencodeProvider`, `AgentHomePrepareRequest.opencodeProvider` (Task 8); `providerBaseUrl` (Task 4); `redactExact(text, secret)` (already exported from `@moss/ai`).
- Produces:
  - `type AcpCredential = RpcAcpSpawnCredential`
  - `applyAgentCredential(env: NodeJS.ProcessEnv, launch: AgentCredentialLaunch): Promise<AgentHomeOpencodeProvider | undefined>`
  - Agent env for an API-key claude spawn: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and `ANTHROPIC_BASE_URL` only when the row has an address. No `CLAUDE_CODE_OAUTH_TOKEN`.
  - Agent env for an API-key OpenCode spawn: `MOSS_OPENCODE_API_KEY`. The settings entry gets the address with exactly one `/v1`.
  - Every OpenCode spawn without a credential (chat or workshop) asks the preparation step to remove the Moss entry.

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
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit tests/unit/cli-runner-acp-host-api-key.test.ts`
Expected: FAIL. The claude case has no `ANTHROPIC_API_KEY`, the OpenCode cases have no `opencodeProvider`, and the stderr case logs the key. The server-level case already passes, because the sanitizer drops those variables; it stays as a guard.

- [ ] **Step 3: Write the helper**

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
3. Line 79: `import { redactSecrets } from "@moss/ai";` becomes `import { redactExact, redactSecrets } from "@moss/ai";`.
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

9. In the `child.stderr.on("data", ...)` handler, replace the `text` line with

```ts
      const text = redactSecrets(
        redactExact(chunk.toString("utf8"), credential?.apiKey)
      ).slice(-2000);
```

10. Delete the whole `private async readLoginToken(homeBase: string)` method at the end of the class.

Then run `wc -l packages/cli-runner/src/acp-host.ts`. Expected: about 993, and never over 1000.

The per-key mask works per chunk. A key split across two stderr chunks could reach the log in two halves. Adapter error lines are short and arrive whole in practice; note this limit in the PR body rather than buffering stderr.

- [ ] **Step 5: Run the new tests and the existing host tests**

Run: `pnpm test:unit tests/unit/cli-runner-acp-host-api-key.test.ts`
Expected: PASS.
Run: `pnpm test:unit tests/unit/cli-runner-acp-host.test.ts`
Expected: PASS. The "passes the Claude token to Claude alone" test still proves the CLI token path.

- [ ] **Step 6: Removal steps (each protection is observed failing)**

Make each change alone, run `pnpm test:unit tests/unit/cli-runner-acp-host-api-key.test.ts`, see the named test fail, then undo it.

| Temporary change | Test that must fail |
| --- | --- |
| In `applyAgentCredential`, add `apiKey: credential.apiKey` to the OpenCode `entry` object (cast as needed) | "writes an OpenCode entry with one /v1..." |
| In `acp-host.ts`, build `env` from `...process.env` instead of `...buildSanitizedCliEnv(process.env)` | "keeps server-level key variables away..." |
| In `applyAgentCredential`, read the login token before the `if (credential)` check and always set `CLAUDE_CODE_OAUTH_TOKEN` | "gives the claude agent the row's address..." |
| In the stderr handler, drop the `redactExact(...)` wrapper | "masks the key in the adapter's logged error output" |
| In `applyAgentCredential`, return `undefined` for OpenCode when there is no credential | "removes the OpenCode entry on every CLI-login OpenCode spawn..." |

To prove the key never reaches the command line, temporarily change `args: target.args` in the `spawnChild({...})` call to `args: [...target.args, credential?.apiKey ?? ""]`. The first test must fail. Undo it.

- [ ] **Step 7: Commit**

```bash
git add packages/cli-runner/src/acp-launch-credential.ts packages/cli-runner/src/acp-host.ts \
  tests/unit/cli-runner-acp-host-api-key.test.ts
git commit -m "feat(cli-runner): launch chat agents with an API-key credential (#3410)"
```

### Task 10: The chat engine routes API-key rows and names a rejected key

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
  - `new RpcAcpTunnel(connection, sessionKey, { useCandidate?, credential?: RpcAcpSpawnCredential })`
  - `ChatEngineFactory` opts gain `authMethod?: AiAuthMethod` and `credential?: RpcAcpSpawnCredential`. Only the ACP chat factory accepts `authMethod: "api_key"`; the other two refuse it.

An API-key auth failure carries no `cause`. The cause holds the agent's own error text, which can echo request details, and the live route logs causes.

- [ ] **Step 1: Write the failing engine tests**

In `packages/chat/src/live/acp-chat-engine.test.ts`, extend the `./acp-chat-engine.js` import with `RpcAcpTunnel`, and add:

```ts
import { API_KEY_REJECTED_MESSAGE } from "./auth-errors.js";
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import { CliChatUnavailableError } from "./errors.js";
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
Expected: FAIL to compile or run, because `authMethod` and `credential` are unknown options and the messages do not exist.
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
```

Leave the rest of that object as it is. Run `wc -l packages/chat/src/live/runtime.ts` (must stay at or under 1000; expected about 965).

- [ ] **Step 7: Run the tests and watch them pass**

Run: `pnpm test:unit packages/chat/src/live/acp-chat-engine.test.ts`
Run: `pnpm test:unit tests/unit/chat-runtime-selection.test.ts`
Run: `pnpm test:unit tests/unit/chat-auth-remediation-routes.test.ts`
Expected: PASS for all three.

- [ ] **Step 8: Removal step (a rejected key never marks a CLI login rejected)**

Temporarily delete the `if (this.opts.authMethod === "api_key") { ... }` block in `authFailure`.
Run: `pnpm test:unit packages/chat/src/live/acp-chat-engine.test.ts`
Expected: FAIL on "names the key, not a CLI sign-in..." (`loginRejected` called, wrong message) and on "names the key when an OpenCode API-key launch is refused". Restore the block and run again: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/chat/src/live/auth-errors.ts packages/chat/src/live/acp-chat-engine.ts \
  packages/chat/src/live/acp-chat-engine.test.ts packages/chat/src/live/runtime.ts \
  tests/unit/chat-runtime-selection.test.ts tests/unit/chat-auth-remediation-routes.test.ts
git commit -m "feat(chat): route API-key rows to their agent and name a rejected key (#3410)"
```

### Task 11: Chat persistence decrypts the row's key and picks the OpenCode model value

**Files:**
- Create: `packages/chat/src/live/api-key-launch.ts`
- Modify: `packages/chat/src/live/persistence.ts` (import at `:11`, deps at `:71-85`, constructor at `:165-174`, `resolveActiveProvider` at `:176-213`)
- Modify: `packages/chat/src/live/chat-session-ports.ts:39-50` (`ChatPersistencePort`)
- Modify: `packages/chat/src/live/runtime.ts:13-19` (import) and `:645-654` (persistence wiring)
- Test: `tests/unit/chat-api-key-launch.test.ts` (create)

**Interfaces:**
- Consumes: `MOSS_OPENCODE_PROVIDER_ID` (Task 8).
- Produces:
  - `interface ChatCredential { readonly apiKey: string; readonly baseUrl: string | null }`
  - `chatAcpModel(row: ChatModelRow, savedOpenCodeModel: string | null | undefined): string | undefined`. An API-key OpenAI-compatible row gives `"moss/<row model id>"`; other API-key rows give `undefined`; CLI OpenCode rows keep the saved choice.
  - `openChatCredential(row, cipher): ChatCredential | null`. It returns `null` for a missing row or cipher, a non-API-key row, a row that is not active, a revoked row, a row with no stored key, or any failure to decrypt or parse.
  - `DataContextChatPersistence.resolveChatCredential(actorUserId: string, providerConfigId: string): Promise<ChatCredential | null>`
  - `ChatPersistencePort.resolveChatCredential?(actorUserId: string, providerConfigId: string): Promise<ChatCredential | null>`
  - `DataContextChatPersistenceDeps.resolveAiSecretCipher?: () => AiSecretCipher`

Meeting chat already decrypts provider keys inside the user's data context (`packages/chat/src/live/meeting-chat-runtime.ts:73`); this follows the same path.

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

import { chatAcpModel, openChatCredential } from "../../packages/chat/src/live/api-key-launch.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

const KEY = "sk-test-never-echo-0003";
const cipher = createAiSecretCipher();

function sealed(overrides: Partial<AiProviderWithSealedCredential> = {}) {
  return {
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
  it("returns the trimmed key and the row's address", () => {
    expect(openChatCredential(sealed(), cipher)).toEqual({ apiKey: KEY, baseUrl: "http://proxy.test" });
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
      baseUrl: "http://proxy.test"
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

  it("gives an API-key OpenAI-compatible row the Moss OpenCode model value", async () => {
    const { persistence, ai } = fixture(() => cipher);
    vi.spyOn(ai, "selectChatModelForUser").mockResolvedValue({
      ...apiKeyRow,
      provider_config_id: "provider-1"
    } as unknown as AiConfiguredModelSafeRow);
    await expect(persistence.resolveActiveProvider("user-1")).resolves.toMatchObject({
      provider: "openai-compatible",
      model: "org/model:tag@v2",
      authMethod: "api_key",
      acpModel: "moss/org/model:tag@v2"
    });
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
}

export interface ChatModelRow {
  readonly provider_kind: string;
  readonly provider_auth_method: AiAuthMethod;
  readonly provider_acp_agent_id: string | null;
  readonly provider_model_id: string;
}

type SealedChatProvider = Pick<
  AiProviderWithSealedCredential,
  "auth_method" | "status" | "revoked_at" | "has_credential" | "base_url" | "encrypted_credential"
>;

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
    return parsed ? { apiKey: parsed.apiKey, baseUrl: row.base_url } : null;
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
import { chatAcpModel, openChatCredential, type ChatCredential } from "./api-key-launch.js";
```

2. In `DataContextChatPersistenceDeps`, after `chatPreferences?`, add:

```ts
  /** Builds the cipher that opens API-key provider credentials for chat launches. */
  readonly resolveAiSecretCipher?: () => AiSecretCipher;
```

3. Add the field `private readonly resolveAiSecretCipher: (() => AiSecretCipher) | undefined;` next to the other fields, and `this.resolveAiSecretCipher = deps.resolveAiSecretCipher;` at the end of the constructor.

4. In `resolveActiveProvider`, replace the returned object with:

```ts
    const provider = toLiveProvider(model);
    const acpModel = chatAcpModel(model, openCodeModel);
    return {
      provider,
      model: model.provider_model_id,
      providerConfigId: model.provider_config_id,
      authMethod: model.provider_auth_method,
      acpAgentId: model.provider_acp_agent_id,
      ...(acpModel ? { acpModel } : {})
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

In `packages/chat/src/live/chat-session-ports.ts`, add `import type { ChatCredential } from "./api-key-launch.js";` with the other local imports, and inside `ChatPersistencePort`, after `resolveActiveProvider`, add:

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

- [ ] **Step 6: Removal step (a decryption failure never escapes)**

Temporarily replace the `try { ... } catch { return null; }` in `openChatCredential` with its body alone.
Run: `pnpm test:unit tests/unit/chat-api-key-launch.test.ts`
Expected: FAIL on "returns null, and throws nothing, when the key cannot be decrypted", with an error that names the key. Restore the `try` and run again: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/chat/src/live/api-key-launch.ts packages/chat/src/live/persistence.ts \
  packages/chat/src/live/chat-session-ports.ts packages/chat/src/live/runtime.ts \
  tests/unit/chat-api-key-launch.test.ts
git commit -m "feat(chat): read the API-key chat credential inside the user's data context (#3410)"
```

## Phase 3: Open the gates, readiness, docs and the live proof

### Task 12: Chat accepts Anthropic and OpenAI-compatible API-key rows

**Files:**
- Modify: `packages/chat/src/live/errors.ts:138-146` (replace the old refusal)
- Modify: `packages/chat/src/live/chat-session-provider-identity.ts:1-11` (imports) and `:55-60` (the gate); add `resolveApiKeyLaunchCredential`
- Modify: `packages/chat/src/live/chat-session-launch.ts:11-16`, `:56-57`, `:81-90`
- Modify: `packages/chat/src/live/persistence.ts:55` and `toLiveProvider` at about `:660`
- Modify: `packages/chat/src/live/chat-session-manager.ts:28` and `:313-317`
- Modify: `packages/chat/src/live-routes.ts:58-59` and `:766-768`
- Test: `tests/unit/chat-session-manager-provider-identity.test.ts`, `tests/unit/chat-auth-remediation-routes.test.ts`, `tests/unit/chat-api-key-launch.test.ts`

**Interfaces:**
- Consumes: `API_KEY_UNREADABLE_MESSAGE` and the factory's `authMethod` and `credential` options (Task 10); `ChatPersistencePort.resolveChatCredential` (Task 11).
- Produces:
  - `UNSUPPORTED_API_KEY_CHAT_PROVIDER_MESSAGE = "Chat supports API-key providers of type Anthropic or OpenAI-compatible. Choose one of those, or a CLI provider, in Admin > AI providers."` and `class UnsupportedApiKeyChatProviderError extends CliChatUnavailableError` (live route: 400 with that message).
  - `class ApiKeyUnreadableError extends CliChatUnavailableError` with `API_KEY_UNREADABLE_MESSAGE` (live route: 503 with that message, through the existing auth allowlist).
  - `assertLiveChatProvider(provider: ActiveChatProvider): void` replaces `assertLiveCliProvider`.
  - `resolveApiKeyLaunchCredential(actorUserId: string, provider: ActiveChatProvider, persistence: ChatPersistencePort): Promise<RpcAcpSpawnCredential | undefined>`
  - `ApiKeyLiveChatUnavailableError` and `API_KEY_LIVE_CHAT_UNAVAILABLE_MESSAGE` no longer exist.

The key is read before the launch opens or creates a conversation, so an unreadable key leaves no empty conversation behind.

- [ ] **Step 1: Rewrite the manager tests**

In `tests/unit/chat-session-manager-provider-identity.test.ts`, change the errors import to:

```ts
import {
  ApiKeyUnreadableError,
  UnsupportedApiKeyChatProviderError
} from "../../packages/chat/src/live/errors.js";
```

Replace the first test ("rejects API-key live chat before creating or launching an engine") with:

```ts
  const KEY = "sk-test-never-echo-0004";
  const apiKeyProvider = {
    provider: "anthropic",
    model: "claude-test-model",
    providerConfigId: "provider-1",
    authMethod: "api_key",
    acpAgentId: null
  } as const;

  function apiKeyManager(credential: { apiKey: string; baseUrl: string | null } | null) {
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
      baseUrl: "http://proxy.test"
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
      const { manager, engine, persistence } = apiKeyManager({ apiKey: KEY, baseUrl: null });
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
Expected: FAIL, the new error classes do not exist yet.

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
  return { apiKey: opened.apiKey, baseUrl: opened.baseUrl, model: provider.model };
}
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

- [ ] **Step 7: Removal steps**

| Temporary change | Test that must fail |
| --- | --- |
| In `chat-session-launch.ts`, move the `resolveApiKeyLaunchCredential` call to just before `deps.engineFactory(...)` | "refuses an API-key row whose key cannot be read..." (`openNewConversation` was called) |
| In `chat-session-launch.ts`, add `console.info("[chat] launch", credential);` after the credential is resolved | "keeps the key out of logs, stored calls and the agent's input" |
| In `assertLiveChatProvider`, replace the kind check with a bare `return;` | "evicts a cached CLI engine when the provider changes to an unsupported API-key kind" |

Run `pnpm test:unit tests/unit/chat-session-manager-provider-identity.test.ts` after each, see the named test fail, then undo it.

- [ ] **Step 8: Commit**

```bash
git add packages/chat/src/live/errors.ts packages/chat/src/live/chat-session-provider-identity.ts \
  packages/chat/src/live/chat-session-launch.ts packages/chat/src/live/persistence.ts \
  packages/chat/src/live/chat-session-manager.ts packages/chat/src/live-routes.ts \
  tests/unit/chat-session-manager-provider-identity.test.ts \
  tests/unit/chat-auth-remediation-routes.test.ts tests/unit/chat-api-key-launch.test.ts
git commit -m "feat(chat): open live chat to Anthropic and OpenAI-compatible API-key rows (#3410)"
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

This task needs a person or agent with the proxy on the host. It uses `$PROXY_URL`, `$PROXY_KEY_FILE`, `$PROXY_ANTHROPIC_MODEL` and `$PROXY_OPENAI_MODEL` from the shell. Never print the key or the key file. `KEY_TAIL` is the last 6 characters of the key, used only to search for leaks.

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
Description: Admins can pick an Anthropic or OpenAI-compatible provider that uses an API key, including one at its own web address, and chat works with it the same way, tools and confirmation cards included.
```

Also add a "Known limits" line to the PR body. The sidecar masks the key in agent error output one chunk at a time, so a key split across two chunks of error output would not be masked. Agents do not print their key, so this is a narrow gap, but say so.

- [ ] **Step 3: Start a dev instance with this branch**

Start a dev instance the usual way (`scripts/dev-instance`, CLI defaults). Claim its web port with `devports claim <your-agent-name>`. The cli-runner runs on the host, so agents reach `$PROXY_URL` directly.

- [ ] **Step 4: Prove the claude agent path through the UI**

Through the real UI, signed in as the dev admin:

1. Settings, AI providers, Add, "Anthropic (API key)". Put `$PROXY_URL` in "Base URL" and the key from `$PROXY_KEY_FILE` in the key field. Save.
2. Refresh models on the new card. Expect the list to contain `$PROXY_ANTHROPIC_MODEL`. Turn on chat for it and make the row the default.
3. Expect no status line under the card's models (readiness is "ready").
4. Open the chat drawer and ask a question that makes the agent call a Moss write tool (for example, "Add a task called Ada's test task"). Expect a confirmation card. Approve it. Expect the task to exist on the Tasks screen.
5. Record bounded evidence: the request id from the api log for that chat turn, the tool name from the confirmation, and the task row from the UI as text.

- [ ] **Step 5: Prove the OpenCode path through the UI**

Repeat Step 4 with Add, "OpenAI-compatible", `$PROXY_URL` as "Base URL", the same key, and `$PROXY_OPENAI_MODEL` as the chat model. Expect the same confirmation card and result.

- [ ] **Step 6: Prove a wrong key is named, not mistaken for a sign-in problem**

Edit the Anthropic row and save a wrong key. Expect the card to read "The provider rejected the API key". Send a chat message and expect "The provider rejected the API key. An admin can check it under Settings, AI providers." Expect no CLI sign-in prompt. Put the right key back.

- [ ] **Step 7: Search for the key**

With both agents having chatted, search everything the key must not reach. The two `grep -rl` commands must print nothing; they print file names only, never matching lines.

```bash
KEY_TAIL="$(tr -d '\n' < "$PROXY_KEY_FILE" | tail -c 6)"
ps -eo args | grep -cF -- "$KEY_TAIL"          # expect 1 (the grep itself), never more
grep -rlF -- "$KEY_TAIL" <dev-instance log directory>
grep -rlF -- "$KEY_TAIL" <dev-instance agent homes>
unset KEY_TAIL
```

Use the dev instance's log and agent-home directories as printed by `scripts/dev-instance` at start. `ps` covers process argv; the agent homes include `.config/opencode/opencode.json`. Report only "no matches" or the file names that matched, never the matching lines.

- [ ] **Step 8: Post the proof**

Post one `gh pr comment` on the implementation PR with:

- what ran: dev instance from this branch, both agents, through the real UI
- the bounded evidence from Steps 4-7 (request ids, tool names, task titles, "no matches")
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
| Key never in argv, logs, RPC errors, browser or `opencode.json` | 7, 9, 12, 13 (removal steps), 16 Step 7 |
| Routing by auth method, never to Codex | 10 |
| A 401 names the rejected key, not a CLI sign-in | 10, 14, 16 Step 6 |
| Chat persistence decrypts the key | 11 |
| Gate opens for Anthropic and OpenAI-compatible; other kinds get the new error and a 400 | 12 |
| Readiness: agent installed plus `/v1/models`, cached by id plus update time | 13, 14 |
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
- Agent error output is logged, so it needs a per-key mask, with the chunk-split limit noted (Tasks 9 and 16).
- Non-ACP chat factories refuse API-key rows (Task 10).
- `ai-api.ts` is at 984 lines, so the readiness contract gets its own file (Task 13).

### Placeholder scan

No "TBD", "TODO" or "similar to Task N". Task 16's `<dev-instance log directory>` and `<dev-instance agent homes>` are filled from the dev-instance start output on the day, because those paths include the runner's home.

### Type consistency

- `RpcAcpSpawnCredential { baseUrl, apiKey, model }`: Tasks 7, 9, 10, 11, 12.
- `ApiKeyChatReadinessStatus` values: Tasks 13 and 14 use the same six.
- `providerBaseUrl(kind, stored)`: Tasks 4, 5, 9, 13.
- `API_KEY_REJECTED_MESSAGE`, `API_KEY_UNREADABLE_MESSAGE`: Tasks 10, 12, 16.
