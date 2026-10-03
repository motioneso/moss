# Classifier shadow records: delete them from Moss (lane plan)

Issue: [#2911](https://github.com/motioneso/moss/issues/2911), epic #2864. Tier: **security**.
Branch `cg-shadow-delete-tool`, worktree `~/Jarv1s/.claude/worktrees/cg-shadow-retention`.
Follows #2910 (PR merged): the owner-only delete endpoint and RLS already exist. This lane makes
Moss itself able to delete the records, and tidies the retired purge job.

No migration in this lane.

## Seams check (current tree, file:line)

| Capability the plan assumes                                                            | Evidence                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Owner-only delete already exists                                                       | `packages/chat/src/classifier-shadow-repository.ts:265` (`deleteForOwner`)                                               |
| Chat assistant tools live in the manifest                                              | `packages/chat/src/manifest.ts:291-348`; example write tool `packages/chat/src/response-style-tool.ts`                   |
| Destructive self-operation must declare a grant; `confirm_always` has a hard allowlist | `packages/ai/src/gateway/self-operation.ts:202-212`, `:290-292`, `:407-429`                                              |
| The inventory test pins the allowlist and bucket counts                                | `tests/unit/self-operation-manifests.test.ts:361-371`, `:456-483`                                                        |
| No-actor and worker-role behaviour is testable against the gate DB                     | `tests/integration/chat-classifier-shadow.test.ts` (`asActor`, worker connection)                                        |
| pg-boss queues/schedules can be read and dropped idempotently                          | `packages/module-registry/src/external/job-reconciler.ts:53-76`; `node_modules/pg-boss/dist/plans.js:420-452`            |
| Worker startup is where the retired purge queue was registered                         | `packages/chat/src/jobs.ts` (`registerChatJobWorkers`)                                                                   |
| Deterministic live chat via the scripted provider, including an approval card          | `tests/uat/fixtures/scripted-provider/claude-main.ts`, `tests/uat/specs/1533-chat-surface-live-path.uat.spec.ts:265-296` |
| UAT can seed/read the stack database                                                   | `tests/uat/specs/job-search-board-sql.ts` (`execUatSql`)                                                                 |
| App-map truthfulness                                                                   | `packages/chat/src/manifest.ts:189-197`; `tests/unit/app-map-integrity.test.ts`                                          |

## Decision: chat tool, not a Settings screen

Issue #2911 allows "a Moss chat tool (and/or a Settings control)" and requires a live proof through
the real chat UI. A chat tool is the smaller change and is what the proof exercises, so this lane
ships the chat tool only. A screen for private shadow text would need its own mockup and spec.

## Tasks

### T1 — Chat tool `chat.deleteClassifierShadowRecords`

New `packages/chat/src/classifier-shadow-tool.ts`:

- `chatDeleteClassifierShadowRecordsInputSchema`: empty object, `additionalProperties: false`.
- `chatDeleteClassifierShadowRecordsOutputSchema`: `{ deleted: number }`, required, no extra.
- `chatDeleteClassifierShadowRecordsExecute: ToolExecute` — `assertDataContextDb(scopedDb)`, call
  `new ClassifierShadowRepository().deleteForOwner(scopedDb)`, return `{ data: { deleted } }`.

`packages/chat/src/manifest.ts` `assistantTools`: add

```
{
  name: "chat.deleteClassifierShadowRecords",
  description: "Delete all of the current user's classifier shadow records — the private trial " +
    "records kept while the classifier gate runs in shadow mode. Use only when the user asks to " +
    "delete that trial data.",
  permissionId: "chat.message",
  risk: "destructive",
  selfOperationGrant: "confirm_always",
  inputSchema: chatDeleteClassifierShadowRecordsInputSchema,
  outputSchema: chatDeleteClassifierShadowRecordsOutputSchema,
  execute: chatDeleteClassifierShadowRecordsExecute
}
```

No `actionFamilyId` and no `executionPolicy` (confirm_always forbids promotability).

### T2 — Confirm-always allowlist

`packages/ai/src/gateway/self-operation.ts:202` — add `chat.deleteClassifierShadowRecords` to
`PLANNED_CONFIRM_ALWAYS_TOOLS` (a delete of the user's own data always asks).

`tests/unit/self-operation-manifests.test.ts` — add the name to
`PLANNED_CONFIRM_ALWAYS_TOOL_NAMES`, update `confirmAlways.length` 9 -> 10, the total 58 -> 59, and
the test title; append a `#2911` line to the ledger comment.

### T3 — Retired purge job tidy-up

`packages/chat/src/jobs.ts`:

- `export const RETIRED_CHAT_PURGE_SHADOW_RECORDS_QUEUE = "chat.purge-classifier-shadow-records";`
- `export async function retireShadowRecordPurgeQueue(boss, logger?)` — for every schedule from
  `boss.getSchedules()` whose `name` matches, `boss.unschedule(name, key)`; then, only when
  `boss.getQueue(name)` returns a queue, `boss.deleteQueue(name)` and log once. Idempotent and safe
  on a fresh install where neither exists (#2910 removed the code; the pgboss rows can linger).
- call it once at the start of `registerChatJobWorkers`.

Unit test `tests/unit/chat-shadow-purge-retire.test.ts` with a fake boss: present queue + schedule
=> one unschedule and one deleteQueue; absent => no `deleteQueue`, and unrelated queues untouched.

### T4 — App map

`packages/chat/src/manifest.ts` feature `chat.classifier_shadow_records` description: name how —
"kept until you ask Moss in chat to delete them". Add a #2911 note that the delete is confirmed
first. Keep <= 240 chars.

### T5 — Tests

`tests/integration/chat-classifier-shadow.test.ts`:

- "a delete with no signed-in user is refused": seed a record as userA, run a raw
  `DELETE FROM app.chat_classifier_shadow_records` on the un-scoped app connection (no actor), and
  assert zero rows removed and A's row survives.
- "the background worker role still cannot delete": over the worker connection, a raw DELETE
  rejects with a permission error (worker was never granted DELETE).

### T6 — Live proof through the real chat UI

- `tests/uat/seed/types.ts`: add `"2911-shadow-delete"` to `UatChatScript` and
  `UAT_CHAT_SCRIPTS`.
- `tests/uat/fixtures/chat-scripts/2911-shadow-delete.json`: one turn, `expectIncludes` the
  sentinel, `calls` `chat.deleteClassifierShadowRecords` with `{}`, reply names the deletion.
- `tests/uat/specs/2911-shadow-delete.uat.spec.ts`: `uatLevel` admin+data, `withoutNewsJsonBinding`,
  `chatScript: "2911-shadow-delete"`. Steps: sign in; seed one shadow record for the admin via
  `execUatSql`; assert count 1; open chat and send the sentinel message; wait for the approval card
  and click Approve; wait for the turn to settle; poll the database for count 0.
- `.claude/skills/coordinate/uat-trigger-map.tsv`: add `blocking`
  `packages/chat/src/classifier-shadow-tool.ts` -> `tests/uat/specs/2911-shadow-delete.uat.spec.ts`.

## Verification commands (never piped)

```
scripts/run-gate.sh start            # full verify:foundation; expect start exit 0
scripts/run-gate.sh wait --follow    # exit 0 green, 1 red, 2 dead
pnpm format:check && pnpm lint && pnpm typecheck
( pnpm test:uat -- 2911-shadow-delete.uat.spec.ts > /tmp/cb-uat.log 2>&1; echo "UAT_EXIT=$?" >> /tmp/cb-uat.log )
```

Known load flake `tests/unit/mcp-gateway-validation.test.ts` (#1673) counts as green when it is the
only failure (Ben, 2026-10-02).

## Determinism boundary

The tool derives its reply from the record (the deleted count and the database effect), never from
model prose. The UAT message is fixed; the model's final text is a fixture constant.

## Kill gate

If the isolated UAT stack cannot be built or driven because the box is saturated, report the honest
status **code-complete, unverified** with the failing command and its output, rather than claiming a
live proof. Owner: build agent.
