# Follow-up wave decomposition after Waves 3–6

**Proposal date:** 2026-08-10

**Live grounding:** GitHub Project 2, “Issue and Roadmap Work,” read 2026-08-09; `origin/main`
`ba1acd70a7`. The shared checkout was behind that ref, so collision claims below use live PR file
lists plus `origin/main`, not the checkout alone.

**Authority:** This is a queue proposal only. The current Coordinator retains issue creation,
dispatch, plan approval, QA, merge, and board authority. Ben retains product/design decisions and
security sign-off unless the active run records an explicit delegation.

## Hard batching rule

Every build child must fit one fresh agent session: one narrow owned surface, one branch/PR, focused
tests, and any required live-path artifact. A parent issue remains an open roll-up until its ordered
children land. If a child plan cannot credibly finish in one session, the agent stops before code
and returns a smaller re-slice.

- Do not assign two agents to the same package seam concurrently. File-disjoint work may run in
  parallel only after the Coordinator checks the live PR file lists.
- Security QA and merge are Coordinator work; they do not enlarge a build child.
- A spec draft is itself a one-session task. `gpt-5.6-sol` at high reasoning may draft it, but Ben
  or the Coordinator must approve it before any build child starts.
- Each child below needs its own GitHub `task` sub-issue before dispatch. Existing issue numbers
  remain parents unless the row explicitly says the issue is already one-session sized.

## Live frontier and release gates

| Live item | Current state | Consequence for follow-ups |
| --- | --- | --- |
| Wave 3 lane A: #1251, #1252, #1256 | In progress; no open PR visible | All Wave 4 work remains held by the approved Wave 3 → Wave 4 serialization. |
| PR #1492 / #1254 | Open; changes `packages/module-registry/src/external/tool-manifests.ts` and gateway code | Must land before Wave 4 lane C or #1339’s external-validator child is planned. |
| PR #1491 / #1403 | Open; secure-context lane A | Wave 6 #1402 stage 2 waits for merge **and** proven live HTTPS, not merely CI green. |
| #1402 stage 1 | Project status In progress; no open PR visible | Stage 2 also waits for stage 1 to merge; the approved order remains B → C1 → A → C2. |
| PR #1482 / #1255 + #1451 | Open; includes `apps/web/src/chat/chat-drawer.tsx` | Blocks all #1139 chat-drawer children until merged. |
| #1449 and #1259/#1260 | Project status In progress; no open PR visible | #1449 also blocks #1139; #1259/#1260 must clear before #1488 because that lane has already worked in prompt-safety/persona seams. |
| PR #1485 / #900 + #1134 | Open; `composer.tsx` | Finish the existing Wave 6 lane before starting another chat UI wave. |
| #1246 | Project status In progress; permission/self-operation surfaces | Resolve its live branch/PR before #1339 or the tasks portion of #1137. |
| #1440 and #1327 | Project status In progress; broad rename/UI work, exact PR files not visible | Recheck live collisions before the broad CSS parent #1427. |

All requested large parents (#1137, #1139, #1140, #1339, #1427, #901, #1488) are Backlog on
Project 2. #1138 is also Backlog and already appears one-session sized.

## Carry-forward: approved Wave 4 and Wave 6 stage 2

Re-slice Wave 4 lanes A and C into smaller **sequential** PRs. This changes execution size only; it
does not reopen or alter the approved design in
`docs/superpowers/specs/2026-08-09-wave-4-external-module-supply-chain.md`.

| Proposed child | Parent | Owned surface | Dependency | Self-contained acceptance |
| --- | --- | --- | --- | --- |
| W4-A1 dollar-quote splitter | #942 | `packages/db/src/migrations/module-sql-runner.ts` + its focused tests | Wave 3 complete | Reject a hidden second statement in both `$$` and `$tag$`; accept legitimate single statements. |
| W4-A2 role restoration | #943 | `packages/db/src/module-storage-rpc.ts` + one DB integration test | W4-A1 merged; same package serialized | Module role binds during the query and a later core operation in the same data context uses the original role. The already-approved plan-time call-site check decides reset vs save/restore; this is not a reopened product fork. |
| W4-B native host-fetch controls | #946 | `packages/host-fetch/src/{index,policy}.ts` + focused tests | Wave 3 complete | Add `::ffff:0:0/96` parity and all six issue-body control tests. |
| W4-C1 pattern validity lint | #1274 | `packages/module-registry/src/external/validate.ts` + validator tests | Wave 3 and PR #1492 merged | Invalid external-tool patterns fail install-time validation and name the tool; valid patterns survive unchanged. |
| W4-C2 static complexity lint | #1275 | Same validator seam only | W4-C1 merged | The approved catastrophic-backtracking fixture is rejected at install; code states that the heuristic is incomplete and that #860/#818 still require the deferred worker budget. |
| W4-C3 shared-gateway pin | #1279 | External tool-manifest wiring + one real installed-external-tool gateway test | W4-C2 and PR #1492 merged | A hostile value sent through an installed external tool is rejected by the shared validator and the rejection names the tool. |
| W4-D isolated provider probe | #1141 | `provider-probe.ts`, `tmux-bridge.ts`, focused test/harness only | Wave 3 complete; merge after W4-C3 | Empty credentials never inherit ambient `process.env`; the host-mode probe reports only the isolated identity. |
| W6-C2 browser geolocation upgrade | #1402 stage 2 | Only the stage-1 weather/settings client seam established on `main` | #1402 stage 1 merged; PR #1491 merged and live HTTPS proven | Over HTTPS, grant uses browser coordinates; denial/insecure context falls back to timezone; no extra prompt, coordinate/IP/user-id log, or broken header. Live UI evidence is mandatory. |

Preserve Wave 4’s approved merge order as **B → A1 → A2 → C1 → C2 → C3 → D**. A1/A2 and
C1/C2/C3 are sequential because they share owned seams. The other first children may build in
parallel after the release gates, but the Coordinator applies the merge order.

## Backlog parent decomposition

### #1137 — tasks, notes, and commitments robustness

Keep #1137 as the roll-up; create these ordered children:

| Child | Owned surface | Order / acceptance |
| --- | --- | --- |
| 1137-A share target validation | Tasks share repository and focused DB tests only | After #1246/live tasks work clears. Reject a missing/invalid target user before a share row is written; existing valid grants still pass. |
| 1137-B1 notes symlink recheck | Notes path guard plus every cited read/write call site | Immediately-before-I/O guard rejects a swapped symlink for read, edit, and job paths; normal in-root files still work. Security QA. |
| 1137-B2 notes lost-update control | `notesEditExecute` and its concurrency test | After B1. Two concurrent edits cannot silently overwrite one another; either both persist or one receives the explicitly chosen conflict/retry result. |
| 1137-C1 atomic candidate upsert | `CommitmentsRepository.upsertCandidate` + DB test | One `INSERT … ON CONFLICT … RETURNING`; concurrent identical candidates return the canonical row without `23505`. |
| 1137-C2 extraction failure visibility | Commitments extractor/worker only | Provider/config failures emit a bounded structured warning with error name/message only; no model text or private content; “no candidates” remains distinguishable. |
| 1137-C3 boundary validation | Commitments `tools.ts` and `routes.ts` | Every executor asserts `DataContextDb`; invalid `status` returns 400 while valid union values remain accepted. |
| 1137-C4 plain-text excerpts | `sanitizeExcerpt` + focused test | After C1 because both edit the repository. Escape `<`, `>`, and `&`; preserve normal excerpt text. |

Unresolved Coordinator decision: B2 may use a per-path mutex/atomic rename or an mtime conflict.
If the choice introduces a new 409/API contract, get Ben’s ruling before the child is filed.

### #1138 — outbound HTTP hardening

Leave #1138 intact as one build task: four localized guards across weather and upgrade-check, with
focused malformed-JSON/private-IP/timeout tests. Schedule it after W6-C2 because both touch
`packages/weather`; no spec or parent/child split is warranted.

### #1139 — web chat/export UI lows

Create five sequentially dispatchable UI children; the three drawer children must not overlap:

| Child | Owned surface | Dependency / acceptance |
| --- | --- | --- |
| 1139-A action resolve mutation | `action-request-card.tsx` | Mutation is single-flight/cancellation-safe; repeated clicks cannot create ragged local state. |
| 1139-B fallback record identity | `chat-drawer.tsx` fallback reconciliation | After #1482/#1449. One SSE record removes only its matching fallback; identical siblings do not flicker away. |
| 1139-C stable send/drain callback | `chat-drawer.tsx` callback/effect seam | After B. SSE ticks do not retrigger the drain effect; queued sends still drain once. |
| 1139-D private close synchronization | `chat-drawer.tsx` privacy query seam | After C. Closing invalidates/gates refetch so focus cannot resurrect private mode locally. |
| 1139-E export reattachment | Settings export component only | Remount finds the active export job and resumes progress without starting a duplicate. |

Each user-visible child carries focused UI coverage and a real live-path artifact; B–D should use a
single-purpose harness scenario per PR rather than one oversized combined UAT.

### #1140 — miscellaneous backend lows

| Child | Owned surface | Dependency / acceptance |
| --- | --- | --- |
| 1140-A preview expiry | News preview store | Expired abandoned entries are swept on `put`; owner cap behavior remains. |
| 1140-B whole-league uniqueness | Sports repository + one new sports-owned migration | Concurrent NULL-team follows create one row; never edit migration 0133. Sensitive migration QA. |
| 1140-C cancel-ledger bound | CLI runner engine host | Cancel of a never-submitted id cannot accumulate unbounded synthetic ledger entries; real preemption remains. |
| 1140-D terminal backpressure | CLI runner terminal host/connection seam | After C. `write() === false` pauses PTY delivery and `drain` resumes it without loss or unbounded queueing. |
| 1140-E idempotent crash shutdown | API and worker crash handlers | Multiple crash signals share one shutdown/timer; both processes still exit on the first crash. |
| 1140-F fixed auth error text | API auth-facing error mapper; sweep sibling route mappers only if the same helper owns them | Client receives code-keyed literals, never arbitrary `error.message`; existing status codes stay. Security tier because it touches auth errors. |
| 1140-G strict evaluation budget | Job-search evaluation scheduling/budget seam | Concurrent run-now/sweep work cannot exceed the chosen per-user cap; focused concurrency test. |

Unresolved Ben/Coordinator decision for G: enforce a strict cap (requiring serialization/CAS) or
record the cap as best-effort and close with documentation. Do not let a builder choose this during
implementation; ask `gpt-5.6-sol` high for a micro-spec only if strict enforcement is selected.

### #1339 — PR #1338 security-review follow-ups

| Child | Owned surface | Dependency / acceptance |
| --- | --- | --- |
| 1339-A composed dispatch/heal proof | One DB-backed integration test using real `AssistantToolGateway` + production action policy | After #1246 and Wave 4/#1492. With no seeded row, `callTool` emits `action_result`, never `action_request`, and writes the actor-only canonical `trusted_auto` preference. This also closes findings 1, 5, and 6’s integration half. |
| 1339-B external declaration rail | External manifest assistant-tool validation + tests | After W4-C3. External `selfOperationGrant`/`actionFamilyId` cannot pass validation into runtime. |
| 1339-C heal availability fallback | `packages/tasks/src/action-policy.ts` only | A transient insert failure degrades closed to `ask_each_time` instead of 500; no trust escalation. |

Finding 4 (GET self-heal has a write side effect) remains an intentional recorded trade-off, not a
speculative code child. Unresolved security-contract decision for B: reject or strip the two fields.
Ben/Coordinator must settle that before filing B; use a short sol-high spec if compatibility evidence
does not make the answer mechanical.

### #1427 — nine unregistered CSS files

The sol-high/high draft is now
`docs/superpowers/specs/2026-08-10-css-guard-residue.md`. It confirms **418** banned declarations
and locks seven serialized children after an independent audit found cascade and guard-definition
coverage hazards:

1. Today extraction (147 declarations).
2. Command-palette extraction (48).
3. Assistant-surface extraction (9).
4. Shared-forms extraction (56).
5. Keyline + texture extraction (23), including the `check:ui-classes` definition-list update.
6. Global `styles.css` extraction (135) with broad visual proof.
7. Tooling-only automatic discovery for every `apps/web/src/**/*.css` file.

Fable approved the spec as Ben's delegate on 2026-08-10. Its exact owned files, coupled
`font: inherit` cascade rule, per-child browser proof, and guard checks supersede this proposal's
earlier provisional split.

### #901 — distributable self-hosted TLS

The sol-high/high draft is now
`docs/superpowers/specs/2026-08-10-self-hosted-tls.md`. It keeps #901 distinct from #1403 and locks
an opt-in Caddy Compose profile, internal CA by default with explicit ACME mode, HTTPS on 443 beside
legacy HTTP `:1533`, and additive/no-overwrite env migration. #1403 and #1486 are prerequisites.
The Caddy service is explicitly secret-minimal and non-root: it never inherits the application env
file, drops capabilities under a read-only root filesystem, and writes only its certificate/config
volumes. V1 accepts DNS hostnames and IPv4 only; IPv6 is rejected rather than left to a builder.

Fable approved the spec as Ben's delegate on 2026-08-10. Create its four ordered children after
#1403 and #1486 satisfy the prerequisite gate:

1. Opt-in Caddy Compose profile, including the exclusive Compose-owned setup-container TLS env
   wiring, non-secret Caddy env allowlist, effective non-root/drop-cap/read-only runtime, and
   rendered assertions. This is one Compose/Caddy/test surface.
2. TLS origin and scoped-proxy-trust setup, parallel with child 1: locked host-validation matrix,
   real setup subprocess tests, no-overwrite/no-TLS proof, and correction of the env example's
   independent `JARVIS_AUTH_BASE_URL` contract. This is one setup/helper/test/example surface.
3. Security-tier operator runbook after children 1-2 are code-complete with frozen contracts on
   open PRs. The Coordinator records one v1 proof OS/browser pair; the runbook gives exact trust
   steps for that pair and authoritative, explicitly unverified links for others. It also owns the
   bounded forwarded-header probes and honest ACME diagnostics: local config validation cannot
   preflight public DNS or inbound reachability.
4. Independent second-LAN-device live proof against an assembled integration candidate while the
   build PRs remain open. Dispatch only with that device, microphone permission, and a working
   transcription route configured through Settings using a secret that will not enter evidence.
   Run the real UI, health, rollback, and direct-1533 rate-limit/protocol spoof probes.

Children 1-3 may reach **code-complete, unverified** but their user-facing build PRs do not merge.
Child 4 attaches the real sign-in, secure-context, voice, service-worker, health, rollback, and
forged-forwarded-header evidence to every user-facing build PR before security QA/Fable sign-off
and merge. The parent remains open until those PRs and all four children close and the parent links
the evidence.

### #1488 — role-marker fencing follow-ups

The sol-high/high draft is now
`docs/superpowers/specs/2026-08-10-role-marker-fencing-followups.md`. It locks candidate-only NFKC,
an exact disjoint visible-token/horizontal/zero-width/colon grammar, the exact ten-role vocabulary,
intentional mutation of line-leading YAML/Markdown/code markers, stored `User:`/`Assistant:` recall
behavior, `[User]:` residual risk, and a linear two-pass role-marker stage. #1260's inherited outer
fixpoint is explicitly outside this task's complexity claim.

Fable approved the spec as Ben's delegate on 2026-08-10. Do not plan or build until #1259/#1260 and
every other prompt-safety PR are merged. Then re-ground the spec on the resulting `origin/main`
commit, recheck the owned files and caller inventory, and file one child:

1. One-session security-tier matcher plus recalled-memory and cross-tool composed contracts in
   `prompt-safety.ts` and the two focused renderer test files.

Independent QA must inspect the disjoint regex structure, exercise every approved zero-width
position and newline non-match, and record the cross-tool composed test failing before the matcher
change and passing after it. The approved spec's exact verification matrix supersedes the earlier
three-child and two-child sketches.

## Suggested Wave 7+ order

The ordering below is dependency-first. Ben/Coordinator may move an entire collision-free family,
but not violate the hard gates.

1. **Close the current batch:** Wave 3 lane A; Wave 5/#1449/#1259/#1260; W6 stage 1; PRs #1482,
   #1485, #1491, #1492. Prove #1491 live over HTTPS.
2. **Parallel spec track:** #1488, #1427, and #901 are sol-high-authored and Fable-approved. Builds
   wait only on their explicit dependency/collision gates and child-issue creation.
3. **Wave 7 — approved carry-forward, first slice:** W4-B, W4-A1, W4-C1, W4-D, and W6-C2, subject
   to their individual gates. Apply the preserved merge order; W4-D can open early but merges last.
4. **Wave 8 — carry-forward completion:** W4-A2, then W4-C2 → W4-C3; #1138 after W6-C2. Finish
   Wave 4 before touching #1339 external validation.
5. **Wave 9 — security follow-ups:** approved #1488 child; #1339 children; then #1137-A/B1 and
   the remaining #1137 children in their package chains. Never overlap chat-live, module-registry,
   or tasks chains.
6. **Wave 10 — backend lows:** #1140’s module-disjoint children, with CLI C → D serialized and the
   strict-budget decision made before G.
7. **Wave 11 — UI/design debt:** #1139 after #1482/#1449; then approved #1427 children after the
   Coordinator verifies #1440/#1327 have no live CSS collision.
8. **Wave 12 — distributable TLS:** approved #901 children. This can move earlier only after Ben
   settles the topology and the Coordinator confirms no collision with active infra/deployment work.

Before every wave, refresh Project 2 and open PR filenames. This proposal intentionally does not
reserve migration numbers, branches, panes, or agent labels; the Coordinator assigns those from the
then-current `main`.
