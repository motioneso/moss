# Coordination Run — 2026-08-23 clear-in-progress

**Date:** 2026-08-23
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`,
**stable anchor = Codex session id `01a02f0e-05d0-7e61-9a20-c87b7a7f9305`** (match
`agent_session.value` in `herdr agent list`). Exactly one live agent named `coordinator` whose
session id matches this anchor holds authority. Pane ids are ephemeral; resolve fresh by name and
immutable session id.
**Approval authority:** Ben. Manifest explicitly approved on 2026-08-23.
**Merge policy:** autonomous after exact-head green QA for routine/sensitive lanes; security lanes
require independent Opus QA and Ben's explicit merge approval. UI/live features also require a
durable live-path proof comment.
**Relay policy:** Codex successors only for the remainder of this run.
**merges_since_relay:** 0

> GitHub project 2 is source of truth. This manifest holds only operational state.

## Queue

| Spec | Issue | Tier | Status | Agent name | Pane | Branch | PR |
| ---- | ----- | ---- | ------ | ---------- | ---- | ------ | -- |
| `docs/superpowers/specs/2026-08-17-1319-signed-module-catalog.md` | #1319-A (concrete child of #1470) | security | plan approved — building | `build-1319a-phase2-b` | `w1:pQ3` | `build/1319a-catalog-verify` | — |
| `docs/superpowers/specs/2026-08-19-926-food-day-view-components-and-targets.md` | #1737 (concrete child of #926) | routine | closed/Done — Ben verified working in production; lane cancelled/reaped | reaped | — | deleted | — |
| `docs/superpowers/specs/2026-08-23-1794-release-notes-protected-main.md` | #1794 | sensitive | queued | — | — | — | — |
| `docs/superpowers/specs/2026-08-23-1883-vault-search-mcp-errors.md` | #1883 | security | relay pending; revised security plan required before code | `build-1883-vault-errors` | resolve live | `build/1883-vault-mcp-errors` | — |
| `docs/superpowers/specs/2026-08-23-1884-weather-settings-card.md` | #1884 | routine | approved build mid-task 3; relay pending after progress commit | `build-1884-weather-settings` | resolve live | `build/1884-weather-settings` | — |

## Scope decisions

- #1470 is an epic, so this run takes its next concrete ready child, #1319. PR #1684 delivered
  catalog signing; this lane is limited to the approved installer-verification remainder.
- #926 is a feature roll-up, so this run takes #1737. PRs #1744 and #1767 already delivered the
  code. The lane first performs the remaining real-model journey: log food through Chat, observe
  the Food page update without reload, and expand item rows. If green, it closes as a verified
  no-op. If the environment cannot provide the required real-model access and only Ben can do so,
  the coordinator records the exact blocker in `docs/coordination/AWAITING-BEN.md` and runs
  `needs-ben`; the lane does not idle.
- #1737 pre-spawn re-check on 2026-08-23 found `JARVIS_UAT_REAL_CHAT_TOKEN_FILE` configured,
  readable, non-empty, and decryptable without exposing its contents. This clears the prior
  fake-model-only preflight blocker; the verification lane still must prove the credential works
  in the isolated live journey.
- #1794 keeps release-note writes on a branch/PR and never pushes directly to protected `main`.
- #1883 starts from a deterministic failing vault-search MCP request, then surfaces only safe cause
  classification; secrets, vault content, embedding inputs, raw bodies, and stack traces remain
  prohibited.
- #1884 is presentation-only: one Weather card and a binary unit toggle that displays `C` or `F`
  for its current state, reusing the existing metric/imperial API and JDS vocabulary.

## Dependencies, collision groups, and merge order

The one-shot Opus collision map is `~/Jarv1s/collision-map-1319-1737-1794-1883.md`. It found no
source-file collisions and no migrations in this run. The only shared artifact is the release-note
page; after every preceding merge, affected lanes rebase and re-run the append script rather than
hand-merging it.

- **Wave 1:** #1883, #1884, and #1319-A may build in parallel after current `main` CI is green and
  this manifest is approved. #1737 joins only if a pre-spawn check confirms a real chat model is
  available. Hold #1794 for wave 2 to stay inside the four-builder-pane comfort limit; it is the
  least urgent lane and must merge last anyway.
- **#1319 split:** #1319-A is plan phase 2 (fetch-time verification, snapshot cache, response
  envelope). #1319-B is plan phases 3-4 (enforcement, 409/override contract, settings UI, end-to-end
  and live proof). They touch the same files and are strictly serial. B branches from `main` only
  after A merges.
- **Wave 2:** #1319-B after #1319-A merges, plus #1794. They have disjoint source files.
- **Merge order:** #1883 -> #1884 -> #1319-A -> #1737 (issue-evidence close/no PR if verified) ->
  #1319-B -> #1794.
- #1883, #1319-A, and #1319-B each require adversarial Opus QA and Ben's explicit merge sign-off.
  #1883 review treats any exception-message-derived output as a leak channel; safe fixed
  classifications are the intended boundary.
- #1794 merges last because it rewrites release-note shape and changes the process instructions
  followed by other lanes. Its acceptance proof requires a real PR merged after it, so the run's
  small closing coordination-docs PR/commit is reserved as the trigger and the lane is not complete
  until that proof is recorded.
- #1884's user clarification supersedes the collision review's segmented-control suggestion: the
  binary toggle displays only the active letter, `C` or `F`. It still reuses existing JDS control
  vocabulary and remains isolated to the personal-settings surface and focused test unless the
  approved plan demonstrates a minimal shared-control change is necessary.

## CI waivers

| Check | PR | Proven red on `main` @ SHA | Proof | Ben-approved |
| ----- | -- | -------------------------- | ----- | ------------ |
| none | — | — | — | — |

## QA history

None yet.

## Plan approvals

- #1319-A phase-2 plan `docs/superpowers/plans/2026-08-23-1319a-phase2-catalog-verify.md`
  approved as written. It covers raw-byte verification, atomic snapshot caching, the response
  envelope, authorization-before-fetch testing, and the signed-index e2e baseline; phases 3-4,
  enforcement, override, UI, UAT, and migrations remain excluded. The planning session reached
  72% before code and was instructed to relay to a fresh Sonnet successor before building.
- #1884 plan `docs/superpowers/plans/2026-08-23-1884-weather-settings-card.md` returned once for an
  accessibility fork, then approved after correction. The visible thumb letter remains
  `aria-hidden`, while the native checkbox's dynamic accessible name explicitly states
  `Temperature units: Celsius` or `Temperature units: Fahrenheit`; focused tests and the existing
  live UAT assert both states. No new ARIA role, component family, API, or persistence change.

## Starting-point gate

- Ben approved this manifest; latest `main` CI run `32649714543` completed fully green at
  `4ee77dbd2152665defa15604aff0f71123178613` before branches were cut.
- #1319, #1883, #1884, and #1794 are In progress on project 2. #1737 was moved from In progress to
  Done after Ben directly verified in production that the issue works and meals break into their
  individual items properly; #1737 closed and its unused lane/worktree/branch were reaped.
- Starting comments were posted on all five concrete issues and parent epics #1470/#926 with the
  exact scope, tier, ordering, and CI gate.

## Outstanding escalations

- #1883 plan is not yet approved. The successor must revise it so classification of first-party
  thrown values is total and fail-safe even for hostile top-level values and hostile nested
  `cause` values. Add first-party hostile Proxy/getter tests proving generic output, no leak, and
  no classifier rethrow; preserve the existing untrusted #1251 test. No code before coordinator
  approval of that revision.
- #1319-A reported one unexplained loss of uncommitted Task A edits in its isolated worktree. The
  lane is redoing and committing immediately. Treat a second occurrence as stop-the-line and
  investigate shared-worktree integrity before more edits.

## Reaped sessions

- Unspawned #1737 verification lane: worktree `~/Jarv1s/.claude/worktrees/1737-food-live` and branch
  `verify/1737-food-live` removed after production verification; it contained only the handoff doc,
  had no PR, tracked changes, or live process.
- #1319-A planning session `build-1319a-catalog-verify`, Claude session
  `decd65fd-48f6-42f8-ace6-290f737189f8`, reaped after committing the approved plan/relay handoff
  and confirming successor `build-1319a-phase2-b` (session
  `d36ff98a-4ba2-46d0-9582-8dc383f55dc6`) driving on Sonnet in the same worktree/branch.

## Latest continuation note — Codex relay

Compaction tripwire fired before any merge. Current coordinator authority is Codex session
`01a02f0e-05d0-7e61-9a20-c87b7a7f9305`; successor must replace the lock with its own
`agent_session.value`, remain Codex-only, and resolve/reap this outgoing coordinator by pane label
`Coordinator` plus that exact session id. Fleet sweep at handoff: #1319-A successor is driving on
Sonnet and redoing its reverted Task A edits; #1883's old Sonnet session is compacting with the
security-plan correction queued and no successor visible yet; #1884's old Sonnet session is still
running typecheck after its relay notice and no successor is visible yet. First action after
adoption: resolve both build relays fresh, verify each successor is driving on Sonnet, resend the
#1883 security fork, reap only the old relay sessions, square the three-pane Builders layout, and
update issue comments plus this manifest. Do not merge during adoption. Merge order remains
#1883, #1884, #1319-A, #1319-B, #1794; #1737 is already closed/Done.
