# Wave 4 — External-module supply-chain preconditions

**Date:** 2026-08-09
**Status:** Approved by Ben on 2026-08-09 (#1275 fork settled — see "Design forks — settled").
**Tracking epic:** #1470 (batch "Security, privacy, and trust boundaries"); unblocks #860 and #818
**Issues:** #942 + #943 (lane A) · #946 (lane B) · #1274 + #1275 + #1279 (lane C) · #1141 (lane D)
**Grounded on:** `origin/main` = `c8946358f`

## Context

Two approved epics — #818 (open module system, user-authored modules) and #860 (pluggable modules,
downloadable independently of the core image) — both have approved design specs already in the
repo (`2026-07-08-open-module-system-user-authored-modules.md`,
`2026-07-08-workflow-layer-pg-boss.md` for the sibling substrate). Neither can start while the
loader's trust boundary has known holes.

Every issue in this wave was found by an adversarial security pass on already-merged work
(#914/PR #941, #915/PR #945, #1110/PR #1122) and filed as **latent** — unreachable today because
the external-manifest loader is stubbed with an empty list. They stop being latent the moment #860
ships untrusted external module SQL. Closing them is the cheapest possible time to do it, and it is
the honest precondition for either epic.

## Goals

- **#942** — the module SQL single-statement validator must be dollar-quote aware, so a hidden
  second statement inside `$$…'…$$` cannot slip past the one-statement guard.
- **#943** — the module storage RPC must not leave `SET LOCAL ROLE` bound for the remainder of a
  `withDataContext` transaction.
- **#946** — close the six SSRF test-coverage gaps on the native host-fetch path and add the
  `::ffff:0:0/96` blocklist parity entry.
- **#1274 / #1275** — external-module manifest `inputSchema` patterns must be linted at install time
  and must not compile or match unconfined on the host event loop (ReDoS).
- **#1279** — external-module tools must be pinned to the shared gateway validator, with a test, and
  rejections must name the offending tool.
- **#1141** — the Claude auth-status probe must never fall through to the launching operator's
  ambient `process.env`; an empty credential map is not "use ambient env".

## Non-goals

- **This wave does not start #860 or #818.** No loader work, no module signing (#1319), no
  federation, no per-module migration ledger. Those are separate specs with their own waves.
- No change to the module install privilege model — install stays a privileged ops action.
- No new sandbox, isolate, or Worker boundary. #1275's fix is a bound on pattern compilation and
  matching, not a re-architecture.
- **No worker-thread pattern budget in this wave** — deferred by decision (see Resolved decisions),
  and no new dependency: the chosen static lint needs none.

## Lanes, tiers, and collision map

All four lanes are module-disjoint. Lane A's two issues share `packages/db` and must be one builder.
Lane C's three issues share `packages/module-registry/src/external/` and must be one builder.

| Lane | Issues              | Tier         | Module (exclusive)                                    | Intended seam                                                                                                                                                                            |
| ---- | ------------------- | ------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | #942, #943          | **security** | `packages/db`                                         | `packages/db/src/migrations/module-sql-runner.ts` (statement splitter); `packages/db/src/module-storage-rpc.ts` (`SET LOCAL ROLE` scope)                                                 |
| B    | #946                | **security** | `packages/host-fetch`                                 | `packages/host-fetch/src/index.ts`, `packages/host-fetch/src/policy.ts` — blocklist entry + six control tests                                                                            |
| C    | #1274, #1275, #1279 | **security** | `packages/module-registry/src/external`               | `packages/module-registry/src/external/validate.ts` and the gateway-validator binding                                                                                                    |
| D    | #1141               | **security** | `packages/chat/src/live` + `packages/ai/src/adapters` | `packages/chat/src/live/provider-probe.ts:44-49`; `packages/ai/src/adapters/tmux-bridge.ts:12-13,48` — mirror the correct pattern at `packages/cli-runner/src/terminal-session.ts:46-50` |

**Tier rationale:** every lane hits a `security` trigger — SQL policy injection (A), network-exposed
SSRF surface (B), untrusted-input validation and rate/ReDoS bounds (C), credential-environment
isolation (D). No downgrade is available.

**Cross-wave collision:** lane D touches `packages/ai/src/adapters` and `packages/chat/src/live`,
which Wave 3 lanes A and C also occupy. **Wave 4 must not run concurrently with Wave 3.**

## Resolved decisions

- **#942** — make the splitter dollar-quote aware for both `$$` and `$tag$…$tag$`. The acceptance
  artifact is a **negative** test: a blob with a hidden second statement inside `$$…'…$$` is
  rejected. Do not attempt full SQL parsing; the guard stays a splitter.
- **#943** — prefer the explicit `RESET ROLE` at the end of the RPC over a documented "terminal RPC"
  contract. A convention that must be remembered is not a control; a `RESET` is. Add a test proving
  `SET LOCAL ROLE` binds within the txn and that a subsequent core-table op runs under the original
  role.
- **#946** — all six items are test-coverage gaps on logic already verified present and correct,
  plus one blocklist parity entry. No behaviour change is expected; if a test reveals one, that is a
  new finding and gets escalated, not silently fixed.
- **#1141** — always pass an explicit minimal env (`HOME`, scoped `PATH`) following
  `terminal-session.ts`, rather than treating credential-map truthiness as an env-override signal.
- **#1275 ReDoS bound — SETTLED (Ben, 2026-08-09): a static complexity lint at install time.**
  `packages/ai/src/gateway/input-validation.ts:29-62` already caches compiled manifest patterns and
  fails closed on invalid ones (#1265 QA fix), and its own comment at `:35-36` names the gap: a
  declared `pattern` "compiles and matches here, on the host API event loop, unconfined and untimed."
  Lane C adds an install-time lint that rejects patterns failing a complexity bound.
  - _Why this over the alternatives:_ a worker-thread time budget genuinely bounds the damage but
    adds a thread hop to every validated call; narrowing the manifest to a non-backtracking subset is
    the strongest contract but is **breaking**, and the manifest schema is the model's only view of a
    module's tools, so narrowing it is a product decision, not a security fix.
  - **The worker-thread budget is deferred, not rejected.** The lint matches the current threat level
    because the external-manifest loader is still stubbed with an empty list. When #860 or #818 ships
    a loader that accepts untrusted modules, the budget becomes required — record that as an explicit
    precondition on whichever epic ships the loader, so it cannot be forgotten.
  - The lint is heuristic and will miss some constructions. Say so in the lint's own comment; do not
    let it be read as a complete ReDoS defence.

## Design forks — settled

**#1275 is settled** (static lint now, worker budget deferred — see Resolved decisions). Two smaller
forks remain for the lane's own plan to answer with code evidence, not for Ben:

1. **#943 blast radius.** Whether `RESET ROLE` suffices when the RPC is called inside a transaction
   that had already set a role for another reason, or whether save/restore semantics are needed.
   Lane A resolves this by reading the call sites; it is the difference between a one-line fix and a
   small helper, not a product decision.
2. **Sequencing against #860.** This wave is a precondition, not the epic. If #860/#818 are not next
   in the roadmap the wave still closes real security debt, but its urgency claim weakens and the
   coordinator may schedule it behind Wave 5.

## Exit criteria

- #942: a negative test with a hidden second statement inside a dollar-quoted body is rejected;
  a positive test proves legitimate dollar-quoted single statements still pass.
- #943: a test proves the module role binds inside the txn and that a later core-table operation in
  the same `withDataContext` transaction does **not** run under the module role.
- #946: all six named tests exist and pass, and the `::ffff:0:0/96` entry has a hex-form
  (`::ffff:a9fe:a9fe`) unit test.
- #1274/#1275: an install-time lint rejects an out-of-bounds `inputSchema` pattern with a message
  naming the offending tool; a known catastrophic-backtracking pattern is rejected at install rather
  than reaching `input-validation.ts`'s compile cache; and the lint's documented limits (heuristic,
  not a complete ReDoS defence) are stated in code alongside the deferred worker-budget precondition.
- #1279: a rejection message names the offending tool, and a test pins external-module tools to the
  shared gateway validator.
- #1141: a test proves an empty credential map does not resolve to ambient `process.env`, and that
  the probe reports the isolated identity rather than an ambient host CLI login.
- Every lane carries an Opus adversarial QA verdict posted as a `gh pr comment` and Ben's explicit
  merge sign-off.

## Dependency and merge order

Lanes A–D build in parallel. Merge B → A → C → D. Lane D merges last because it is the only lane
that touches modules Wave 3 also touched, so it takes the freshest rebase.

## Hard invariants honored

- **No admin private-data bypass.** Lane A hardens a path whose whole purpose is preventing a
  module from writing a permissive policy on its own table. Nothing widens a role's privileges.
- **Secrets never escape.** Lane D is precisely a secrets/credential-isolation fix. No lane logs a
  credential, token, URL, header, or body; #1279's rejection message names a tool id only.
- **Module isolation.** Lanes A and C strengthen the declared module boundary; no lane reaches into
  another module's internals or tables.
- **Never edit an applied migration.** No lane adds or edits a migration. Lane A changes the
  _runner_, not any applied SQL file.
- **Vault I/O goes through `VaultContext`.** No lane performs filesystem I/O.
- **`AccessContext`.** Untouched.
- **Provider-agnostic AI.** Lane D fixes the Claude-specific probe by generalizing the env
  discipline in `provider-probe.ts`; it must not encode Claude-only behaviour into the shared
  adapter.

## Process gates

- Approved. #1275 is settled; the two remaining forks are lane-internal and resolved from code by
  the lane's own plan, not by Ben.
- All seven issues already exist on GitHub. No new `task` issue is required.
- Live-Path Gate: no lane is user-facing. Each takes focused automated evidence plus adversarial QA
  instead. Lane D's probe behaviour should additionally be walked once on a host-mode dev harness,
  since that is the exact deployment mode where the leak is real.
