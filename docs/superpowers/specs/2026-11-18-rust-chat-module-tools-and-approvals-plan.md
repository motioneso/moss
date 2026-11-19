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
| Public call into a module with the caller's access                                        | yes    | `rust-spike/module-host/src/store.rs:608` `Installer::call`, `:622` `call_unfenced`                                                   |
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
`_`, so the mapping reverses exactly. The server refuses duplicates across modules and any name
whose prefixed form (`mcp__moss__…`) exceeds the agent's limit; part 2 confirms that limit.

Rejected: restart the agent on every list change. Steelman — simplest, and needs nothing from the
agent's MCP client. It loses because a restart drops the conversation (`acp.rs:57`), so it stays
the fallback only.

### 3.3 Input schemas live in the manifest

- Add optional `input` to manifest `Tool`: a JSON Schema in a restricted subset (object, string,
  number, integer, boolean, array, enum, required, maxLength, maxItems, minimum, maximum,
  description).
- The host rejects schemas outside the subset at install.
- The server validates arguments against `input` before any guest code runs.
- A tool with no `input` is not offered to the model.
- Order matters. `deny_unknown_fields` means the host change (part 1) must merge before any module
  declares `input`. Each module part bumps its version.
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
- Code builds every title, label, button and outcome line. Values the model wrote (a recipient, a
  subject, a note body) appear only as labelled field values, taken from the validated parameters
  or the stored record. They never become a title, label or button.
- Agent permission cards take their title from a fixed server table, never from the agent's own
  `title` (`rust-spike/agents/src/runner.rs:348` copies it today). The command or path shows as a
  field value.

### 3.5 When a card is required

From Ben's rulings (§10). Installing a module grants normal use. Only deleting, sending outside the
account, or a version-pinned action asks.

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
   turn, module, tool and exact parameters. Only then does it call `approve_tool_at_version` (or
   `approve_tool`) and `run_chat_tool` back to back, so the host consumes the grant at once. An
   approved record is single use.
7. A reject answers `allow:false`. A pending record expires after 10 minutes, moves to
   `timed_out`, and the server answers the runner `allow:false` at that moment.
8. When the turn ends, any approved record not yet used is voided. No grant outlives its turn.
9. The server's 300 s socket read timeout (`runner_data.rs:39`) is lifted while an approval is
   pending. A hard turn limit of 15 minutes still ends any turn.

Turn shape:

- `POST /api/chat/messages` starts the turn and returns at once.
- The drawer polls `GET /api/chat/thread` about every 1.5 s while a turn runs.
- The thread carries pending and decided approval records.

Rejected: server-sent events. Steelman — instant updates, no polling. It loses for now because the
Rust server has no streaming route yet, and polling one owner-scoped route is enough for a
person-paced approval. Streaming can replace polling later without changing the records.

### 3.7 Card look

- Reuse the TypeScript card. The Leptos drawer ports the markup of
  `apps/web/src/chat/action-request-card.tsx` element for element, with the same classes,
  including `action-request-preview` and `action-request-arguments` where the record has them.
- No new design and no new CSS. The stylesheet already ships, because the Rust app copies the
  current app's CSS unchanged (`rust-spike/shell/README.md:16`). Some classes the TypeScript card
  uses (`action-request-outcome`, `action-request-notice`) have no selector there either. The port
  keeps them as they are.
- Part 3b adds a class-parity test. It lists the classes in the TypeScript card and fails if the
  Rust card drops one.
- Titles: "Action request" for module tools, "Permission request" for agent asks.
- Buttons: Approve (primary; danger variant when the record is destructive) and Reject (secondary).
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
    pub input: Option<serde_json::Value>,   // restricted JSON Schema subset
    pub card: Option<String>,               // name of an API in this module's `provides`
}

// chat_tools.rs (new)
pub enum ChatToolRule { Run, RunUnlessPolicy, Card { pinned: bool } }
pub fn chat_tool_rule(tool: &Tool, explicit_policy: Option<bool>) -> ChatToolRule;

pub struct ChatToolDef {
    pub module: String, pub tool: String, pub wire_name: String,
    pub description: String, pub input: serde_json::Value,
    pub risk: String, pub rule: ChatToolRule,
}

impl Installer {
    pub fn chat_tools(&self, access: &AccessContext) -> Result<Vec<ChatToolDef>>;
    pub fn run_chat_tool(&self, access: &AccessContext, module: &str, tool: &str,
                         params: serde_json::Value) -> Result<serde_json::Value>;   // redacted
    pub fn chat_tool_card(&self, access: &AccessContext, module: &str, tool: &str,
                          params: &serde_json::Value) -> Result<Option<ApprovalCardRecord>>;
}
```

- `run_chat_tool` validates `params` against `input`, applies `chat_tool_rule`, checks and consumes
  the grant when a card is required, then invokes the `tool` handler through `Installer::call`
  (`store.rs:608`). `call` takes the module fence and disk lock, then runs `call_unfenced`, which
  refuses a module switched off for the account (`store.rs:640-645`).
- Before anything leaves the host, `run_chat_tool`, `chat_tool_card` and `chat_tools` pass their
  output through `credentials::sanitize_with` with the account's stored secrets for that module.
  Today that redaction covers only credential-exchange replies (`credentials.rs:174`, `:255`).

### 4.2 Runner socket (`moss-runner`)

Server → runner:

```json
{"op":"chat","account":"<user-id>","text":"…","tools":[{"name":"scratchpad_append","description":"…","input_schema":{…},"facts":{…}}]}
{"op":"answer","id":"<approval-id>","allow":true}
{"op":"tool_result","call_id":"<id>","ok":true,"text":"…"}
```

Runner → server:

```json
{"event":"approval","id":"<approval-id>","source":"moss","module":"scratchpad","card":{"tool":"scratchpad_append","input":{…}}}
{"event":"tool_call","call_id":"<id>","name":"scratchpad_append","arguments":{…}}
```

- Existing `text`, `tool_started`, `tool_finished`, `done` and `error` events stay.
- `ToolHost` becomes account-aware: `fn tools(&self, account: &str) -> Vec<ToolDef>`.
- `ToolFacts` gain `Deserialize` so facts travel in the chat op.
- A `tool_call` with no `tool_result` inside the turn's timeout returns an error text to the agent.
- The runner answers `tools/list` from the account's current list and sends
  `notifications/tools/list_changed` when the chat op's list digest differs from the last one.

### 4.3 Server (`rust-spike/shell/app`)

```rust
pub struct ApprovalCardRecord {
    pub title: String, pub target: String,
    pub fields: Vec<CardField>,          // {label, value}, each size-capped
    pub version: Option<String>, pub content: Option<String>, pub danger: bool,
}
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
- Model-authored arguments pass four guards: schema field descriptions, the tool description, the
  boundary validator in `run_chat_tool`, and the person's approval of the card when one is required.
- Guidance budget: no new prompt text. Tool descriptions come from manifests and stay under 60 words
  each.

## 6. Security properties

Each needs a test observed failing with the protection removed, per the repo rule.

| Property                                   | Test                                                                                                                                             | Removal that must make it fail                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Calls run as the signed-in user, under RLS | User A's Scratchpad tool call cannot read user B's notes                                                                                         | pass a fixed access instead of the turn's          |
| No admin bypass                            | An admin cannot read another user's data through a tool, or approve another user's card                                                          | drop the actor check on `/api/chat/approvals/{id}` |
| Switched-off module refused                | Disable Scratchpad for A; its tools vanish from A's list and a forged call is refused                                                            | skip `call_unfenced`'s enabled check               |
| Card-required call needs a grant           | A destructive call claimed as auto-run by a forged runner reply is refused                                                                       | skip the grant check in `run_chat_tool`            |
| Grant binds exact parameters               | Approve a card, then call with one changed field; refused                                                                                        | digest only the tool name                          |
| No grant outlives its turn                 | Approve, end the turn without the call, then send the same call in a new turn; a card is asked again                                             | skip voiding approved records at turn end          |
| Runner cannot name unoffered tools         | A forged `tool_call` for a tool not offered to the account, or a `call_id` from another turn, is refused                                         | skip the offered-list check                        |
| Secrets never reach the model              | A test module echoes a planted connector secret in its tool reply and card; the secret appears in no tool result, card, tool list or runner line | skip the chat-path `sanitize_with` pass            |
| Other user's approval or socket refused    | B posts A's approval id, 404; a client without the hello secret cannot open a turn                                                               | drop the hello secret check                        |
| Expired approval answers the runner        | Let a card time out; the runner receives `allow:false` and the turn ends                                                                         | skip the expiry answer                             |
| Job payloads stay metadata-only            | Any job a tool enqueues carries ids and small params only                                                                                        | (existing module-host test, re-run)                |

## 7. Parts

Each part is one builder session. Proof is live on the Rust server unless a part says otherwise.

| Part | Scope                                                                                                                                           | Depends on | Proof                                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Manifest `input` and `card`, install checks, `chat_tool_rule`, `chat_tools`, `run_chat_tool`, `chat_tool_card`, chat-path redaction; host tests | —          | Host tests pass; each §6 host row seen failing with its protection removed                                                                    |
| 2a   | Per-account runner, tool list in the chat op, account-aware `ToolHost`, list-changed notice; kill-gate measurements with built-in tools         | 1          | Live chat on desktop: change the offered list mid-conversation, the agent uses the new tool and still remembers the earlier turn. §8 recorded |
| 2b   | `tool_call` / `tool_result`, server bridge, wire-name mapping, offered-list and `call_id` checks; Scratchpad declares `input` for its read tool | 2a         | Live chat on desktop: ask Moss to read the scratchpad, see a real tool call and the real content                                              |
| 3a   | Approval records, `/api/chat/approvals/{id}`, async turn, polling in the drawer, expiry and turn-end voiding, hard turn limit                   | 2b         | Live: a chat turn runs with polling on desktop and phone; a real approval is answered through the approvals route as the signed-in user       |
| 3b   | Drawer card ported from the TypeScript card, agent permission card, class-parity test                                                           | 3a         | Live chat, desktop and phone width: approve one real card and reject another; outcome lines shown; screenshots on the PR                      |
| 4a   | Schemas and card adapters: Scratchpad, Commitments, News                                                                                        | 3b         | Commitments accept through chat with a real card (closes JS-356's chat proof); Scratchpad append runs without a card                          |
| 4b   | Sports, Wellness, Weather, Briefings                                                                                                            | 3b         | One read and one version-pinned approval (e.g. `sports.confirmSource` or `briefings.rerun`) live                                              |
| 4c   | Tasks, Notes, Memory, Goals                                                                                                                     | 3b         | `notes.delete` shows the danger card and runs only after approve                                                                              |
| 4d   | Meals, Calendar, Connectors, Web research; check every sending tool declares `destructive`                                                      | 3b         | One tool per module live; `email.sendReply` card shows recipient and subject as field values                                                  |
| 4e   | Finance (57 tools). The builder may split it by tool area if it does not fit one session                                                        | 3b         | One read, one write and one destructive tool live                                                                                             |

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

Evaluated after part 2a, before part 2b starts. Owner: the coordinator, escalating to Ben.

| Observation                                                                                 | Consequence                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The agent ignores `tools/list_changed` and keeps the old list                               | Use the restart fallback (§3.2) between conversations; record the cost |
| A list change loses the conversation                                                        | Stop; redesign §3.2 before 2b                                          |
| A live tool call cannot run as the signed-in user without giving the runner database access | Stop; §3.1 is wrong                                                    |
| The agent's tool-name length limit cuts real module names                                   | Add a short-name map in 2b before continuing                           |

Per standing ruling, a kill gate is a measurement. The report ends with a go plan and fixes.

## 9. App-map entries

Declared in the same PR as the behaviour.

- Part 3b, core chat feature: "Chat asks before deleting, sending outside your account, or pinned
  actions; you approve or reject the card in the chat drawer." Errors: approval timed out,
  approval no longer available. Remediation: ask Moss again.
- Part 2b, core chat feature: "Moss can use the chat tools of modules you have installed and switched
  on." Requirement: module installed and enabled for the account.
- Parts 4a-4e: each module's manifest `features` gains or updates a chat entry naming what Moss can
  do there and which actions ask first.

## 10. Rulings ledger

| Ruling or fact                                                                              | Source                                                    |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Installing a module grants normal use; only destructive actions confirm at use time         | Ben, 2026-08-19 (Food)                                    |
| Ask only for deleting something or sending outside the account                              | Ben, 2026-10-29                                           |
| Classifier tools on by default; no per-tool manual review                                   | Ben, issue 2984                                           |
| YOLO on means marked chats still run writes; destructive still asks                         | Ben                                                       |
| Phone chat stays a drawer                                                                   | Ben                                                       |
| Cards are drawn from the stored record, never model text                                    | `2026-11-13-rust-phase5-news-sports-weather-plan.md` §3.5 |
| No module manifest declares an input schema today                                           | grep of `modules/*/moss.module.json`, 2026-11-18          |
| No manifest uses `risk: outbound`                                                           | same grep                                                 |
| `_` never appears in a tool name, so `.`→`_` reverses                                       | `rust-spike/module-host/src/tool_names.rs`                |
| Generic tool replies are not redacted today; only credential-exchange replies are           | `credentials.rs:174`, `:255`, `:435` (review round 1)     |
| `runner.rs:348` copies the agent's own title into the card                                  | review round 1                                            |
| A restarted agent loses its conversation; context lives in the `session/new` session        | `rust-spike/agents/src/acp.rs:57` (review round 1)        |
| Some TypeScript card classes have no CSS selector (`action-request-outcome`, `-notice`)     | grep of `apps/web/src/styles` (review round 1)            |
| Email, People, Meetings, Backtrack declare no chat tools                                    | grep of their manifests, 2026-11-18                       |
| `tools.run` port defaults `requiresApproval` to true, which blocks reads if reused for chat | `services.rs` about `:357-399`                            |
| Commitments package already prepares its review card from a saved record                    | PR 4378 body                                              |

## 11. Not covered

- YOLO, outside-content marking and the classifier (phase 3 part 2 item 3). When they land, the
  trusted host mints the grant and records the route; the card and records stay as planned here.
- Streaming replies.
- Saving chat history or approval records across a server restart. Records live in memory, like
  messages today; a restart ends pending approvals as timed out.
- Workshop and Food tools (both are being redone).
- Per-tool settings screens for action policy.
