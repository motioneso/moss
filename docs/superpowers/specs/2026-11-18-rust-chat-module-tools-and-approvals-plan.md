# Rust chat: module tools and approval cards — plan

- Task: JS-357 (board card 219)
- Date: 2026-11-18
- Status: plan, no code
- Unblocks: Commitments part 9 live chat proof (JS-356, PR 4378) and every merged module's chat
  tools (Scratchpad 2, News 7, Sports 14b, Wellness 16, Briefings 21 and others)
- Builds on: `2026-11-08-rust-phase3-report.md` (part 2 items 2 and 6),
  `2026-11-07-rust-module-packages-and-registry-design.md` (tools and action-policy ports)
- Format model: `2026-11-13-rust-phase5-news-sports-weather-plan.md` §7 and §8

## 1. Problem

| Gap                      | Today                                                                                                             | Evidence                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module tools never seen  | The runner offers one built-in time tool                                                                          | `rust-spike/agents/src/bin/moss-runner.rs:73-101`                                                                                                           |
| Approvals always refused | The server answers every approval event with `allow:false` and appends "Approvals are not in this window yet"     | `rust-spike/shell/app/src/runner_data.rs:4`, about `:113`                                                                                                   |
| One account per runner   | Runner config holds a single `account`; any other gets "This runner has no agent for that account."               | `moss-runner.rs:45` (`Config.account`), `:188-189` (owner check)                                                                                            |
| Global tool list         | `ToolHost::tools(&self)` takes no account                                                                         | `rust-spike/agents/src/gateway.rs` trait `ToolHost`                                                                                                         |
| No input schemas         | Manifest `Tool` is `{description, risk, approvalVersion}` with `deny_unknown_fields`; no module declares a schema | `rust-spike/module-host/src/manifest.rs:197`                                                                                                                |
| Card builders unused     | Several modules have card-preparing code, each with its own shape; nothing in the chat path calls it              | e.g. `modules/news/src/approval.rs:28`, `modules/scratchpad/src/tools.rs:52`, `modules/commitments/src/tools.rs:148`, `modules/memory/src/lifecycle.rs:161` |
| Blocking chat request    | `POST /api/chat/messages` waits in `spawn_blocking` for the whole turn                                            | `rust-spike/shell/app/src/main.rs:110-115`                                                                                                                  |

## 2. Seams check

Every capability the plan relies on, with where it exists today. Anything absent is listed as new
work in a part, never assumed.

| Capability                                                                                | Exists | Evidence                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Runner socket, one JSON line each way, hello with secret                                  | yes    | `moss-runner.rs` `Op::{Hello,Chat,Answer}`                                                                                            |
| Approval event and answer round trip                                                      | yes    | `moss-runner.rs` pending map of oneshot senders; no answer = deny                                                                     |
| Per-turn ask slot (late ask refused)                                                      | yes    | `rust-spike/agents/src/runner.rs` `Slot`, `start()` 246-285                                                                           |
| Gateway calls confirm for Confirm / YoloConfirm routes                                    | yes    | `gateway.rs` `call_tool`                                                                                                              |
| Routing policy ported from TypeScript                                                     | yes    | `rust-spike/agents/src/approvals.rs` `resolve_policy`                                                                                 |
| Agent-native permission asks become cards                                                 | yes    | `runner.rs` `approver()` 329-360                                                                                                      |
| MCP `tools/list` maps `input_schema` to `inputSchema`                                     | yes    | `rust-spike/agents/src/bin/moss-tool-gateway.rs`                                                                                      |
| Module `tool` guest handler kind                                                          | yes    | `rust-spike/module-host/src/runtime.rs:240`; every module, e.g. `modules/news` `lib.rs:70`                                            |
| Tool declared + risk fixed at call time                                                   | yes    | `runtime.rs` about `:544`                                                                                                             |
| Callers cannot supply actor, role or database connection                                  | yes    | `runtime.rs` `reject_context`                                                                                                         |
| Grant bound to actor, module, tool, exact parameters, 300 s, single use, optional version | yes    | `rust-spike/module-host/src/services.rs:245` `approve_tool`, `approve_tool_at_version`, `save_tool_approval` `:270` (write at `:284`) |
| Per-person action policy read and write                                                   | yes    | `services.rs` `action-policy` read, `set_action_policy`                                                                               |
| Public call into a module with the caller's access                                        | yes    | `rust-spike/module-host/src/store.rs:608` `Installer::call`, `:621` `call_unfenced`                                                   |
| Module switched off for this account is refused                                           | yes    | `store.rs` about `:640-645`                                                                                                           |
| Installed + enabled filter per account                                                    | yes    | `rust-spike/module-host/src/frame.rs:116` `navigation(access)`                                                                        |
| Credential-exchange replies redacted before a guest sees them                             | yes    | `rust-spike/module-host/src/credentials.rs:435` `sanitize_with`, called at `:174` and `:255` only                                     |
| Redaction of tool results, cards and tool lists on the chat path                          | **no** | Part 1                                                                                                                                |
| Tool name grammar (dot parts, lowercase start, `-`, no `_`, max 100)                      | yes    | `rust-spike/module-host/src/tool_names.rs`                                                                                            |
| App-map feature declarations in Rust manifests                                            | yes    | `rust-spike/module-host/src/metadata.rs:49` `Feature`                                                                                 |
| The TypeScript card stylesheet in the Rust app (markup must be ported to Leptos)          | yes    | `rust-spike/shell/README.md:16` (assets copy the current app's CSS unchanged); classes at `apps/web/src/styles/kit-chat.css:700`      |
| Tool input schemas in manifests                                                           | **no** | Part 1                                                                                                                                |
| Card builder link from tool to API                                                        | **no** | Part 1                                                                                                                                |
| Per-account tool list in the runner                                                       | **no** | Part 2a                                                                                                                               |
| Tool calls from runner back to the server                                                 | **no** | Part 2b                                                                                                                               |
| Stored approval records, approve/deny endpoint, async turn                                | **no** | Part 3a                                                                                                                               |
| Drawer approval card                                                                      | **no** | Part 3b                                                                                                                               |

## 3. Decisions

### 3.1 Where tool calls run

- The **server** runs every module tool call. The runner asks the server over the existing socket.
- The runner never holds database credentials or module-host state.
- Each call runs under the `AccessContext` of the turn that started it.

Rejected: embed the module host in the runner. Steelman — one fewer hop, and the runner already
owns the gateway. It loses because the runner would need database credentials and a second copy of
module-host state, which widens where private data and secrets live. The extra hop is one JSON line
on an owner-only socket.

### 3.2 How the runner learns each user's tools

- Every chat op carries the signed-in user's tool list.
- The runner holds the list per account in a slot, like the ask slot, and the gateway's `ToolHost`
  reads it.
- When the list's digest changes, the gateway sends MCP `notifications/tools/list_changed` and
  advertises `tools: {listChanged: true}` at `initialize`. The agent keeps its session.
- Fallback, only if the kill gate (§8) shows the agent ignores the notice: restart the account's
  agent between conversations, never mid-conversation. Agent context lives in the session made by
  `session/new` (`rust-spike/agents/src/acp.rs:57`), so a restart loses it.
- List changes are rare. They follow install, removal or switching a module on or off.
- The runner drops its single-account config. Accounts are keyed by the server-supplied user id.
- The server builds the list from installed, not disabled, account-enabled modules — the same filter
  as `frame.rs:116`.

Wire name: replace `.` with `_` (`scratchpad.append` → `scratchpad_append`). The grammar forbids
`_`, so the mapping reverses exactly. The server refuses duplicates across modules and leaves out any name
whose prefixed form (`mcp__moss__…`) exceeds the agent's limit; part 2 confirms that limit.

Rejected: restart the agent on every list change. Steelman — simplest, and needs nothing from the
agent's MCP client. It loses because a restart drops the conversation (`acp.rs:57`), so it stays
the fallback only.

### 3.3 Input schemas live in the manifest

- Add optional `inputSchema` to manifest `Tool` (`input` is already used by the Finance
  credential-exchange declaration, `modules/finance/moss.module.json:1480`): a JSON Schema in a restricted subset (object, string,
  number, integer, boolean, array, enum, required, maxLength, maxItems, minimum, maximum,
  description, examples).
- The host rejects schemas outside the subset at install.
- The server validates arguments against `inputSchema` before any guest code runs.
- A tool with no `inputSchema` is not offered to the model.
- Order matters. `deny_unknown_fields` means the host change (part 1) must merge before any module
  declares `inputSchema`. Each module part bumps its version.
- Schemas come from the TypeScript zod sources for the same tool.

Rejected: a guest `describe` call returns schemas at runtime. Steelman — manifests stay small and
schemas live beside the handler code. It loses because nothing can validate before invoking the
guest, every chat turn would wake every module's WebAssembly, and install review could not show
what a tool accepts.

### 3.4 Card builder link

- Add optional `card` to manifest `Tool`, naming an API in the same module's `provides`.
- Install refuses a `card` naming a missing API.
- The server calls it with `Installer::call(id, access, "api", payload)`, where `payload` is the
  serialized string `{name, parameters: {tool, parameters}}` (`store.rs:608` takes `&str`).
- Each module adapts its existing card-preparing code to this one input shape in its own part.
  Today's shapes differ (News and Memory take `{tool, inputJson}`, Scratchpad takes raw parameters,
  Commitments takes `{candidateId, action, snoozedUntil}`).
- The server normalizes the reply into `ApprovalCardRecord` (§4.3) and checks sizes.
- No card, a malformed card or a failed call means **deny**.
- Code builds every title, target, label, button and outcome line. The server sets the title from
  fixed text and the target from the module's display name and the tool's manifest description.
  Whatever the card builder returns as its own target (Commitments returns the item title) becomes
  the first field, labelled "Item". Values the model wrote (a recipient, a
  subject, a note body) appear only as labelled field values, taken from the validated parameters
  or the stored record. They never become a title, label or button.
- Agent permission cards take their title from a fixed server table, never from the agent's own
  `title` (`rust-spike/agents/src/runner.rs:348` copies it today). The command or path shows as a
  field value.

### 3.5 When a card is required

From Ben's rulings (§10). Installing a module grants normal use. Deleting, sending outside the
account and version-pinned actions ask. A plain write asks only if the person has switched it to
ask, which is an explicit action policy of `true`. That maps to stored tier `AlwaysConfirm`; an
absent or `false` policy maps to `TrustedAuto`. Chat deliberately differs from the `tools.run`
port, which treats an absent policy as `true` (`services.rs:372-374`).

| Tool                                | Card                                                              | Runner facts                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `risk: read`                        | no                                                                | `Risk::Read`                                                                                                                             |
| `risk: write`, no `approvalVersion` | no, unless the person's action policy for it is explicitly `true` | `Risk::Write`, family `{default TrustedAuto, allowed [TrustedAuto, AlwaysConfirm], stored from explicit policy}`, `execution_auto: true` |
| `approvalVersion: true`             | yes                                                               | `execution_auto: false`                                                                                                                  |
| `risk: destructive`                 | yes                                                               | `Risk::Destructive`                                                                                                                      |
| `risk: outbound` (none today)       | yes                                                               | `Risk::Outbound`                                                                                                                         |

No manifest uses `outbound`. A tool that sends outside the account declares `destructive`, as
`email.sendReply` does (`modules/connectors/moss.module.json:539-542`). Part 4d checks every
sending tool follows this.

- One pure function in module-host decides this: `chat_tool_rule(tool, policy) -> ChatToolRule`.
  It feeds both the facts sent to the runner and the host's grant check, so the two cannot drift.
- The host enforces. It refuses a card-required call that has no matching grant, even if the
  runner said auto-run.
- The server trusts nothing the runner names. Every `tool_call` name and every approval's module
  and tool must be in the list offered to that account for the open turn. Every `call_id` must
  belong to the open turn. Anything else is refused and logged without its arguments.
- `resolve_policy` needs no change. The mapping above reaches the existing branches.
- The module-initiated `tools.run` port keeps its semantics. Its `unwrap_or(true)` default would
  block chat reads, so chat uses its own host function (§4.1).

### 3.6 Approval flow and turn shape

1. Runner emits an approval event with `source` (`moss` or `agent`) and the module id.
2. Server builds the card (§3.4) for a `moss` source, or a permission card from the exact command
   or path for an `agent` source.
3. Server stores a pending record in memory per account, beside the messages (§4.3).
4. Drawer shows the card. The person approves or rejects.
5. Server checks the record belongs to the actor and to the open turn, marks it `approved`, and
   answers the runner `allow:true`. No grant exists yet.
6. The runner resumes and sends the `tool_call`. The server matches it to the approved record by
   turn, module, tool and exact parameters. That record match is the real gate, and §6 tests it.
   The server then calls `run_approved_chat_tool` with the record's shown version. The host mints
   the grant at that version, then checks and consumes it under one `serial_lock` and releases the
   lock before invoking the tool, as `tools.run` does (`services.rs:378-395`). Holding it across the
   invoke would risk a re-entrant deadlock. It forwards `approvalVersion` in the payload, which
   pinned handlers read (`modules/commitments/src/tools.rs:129`, `modules/notes/src/write_tools.rs:16`).
   The version comes from the card the person saw, so this matches `services.rs:255`, where the
   trusted approval surface supplies it. An approved record is single use.
7. A reject answers `allow:false`. A pending record expires after 10 minutes, moves to
   `timed_out`, and the server answers the runner `allow:false` at that moment. The server's answer
   is the normal path. The runner's own timer (§4.2) is a backstop set one minute later.
8. When the turn ends, any approved record not yet used is voided. No grant outlives its turn.
9. The server's 300 s socket read timeout (`runner_data.rs:39`) is lifted while an approval is
   pending. A hard turn limit of 15 minutes still ends any turn.

Turn shape:

- `POST /api/chat/messages` starts the turn and returns at once.
- The drawer polls `GET /api/chat/thread` about every 1.5 s while a turn runs.
- A second message while a turn runs gets `409`, and the drawer keeps its send button disabled
  until `running` is false. The runner already serialises turns per account (`runner.rs:296`).
- The thread carries pending and decided approval records.

Rejected: server-sent events. Steelman — instant updates, no polling. It loses for now because the
Rust server has no streaming route yet, and polling one owner-scoped route is enough for a
person-paced approval. Streaming can replace polling later without changing the records.

### 3.7 Card look

- Reuse the TypeScript card. The Leptos drawer ports the markup of
  `apps/web/src/chat/action-request-card.tsx` element for element, with the same classes,
  including `action-request-preview` and `action-request-arguments` where the record has them, and
  the `chatd-status` outcome line.
- No new design and no new CSS. The stylesheet already ships, because the Rust app copies the
  current app's CSS unchanged (`rust-spike/shell/README.md:16`). Some classes the TypeScript card
  uses (`action-request-outcome`, `action-request-notice`) have no selector there either. The port
  keeps them as they are.
- Part 3b adds a class-parity test. It lists the classes in the TypeScript card and fails if the
  Rust card drops one.
- Titles: "Action request" for module tools, "Permission request" for agent asks.
- Buttons: Approve (primary; danger variant when the tool is `destructive`, which covers the TypeScript card's two
  danger cases, memory and note delete) and Reject (secondary).
- Outcome line: "Approved", "You declined" or "Timed out".
- Phone width: the card sits inside the chat drawer, full width, buttons wrap, nothing crowds a
  neighbour. Phone chat stays a drawer.

## 4. Contracts

Signatures and wire shapes only.

### 4.1 Module host (`rust-spike/module-host`)

```rust
// manifest.rs — Tool gains two optional fields
pub struct Tool {
    pub description: String,
    pub risk: String,
    pub approval_version: bool,
    pub input_schema: Option<serde_json::Value>,   // `inputSchema`; restricted JSON Schema subset
    pub card: Option<String>,               // name of an API in this module's `provides`
}

// chat_tools.rs (new)
pub enum ChatToolRule { Run, RunUnlessPolicy, Card { pinned: bool } }
pub fn chat_tool_rule(tool: &Tool, explicit_policy: Option<bool>) -> ChatToolRule;

pub struct ChatToolDef {
    pub module: String, pub tool: String, pub wire_name: String,
    pub description: String, pub input_schema: serde_json::Value,
    pub risk: String, pub rule: ChatToolRule,
}

pub struct ApprovalCardRecord {
    pub title: String, pub target: String,  // both set by the host from fixed text and the manifest
    pub fields: Vec<CardField>,             // {label, value}, each size-capped
    pub version: Option<String>, pub content: Option<String>, pub danger: bool,
}

impl Installer {
    pub fn chat_tools(&self, access: &AccessContext) -> Result<Vec<ChatToolDef>>;
    pub fn run_chat_tool(&self, access: &AccessContext, module: &str, tool: &str,
                         params: serde_json::Value) -> Result<serde_json::Value>;   // no card; redacted
    pub fn run_approved_chat_tool(&self, access: &AccessContext, module: &str, tool: &str,
                                  params: serde_json::Value, version: Option<&str>)
                                  -> Result<serde_json::Value>;                    // mint, check, consume, run; redacted
    pub fn chat_tool_card(&self, access: &AccessContext, module: &str, tool: &str,
                          params: &serde_json::Value) -> Result<Option<ApprovalCardRecord>>;
}
```

- Crate placement: module-host does not depend on the agents crate, so `ChatToolDef` carries the
  rule, not `ToolFacts`. The server, which depends on both, maps `ChatToolRule` to `ToolFacts`
  (`rust-spike/agents/src/approvals.rs:35`) in one function beside the bridge.
- `run_chat_tool` validates `params` against `inputSchema`, applies `chat_tool_rule`, and refuses
  any tool whose rule needs a card. `run_approved_chat_tool` does the same validation, then mints,
  checks and consumes the grant (§3.6 step 6). Both invoke the `tool` handler through
  `Installer::call` (`store.rs:608`). `call` takes the module fence and disk lock, then runs `call_unfenced`, which
  refuses a module switched off for the account (`store.rs:640-645`).
- `Installer::call` with kind `tool` would bypass grants. Part 1 makes that kind reachable only
  inside module-host (`pub(crate)` path), so the server can reach tools only through these two
  functions.
- Before anything leaves the host, `run_chat_tool`, `chat_tool_card` and `chat_tools` pass their
  output through `credentials::sanitize_with` with the account's stored secrets for that module.
  Today that redaction covers only credential-exchange replies (`credentials.rs:174`, `:255`).

### 4.2 Runner socket (`moss-runner`)

Server → runner:

```json
{"op":"chat","account":"<user-id>","text":"…","tools":[{"name":"scratchpad_append","module":"scratchpad","description":"…","input_schema":{…},"facts":{…}}]}
{"op":"answer","id":42,"allow":true}
{"op":"tool_result","call_id":"<id>","ok":true,"text":"…"}
```

Runner → server:

```json
{"event":"approval","id":42,"source":"moss","module":"scratchpad","card":{"tool":"scratchpad_append","input":{…}}}
{"event":"tool_call","call_id":"<id>","name":"scratchpad_append","arguments":{…}}
```

- Existing `text`, `tool_started`, `tool_finished`, `done` and `error` events stay.
- `ToolHost` becomes account-aware: `fn tools(&self, account: &str) -> Vec<ToolDef>`.
- `ToolFacts` already derive `Deserialize` (`approvals.rs:34`), so facts can travel in the chat op.
- A `tool_call` with no `tool_result` inside the turn's timeout returns an error text to the agent.
- Runner-side asks end on their own. Each pending ask gets a 10-minute timer that answers Deny,
  and a dropped connection answers Deny for every ask it holds. Today the ask closure awaits
  `rx.await` with no timer (`moss-runner.rs:200-206`). The pending map is shared into the chat task,
  so after a disconnect the ask hangs, and because `chat()` holds the account lock
  (`runner.rs:296`), every later turn for that account blocks too.
- The server holds one socket for the whole turn, in the background task that runs it, so the
  `answer` reaches the connection that asked (`runner_data.rs:39-45` opens one per message).
- The runner answers `tools/list` from the account's current list. When the chat op's list
  digest differs from the last one, it pushes a `ListChanged` line on the gateway socket.
- None of this exists today. `moss-tool-gateway.rs` `initialize` answers `{"tools": {}}` and its
  stdin loop is request and reply only. Part 2a adds `tools: {listChanged: true}`, the push line,
  a socket reader thread in the gateway, and one shared stdout writer. Today `Host::ask` reads the
  next socket line as the reply to its own request (`moss-tool-gateway.rs:100-111`), so a push
  would be taken as an answer. The reader thread routes lines by request id to the waiting call
  and sends id-less pushes to the writer, which emits `notifications/tools/list_changed`.
- The runner's approval id stays its own `u64` (`Op::Answer`). The server maps it to the record's
  `Uuid` and never shows it to the browser.

### 4.3 Server (`rust-spike/shell/app`)

```rust
pub struct PendingApproval {
    pub id: Uuid, pub actor: Uuid, pub turn: Uuid, pub source: ApprovalSource,
    pub module: Option<String>, pub tool: String, pub parameters: serde_json::Value,
    pub card: ApprovalCardRecord, pub created: Instant, pub expires: Instant,
    pub state: ApprovalState,            // Pending | Approved | Used | Declined | TimedOut | Voided
}
```

Routes:

| Route                           | Body                                | Answers                                                      |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `POST /api/chat/messages`       | `{text}`                            | `202` with the thread; turn runs in the background           |
| `GET /api/chat/thread`          | —                                   | thread with `running` flag and approval records              |
| `POST /api/chat/approvals/{id}` | `{decision: "approve" \| "reject"}` | `200` thread; `404` if the record is not the actor's or gone |

### 4.4 Contract crate (`rust-spike/shell/contract`)

- `ChatThread` gains `running: bool` and `approvals: Vec<ApprovalView>`.
- `ApprovalView` mirrors `ApprovalCardRecord` plus `id`, `kind` (`action` / `permission`) and
  `state`. It never carries raw parameters.
- `ShellData` gains `decide_approval(id, decision)`.

## 5. Determinism boundary

- Every card is drawn from the stored record built by code. Model-written values appear only as
  labelled field values (§3.4). Titles, labels, buttons and outcomes are fixed text.
- Outcome lines ("Approved", "You declined", "Timed out") render from record state.
- A module never injects turns into chat.
- The model has two jobs: choose a tool and its arguments, and write the reply text.
- The repo's four guards for model-written values, and how each is met:
  - Schema field descriptions: every `inputSchema` property carries a `description`.
  - Prompt contract with a worked example: every write or destructive tool's schema carries one
    worked example (JSON Schema `examples`, in the allowed subset). Each module part writes them
    up front, not after a failure.
  - Boundary validator: `run_chat_tool` and `run_approved_chat_tool` validate before any guest code.
  - Per-item before/after acceptance: card-required calls show every value before they run. Plain
    writes run without asking, by Ben's install ruling (§10), so their acceptance is after the fact.
    Each write tool returns `changed: [{label, before, after}]`, and the drawer shows it as a fixed
    "Done" row drawn from that result. This is the one deliberate deviation, recorded in §10.
- Guidance budget: no new system prompt text. Tool descriptions come from manifests and stay
  under 60 words each, examples included.

## 6. Security properties

Each needs a test observed failing with the protection removed, per the repo rule.

| Property                                   | Test                                                                                                                                             | Removal that must make it fail                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Calls run as the signed-in user, under RLS | User A's Scratchpad tool call cannot read user B's notes                                                                                         | pass a fixed access instead of the turn's          |
| No admin bypass                            | An admin cannot read another user's data through a tool, or approve another user's card                                                          | drop the actor check on `/api/chat/approvals/{id}` |
| Switched-off module refused                | Disable Scratchpad for A; its tools vanish from A's list and a forged call is refused                                                            | skip `call_unfenced`'s enabled check               |
| Card-required call needs a grant           | A destructive call claimed as auto-run by a forged runner reply is refused                                                                       | let `run_chat_tool` run card-required tools        |
| Grant binds exact parameters               | Approve a card, then call with one changed field; refused                                                                                        | digest only the tool name                          |
| No grant outlives its turn                 | Approve, end the turn without the call, then send the same call in a new turn; a card is asked again                                             | skip voiding approved records at turn end          |
| Runner cannot name unoffered tools         | A forged `tool_call` for a tool not offered to the account, or a `call_id` from another turn, is refused                                         | skip the offered-list check                        |
| Secrets never reach the model              | A test module echoes a planted connector secret in its tool reply and card; the secret appears in no tool result, card, tool list or runner line | skip the chat-path `sanitize_with` pass            |
| Other user's approval or socket refused    | B posts A's approval id, 404; a client without the hello secret cannot open a turn                                                               | drop the hello secret check                        |
| Expired approval answers the runner        | Let a card time out; the runner receives `allow:false` and the agent gets the refusal                                                            | skip the expiry answer                             |
| No model text in fixed card parts          | A planted model string in tool arguments appears only as a field value, never in title, target, label or button                                  | let the guest card set `target`                    |
| Approved record is the gate                | A `tool_call` whose parameters differ from the approved record gets a new card, not a run                                                        | skip the record match                              |
| Job payloads stay metadata-only            | Any job a tool enqueues carries ids and small params only                                                                                        | (existing module-host test, re-run)                |

## 7. Parts

Each part is one builder session. Proof is live on the Rust server unless a part says otherwise.

| Part | Scope                                                                                                                                                                                                       | Depends on | Proof                                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Manifest `inputSchema` and `card`, install checks, `chat_tool_rule`, `chat_tools`, `run_chat_tool`, `run_approved_chat_tool`, `chat_tool_card`, chat-path redaction; host tests                             | —          | Host tests pass; each §6 host row seen failing with its protection removed                                                                                                         |
| 2a   | Per-account runner, tool list in the chat op, account-aware `ToolHost`, gateway reader thread and list-changed push; kill-gate measurements                                                                 | 1          | Playwright e2e on the live server, desktop: change the offered list mid-conversation; the agent uses a new runner-local built-in tool and still remembers the earlier turn         |
| 2b   | `tool_call` / `tool_result`, server bridge, wire-name mapping, offered-list and `call_id` checks; Scratchpad declares `inputSchema` for its read tool                                                       | 2a         | Playwright e2e against the live Rust server, desktop: ask Moss to read the scratchpad, see a real tool call and the real content                                                   |
| 3a   | Approval records and states, `/api/chat/approvals/{id}`, async turn with one held socket, drawer polling, runner and server expiry, turn-end voiding, hard turn limit                                       | 2b         | Playwright e2e on the live server: a chat turn runs with polling on desktop and phone width; an agent permission ask is answered through the approvals route as the signed-in user |
| 3b   | Drawer card ported from the TypeScript card, agent permission card, "Done" row for plain writes, class-parity test; Commitments schemas and card adapter (it already prepares its card from a saved record) | 3a         | Playwright e2e, desktop and phone width: approve a real `commitments.accept` card and reject another; outcome lines shown; screenshots on the PR; closes JS-356's chat proof       |
| 4a   | Schemas and card adapters: Scratchpad, News (`news.refreshNews` needs an `inputSchema` with no properties, because its card is built only for empty input)                                                  | 3b         | Playwright e2e, desktop and phone: Scratchpad append runs without a card and shows its Done row; `news.refreshNews` asks with a pinned card                                        |
| 4b   | Sports, Wellness, Weather, Briefings                                                                                                                                                                        | 3b         | Playwright e2e, desktop and phone: one read and one version-pinned approval (e.g. `sports.confirmSource` or `briefings.rerun`)                                                     |
| 4c   | Tasks, Notes, Memory, Goals                                                                                                                                                                                 | 3b         | Playwright e2e, desktop and phone: `notes.delete` shows the danger card and runs only after approve                                                                                |
| 4d   | Meals, Calendar, Connectors, Web research; check every sending tool declares `destructive`                                                                                                                  | 3b         | Playwright e2e, desktop and phone: one tool per module; `email.sendReply` card shows recipient and subject as field values                                                         |
| 4e   | Finance (57 tools). The builder may split it by tool area if it does not fit one session                                                                                                                    | 3b         | Playwright e2e, desktop and phone: one read, one write and one destructive tool                                                                                                    |

- Parts 4a-4e can run in parallel once part 3b merges.
- Email, People, Meetings and Backtrack declare no chat tools today, so no part covers them.

### Verification commands

Run from the `rust-spike` folder of the builder's own checkout. Expected exit code 0 for each.

```bash
cargo test --manifest-path module-host/Cargo.toml > /tmp/js357-host.log 2>&1; echo "EXIT=$?"
```

```bash
cargo test --manifest-path agents/Cargo.toml > /tmp/js357-agents.log 2>&1; echo "EXIT=$?"
```

```bash
cargo test --manifest-path shell/Cargo.toml > /tmp/js357-shell.log 2>&1; echo "EXIT=$?"
```

Module parts also run each touched module's own package gate, unpiped, expected exit 0.

## 8. Kill gates

Rows 1, 2 and 4 are evaluated after part 2a, before 2b starts. Row 3 is evaluated after 2b,
before 3a starts. Owner: the coordinator, escalating to Ben. The
report names the Claude and Codex CLI versions measured, because whether each honours
`tools/list_changed` cannot be read from the tree.

| Observation                                                                                 | Consequence                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The agent ignores `tools/list_changed` and keeps the old list                               | Use the restart fallback (§3.2) between conversations; record the cost |
| A list change loses the conversation                                                        | Stop; redesign §3.2 before 2b                                          |
| A live tool call cannot run as the signed-in user without giving the runner database access | Stop; §3.1 is wrong                                                    |
| The agent's tool-name length limit cuts real module names                                   | Coordinator decides on a short-name map before 2b                      |

Per standing ruling, a kill gate is a measurement. The report ends with a go plan and fixes.

## 9. App-map entries

Declared in the same PR as the behaviour.

- Part 3b, core chat feature: "Chat asks before deleting, sending outside your account, or pinned
  actions; you approve or reject the card in the chat drawer." Errors: approval timed out,
  approval no longer available. Remediation: ask Moss again.
- Part 2b, core chat feature: "Moss can use the chat tools of modules you have installed and switched
  on." Until 3b ships, only tools that need no approval appear. Requirement: module installed and enabled for the account.
- Parts 4a-4e: each module's manifest `features` gains or updates a chat entry naming what Moss can
  do there and which actions ask first.

## 10. Rulings ledger

| Ruling or fact                                                                                             | Source                                                             |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Installing a module grants normal use; only destructive actions confirm at use time                        | Ben, 2026-08-19 (Food)                                             |
| Ask only for deleting something or sending outside the account                                             | Ben, 2026-10-29                                                    |
| Classifier tools on by default; no per-tool manual review                                                  | Ben, issue 2984                                                    |
| YOLO on means marked chats still run writes; destructive still asks                                        | Ben                                                                |
| Phone chat stays a drawer                                                                                  | Ben                                                                |
| Cards are drawn from the stored record, never model text                                                   | `2026-11-13-rust-phase5-news-sports-weather-plan.md` §3.5          |
| No module manifest declares an input schema today                                                          | grep of `modules/*/moss.module.json`, 2026-11-18                   |
| No manifest uses `risk: outbound`                                                                          | same grep                                                          |
| `_` never appears in a tool name, so `.`→`_` reverses                                                      | `rust-spike/module-host/src/tool_names.rs`                         |
| Generic tool replies are not redacted today; only credential-exchange replies are                          | `credentials.rs:174`, `:255`, `:435` (review round 1)              |
| `runner.rs:348` copies the agent's own title into the card                                                 | review round 1                                                     |
| A restarted agent loses its conversation; context lives in the `session/new` session                       | `rust-spike/agents/src/acp.rs:57` (review round 1)                 |
| Some TypeScript card classes have no CSS selector (`action-request-outcome`, `-notice`)                    | grep of `apps/web/src/styles` (review round 1)                     |
| The tool gateway advertises no `listChanged` and cannot push today                                         | `moss-tool-gateway.rs` `initialize` (review round 2)               |
| Pinned handlers read `approvalVersion` from the payload                                                    | `modules/commitments/src/tools.rs:129` and others (review round 2) |
| Runner asks have no timer and die unanswered with the connection                                           | `moss-runner.rs` ask closure (review round 2)                      |
| `Installer::call` accepts kind `tool` with no grant check                                                  | `store.rs:608` (review round 2)                                    |
| Plain writes are accepted after the fact (Done row), not before: deviation from the plan-build four guards | Ben's install ruling 2026-08-19; review round 3                    |
| `Host::ask` reads the next socket line as its own reply                                                    | `moss-tool-gateway.rs:100-111` (review round 3)                    |
| `tools.run` releases `serial_lock` before invoking the tool                                                | `services.rs:393-395` (review round 3)                             |
| Email, People, Meetings, Backtrack declare no chat tools                                                   | grep of their manifests, 2026-11-18                                |
| `tools.run` port defaults `requiresApproval` to true, which blocks reads if reused for chat                | `services.rs` about `:357-399`                                     |
| Commitments package already prepares its review card from a saved record                                   | PR 4378 body                                                       |

## 11. Not covered

- YOLO, outside-content marking and the classifier (phase 3 part 2 item 3). When they land, the
  trusted host mints the grant and records the route; the card and records stay as planned here.
- Streaming replies.
- Saving chat history or approval records across a server restart. Records live in memory, like
  messages today; a restart ends pending approvals as timed out.
- Workshop and Food tools (both are being redone).
- Per-tool settings screens for action policy.
