# Module page write tools — bounded implementation slices

Part of #1699. Design: `docs/superpowers/specs/2026-10-25-module-page-write-tools-design.md`.
Work stays in `~/Jarv1s/.claude/worktrees/mod-page-write-tools` on
`feat/module-page-write-tools`. The boot brief explicitly authorizes provisional development
against the draft. Ben approved this slice approach in-session. Do not merge the feature or
close #1699 until the draft decisions and assembled live proof are settled.

## Session boundary and ordering

1. **Confirmation foundation (this session).** AI-owned persistence and public functions,
   additive migration, database types and schema catalog, real database regression tests.
   No new route or UI is registered; no page can execute through this foundation alone.
2. **Module invoke route (#3723).** External-only admission, active actor module
   check, trusted origin, per-session/module rate limit, validation, classification, digest,
   direct/confirmed execution, result screening and rejection codes, route/chat guards.
3. **Host tools handle and assembled proof (#3724).** SDK browser contracts,
   optional Root prop and actual shell wiring, host dialog/cancel, deterministic outcomes,
   core app-map entries, developer documentation, real installed-module browser proof.

Slices 2 and 3 are deliberately outlined rather than implemented in advance. Create one GitHub
`task` issue for each if this session ends after slice 1, with their dependency order and tests.
Use one branch and one implementation PR for work performed this session. Ben subsequently
superseded the brief's main-rebase instruction for stacking: rebase on the latest
`docs/module-platform-specs` and target that branch (stacked on #3718), then retarget main
after #3718 merges. Preserve the exact spec ancestry rather than copying/replaying its files.
Do not close #1699 from a partial PR.

## Seams verified against this tree

| Capability                                          | Evidence                                                                                         | Consequence                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Actor-scoped transactions                           | `packages/db/src/data-context.ts:65`                                                             | Functions require branded `DataContextDb`; actor comes from the transaction         |
| Owner-only action RLS and immutable action identity | `packages/ai/sql/0016_ai_assistant_actions.sql:42`, `:132`                                       | Reuse AI table, never a platform query of AI-owned storage                          |
| Chat origin/deadline already exist                  | `packages/ai/sql/0296_ai_action_origin_and_timeout.sql:5`                                        | Add a separate page-origin discriminator and digest; leave chat bindings null       |
| Pending-only resolution and deadline check          | `packages/ai/src/repository.ts:2283`                                                             | New consumption must be one conditional UPDATE, no read-then-write                  |
| Recovery only emits with both chat bindings         | `packages/ai/src/gateway/action-request-recovery.ts:109`                                         | Page deadlines may expire without entering chat history                             |
| No-waiter approval refuses execution                | `packages/ai/src/gateway/action-request-lifecycle.ts:107`                                        | Early approval is unavailable until deadline, not immediately expired as draft says |
| Public AI barrel                                    | `packages/ai/src/index.ts:1`                                                                     | Export narrow foundation functions here                                             |
| External confirmation hook/provenance               | `packages/module-registry/src/external/tool-manifests.ts:213`, `:236`                            | Route must require external provenance and matching owner                           |
| Host-forced worker actor                            | `apps/api/src/external-module-tools.ts:176`                                                      | Reuse invoker; do not accept an actor from page input                               |
| Input validator/result sanitizer/size screen        | `packages/ai/src/routes.ts:1014`, `:1041`                                                        | Reuse in slice 2 rather than creating a second validator                            |
| Origin-check precedent                              | `apps/api/src/companion-routes.ts:169`                                                           | Missing and foreign origins both refuse                                             |
| Session limiter precedent                           | `packages/ai/src/routes.ts:946`                                                                  | Separate bucket plus module id                                                      |
| Chat self-authority block precedent                 | `packages/module-registry/src/route-chat-rules.ts:62`                                            | Add new path before route ships                                                     |
| Optional Root prop and bound host action            | `apps/web/src/external-modules/loader.ts:17`, `apps/web/src/external-modules/host-actions.ts:64` | Add optional handle and bind module at host call site                               |

Open question 5 seams pass: current AI/chat source has no recovery executor for `confirmed`
rows. Recovery selects pending deadlines and unrecorded timed-out rows (`repository.ts:2180`),
not confirmed rows. DTO serialization enumerates fields (`routes.ts:1265`), so it does not expose
new digest columns. Later slices must recheck these consumers before activation.

## Slice 1 decisions and contracts

Files: new `packages/ai/src/module-page-confirmations.ts`, new migration under
`packages/ai/sql/`, `packages/ai/src/index.ts`, `packages/db/src/types.ts`,
`packages/ai/src/repository.ts` (safe-row type only),
`tests/integration/module-page-confirmations.test.ts`,
`tests/integration/foundation-schema-catalog.test.ts`, root `package.json` scoped test command.

Public exports follow the spec:

```ts
createModulePageConfirmation(db: DataContextDb, input: {
  moduleId: string; moduleName: string; toolName: string; permissionId: string;
  risk: "write" | "outbound" | "destructive";
  inputSummary: Record<string, unknown>; inputDigest: Buffer; requestId: string;
}): Promise<{ id: string; expiresAt: Date }>;
consumeModulePageConfirmation(db: DataContextDb, input: {
  id: string; moduleId: string; toolName: string; inputDigest: Buffer;
}): Promise<boolean>;
```

Creation uses database time for the two-minute deadline and transaction actor for owner.
Consumption matches id, transaction actor, origin, module, tool, SHA-256 digest, pending
status and unexpired deadline in one UPDATE. Invalid UUIDs/digest lengths fail closed.
The caller must supply the digest of canonical **validated** input; canonicalization belongs
with route validation in slice 2. Raw inputs are not part of this API.

Migration adds nullable `origin` and `input_digest`. Enforce paired page fields, 32-byte digest,
no chat binding on page rows and a required page deadline. A new trigger makes page identity
and digest immutable. Legacy rows keep null fields. Extend the database type with optional-on-
insert columns and keep existing safe-row fixtures compatible by omitting these internal fields.
No existing migration is edited. No activity record is added in this foundation.

Tests (real runtime-role database):

- Creation records page metadata, owner and a two-minute deadline; fails if chat fields are set.
- Two concurrent consumes produce exactly one true and a confirmed record; catches non-atomic use.
- Changed digest/module/tool, expired, cancelled and consumed rows reject; missing predicates fail.
- Other user and admin cannot consume or read owner's row; catches owner/RLS regressions.
- Chat rows cannot be consumed as page approvals, even with matching tool; catches origin confusion.
- Existing REST confirmed refuses a page row without a live waiter; cancel still works.
- Page origin/digest cannot be rewritten; catches mutable approval identity.
- Recovery times out expired page rows without chat notification; confirmed rows are not replayed.

Observe a security regression red with the digest predicate temporarily removed, restore the
protection, then record both run results in the PR. Never commit the mutation.

This slice is internal infrastructure with no newly reachable UI, so no app-map change or browser
proof is claimed for it. Its executed end-to-end storage test is
`tests/integration/module-page-confirmations.test.ts`. Slice 3 owns the mandatory real UI proof.

## Later-slice acceptance and hard blockers

Slice 2 must execute spec T1–T13, including observed-red destructive and module-owner guards,
confirmation race/replay/input binding and cross-user tests. No unsafe route may ship pending
these guards. Add the new path to platform allowlist and chat self-authority rules in the same
slice. Preserve the old read invoke, queue behavior and first-party tool restrictions.

Slice 3 must execute browser tests of the **wired** handle, confirm/cancel and malformed responses,
then T14 through a real installed module and real worker/RLS path. Meals/Food page wiring remains
in their own PRs. If no real consumer is available, retain code-complete/unverified status and a
hard merge blocker for assembled proof; do not manufacture stubbed live evidence.

## Ben decisions and remaining checks

Ben's 2026-10-25 answers supersede the provisional choices:

1. Fork A approved: a page click runs writes regardless of Moss action tier; risk and tool confirmation rules still apply.
2. Outbound tools always ask first, including Send clicks. #3723 enforces confirmation; #3724 owns the host dialog and live proof.
3. Default 120 changes/minute/module confirmed; keep the designed session/module bucket and optional override.
4. Sandboxed frames were not asked about; track separately as later task #3734, outside these slices.
5. Confirmed-row consumers: foundation seams pass above; recheck on activation.
6. Page writes must write an activity record. #3723 owns recording executed writes and retry/replay coverage; #3724 proves the record through the real installed-module path. The dormant foundation still adds no activity records.

Carry these decisions into continuation PRs. Actual blockers go to `needs-ben page-write-tools` and project AWAITING-BEN if present.

## Determinism and kill gate

All dialog wording and outcomes come from validated server records; modules never inject chat
turns. This platform flow has zero model jobs and zero prompt guidance. It creates no model-authored
user data. No UI acknowledgment depends on a model response.

After slice 1, Ben/coordinator evaluates the foundation before starting slice 2. Stop this line if
atomic consumption cannot be expressed within owner RLS, or if confirmed rows trigger execution
outside the bound invoke path. Do not add compensating exceptions to chat recovery.

## Verification and closeout

Use `.claude/skills/verify-gate/SKILL.md` for every gate/database command. Commands below are
unpiped; expected exit is 0 (the intentional security mutation expects 1).

- `pnpm exec prettier --check <changed files>`
- `pnpm exec eslint <changed TypeScript files> --max-warnings=0`
- `pnpm exec tsc --noEmit`
- `pnpm check:file-size`
- `scripts/run-gate.sh start --gate test:integration:1699`
- `scripts/run-gate.sh wait --follow` (launch asynchronously; inspect terminal exit code)
- `scripts/run-gate.sh start` then asynchronous `scripts/run-gate.sh wait --follow` for full gate;
  record environmental/baseline failures accurately rather than claiming CI equivalence.

Commit explicit paths, update the spec-branch stack, push, open a PR stacked on `docs/module-platform-specs` with release note Category N/A for dormant
foundation, link leftover issues, report PR and verification to coordinator, leave clean tree.

## Rulings ledger

- 2026-10-25: boot brief authorizes provisional defaults despite draft status; Ben approves slice plan.
- 2026-10-25: draft's immediate-expiry claim is stale; lifecycle only expires after stored deadline.
- 2026-10-25: internal foundation stops before a route; all observable behavior and app-map changes
  remain acceptance criteria of dependent slices. No security property of those future paths is claimed.

## Slice 1 execution record

- Initial scoped launch found the fresh-worktree app-map artifact absent. The scoped test command
  now builds the app map before server-based tests.
- Scoped database gate passed 31 tests across four suites after that setup correction.
- A combined negative control removed consume owner/origin/module/tool/digest/status/deadline
  predicates and, only in the throwaway gate migration, disabled action RLS and dropped the new
  page identity trigger and shape constraint. Nine of ten tests failed, including replay
  (`[true, true]` instead of `[false, true]`), changed digest/module/tool, cross-user consumption,
  chat-row confusion, expired approval, mutable identity and invalid row shape. The REST case also
  failed because consuming its cancelled row reached the existing resolved-state trigger
  instead of returning false. This was a combined mutation, not isolated
  proof for each predicate. All mutations were restored before the final verification run.
- Root TypeScript and test TypeScript passed. Nullable database columns required updates to two
  existing raw-row fixtures. Three focused unit suites passed 26 tests.
- Follow-up tasks are #3723 and #3724. The complete module-page write feature remains incomplete.
