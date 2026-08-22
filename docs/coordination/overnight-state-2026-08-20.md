# Overnight run state — 2026-08-20

Live state doc for the session working through Food follow-ups and the issues after them.
Re-orient from this file after a compaction; do not re-derive from transcript history.

## In flight (all auto-merge enabled)

| PR | Issue | What | Status |
|---|---|---|---|
| #1769 | #1768 | assistant-tool path dropped module preferences; regression test | CI flake in `tests/unit/chat-drawer-surface.test.tsx` (passes locally); failed jobs re-run on run 32347525189 |
| #1772 | #1759 | settings link on Finance / Job Search / News module pages | CI running |
| #1773 | #1734 | sidebar no longer says "Modules" | CI running |
| #1774 | #1722 | redeploy script default port reads `PORT`, falls back to 3000 | CI running |

Watcher: `bash /tmp/watch-prs.sh` monitors #1769 and #1772 only. #1773 and #1774 are not watched.

## Verified facts (do not re-derive)

- The shared checkout `~/Jarv1s` sits on `build-1258-dev-instance-provisioning`, **not main**.
  Read anything for an audit through `git show origin/main:<path>`.
- External modules can never contribute a settings surface: `packages/settings-ui/src/scanner.ts`
  scans `packages/`, `node_modules/@moss-*`, `node_modules/@moss/` only. So Finance, Food and Job
  Search always land on the generic preferences page.
- No built-in module declares manifest `preferences`; they all contribute `settings` surfaces. The
  "settings split across two places" case in #1759 does not exist in the tree today.
- A module web surface gets React and nothing else from the runtime — no host `navigate`. A link
  out of a module must be a plain `<a>` and costs a full page load.
- Sports has no masthead settings link **by design** (Ben cleared that masthead 2026-07-07 and
  moved Manage onto `sp-ticker__head`). Do not add one back.
- `tests/unit/chat-drawer-surface.test.tsx` > "resets state on a flip in both directions" failed
  once in CI on run 32347525189 and passes locally on the same commit. Treat as flaky until it
  fails twice.
- A fresh worktree needs `pnpm install --frozen-lockfile` before vitest resolves workspace deps.

## Issue state posted tonight

- #1759 — full scope audit posted; items 1 and 3 shipped in #1765, item 2 does not exist, item 4 is
  PR #1772. Closes when #1772 merges.
- #1737 — one exit criterion has no live evidence: "log a meal in Chat, it appears on the Food page
  without a reload". The refresh mechanism is unit-tested; the user journey is not. Noted on issue.

## LIVE PROBLEM found 2026-08-20 08:45

**The module registry has not published since 03:51 today.** Five consecutive `modules-registry`
runs failed; nobody noticed. All three modules (finance 0.5.4, food 0.3.0, job-search 0.2.8) build
to different bytes than what is published under those versions. Users are being offered no module
updates, with no error anywhere a human looks. This is #1747 happening again while #1747 was open.

Bumped to finance 0.5.5, food 0.3.1, job-search 0.2.9 inside PR #1776 — it had to go there, because
the new check correctly fails its own PR while the tree is stranded.

**Still owed: a second bump after #1769 and #1772 merge.** Both change module bytes (food and
job-search), so merging them re-strands the registry. Their branches do not carry the new check
workflow, so nothing will catch it — this is a manual follow-up. #1773 and #1774 touch no module
and are safe.

## Update 2026-08-20 10:50 — #1723 done, PR #1779 on auto-merge

Everything below in the "still to do" list is now done. Committed as dcca4594c, rebased onto
current main (9107e9585, which carries #1776 and #1777), pushed, PR
https://github.com/motioneso/moss/pull/1779 opened and set to squash-auto-merge.

Both buildable items shipped. Item 3 ended up bigger than "add a limit to Food": the issue asks for
the SDK's expected shape for list tools, so the truncation rule and the number live in a new
`packages/module-sdk/src/list-limits.ts` and Food is its first caller. Validation of the caller's
`limit` deliberately stays with each module — modules already own an error type that maps to a 400.

Module versions bumped together: finance 0.5.6, food 0.3.2, job-search 0.2.10, each exactly one
above main.

**Trap worth keeping.** A new SDK subpath has to be wired in five places or it passes `tsc` and
fails at test time: the package `exports` map, root `tsconfig.json` paths, the consuming module's
own `tsconfig.json` paths, **both** alias maps in `scripts/build-external-module.ts` (worker and web
are separate), and `vitest.config.ts` — where subpath aliases must come before the bare
`@moss/module-sdk` alias. Missing the last two produced "Cannot find package
'@moss/module-sdk/time'" with a green compiler.

Item 2 posted on the issue as a design question for Ben (issue comment 5354217376): close it as
not-now, or name the feature that needs it. Nothing is blocked on the answer.

Verified green before push: both tsc projects, `check:external-modules`, all three external-module
builds, 6 vitest files / 82 tests, prettier and eslint over every changed file.

### Original entry (09:40, superseded above)

Worktree `.claude/worktrees/sdk-1723`, branch `sdk-1723`, off main at f881bdc0e. Nothing committed
yet.

Done so far:
- `packages/module-sdk/src/time.ts` (new) — local-day helpers, exported from the barrel. Intl only,
  no `node:*`, so the browser-safety test still holds. 26 unit tests pass in
  `tests/unit/module-sdk-time.test.ts`, including both DST days (a 23-hour and a 25-hour day).
- Learned: Node's `Intl` accepts legacy three-letter zones like `PST`, so `isValidTimeZone("PST")`
  is true. That is runtime behaviour, documented in the test, not a defect.

Still to do on this branch:
1. Point Food at the SDK helpers instead of its own vendored copy in
   `external-modules/food/src/domain/meal.ts` (and `todayLocalDate` at
   `external-modules/food/src/web/root.tsx:41`, which uses the browser's local date rather than the
   user's configured zone).
2. Item 3 — add `limit` to `food.meals.list` with a default and a documented maximum
   (`external-modules/food/src/tools/meals.ts:124`).
3. **Bump all three module versions in the same PR.** This branch changes `packages/module-sdk`,
   which is bundled into every module's `dist/`, so merging without bumps re-strands the registry.
   Current published: finance 0.5.5, food 0.3.1, job-search 0.2.9. The new
   `modules-registry-check` job will fail the PR if this is forgotten — that is the safety net from
   #1747 doing its job, not a broken PR.

Item 2 of #1723 (cross-module discovery) is a design question for Ben, not built. Module isolation
says modules collaborate only through declared public APIs and events, so a discovery API needs a
shape that does not become a back door.

## Update 2026-08-20 09:25 — registry outage over

#1776 merged and the registry published green (run 32352202467), the first success since 03:51.
#1747 and #1759 are closed. No follow-up version bump is owed.

Open PRs, both on auto-merge: **#1777** (#1721, bootstrap-owner ordering) and **#1778** (#1724,
Playwright install phase deadline). Both verified red-before / green-after locally, lint +
typecheck + format all exit 0.

Left for Ben on #1721, stated on the PR: how duplicate owner rows arise (a read-then-write race in
signup, `packages/auth/src/index.ts:455-464` then :523) and which owner wins if one must be
demoted. The flag grants real privilege, so a migration that demotes the extra owner removes a live
account's access.

## Update 2026-08-20 09:10

#1769, #1772, #1773 and #1774 are all MERGED. Open: #1776 (registry fix + version bumps) and
#1777 (#1721 bootstrap-owner ordering), both on auto-merge.

The registry publish on main failed again at 09:00 (run 32351649379) — expected, it is the same
finance 0.5.4 strand, and #1776's bumps are the fix. **The second bump I thought I would owe after
#1769 and #1772 is NOT needed**: food 0.3.1 and job-search 0.2.9 have never been published, so
#1776 merging last means its bumps already cover those merges' byte changes. Only re-check if
something else touching a module merges before #1776.

Watcher: Monitor `bw5c6o7ac` runs `/tmp/watch-1776.sh` — PRs #1776/#1777 plus the registry
publish run.

## Next candidates, in order

1. #1747 — IN PROGRESS, branch `registry-strand-1747`, worktree `.claude/worktrees/registry-1747`.
   Three fixes: publisher error message names the module and the shared package; new
   `--check` mode plus `modules-registry-check.yml` fails the PR that causes the strand;
   publish failure now files a GitHub issue. Verified `--check` locally — it reproduced the live
   strand above and agreed with CI exactly.
2. #1721 — investigated, NOT started. Findings worth keeping:
   - The flag grants real privilege, not just a marker: `packages/settings/src/routes.ts:909`
     gates a route on it, and a flagged user cannot be deleted, deactivated or demoted
     (`me-account-routes.ts:166`, `repository.ts:423,460`). So a migration that silently demotes
     the "extra" owner takes away someone's access. That needs Ben's call, not a default.
   - Likely root cause of two flagged rows: `packages/auth/src/index.ts` decides via
     `bootstrapOwnerExists()` then updates. Two first-time signups racing both read "no owner"
     and both get flagged. Fixing the lookups without closing that race just makes it rarer.
   - Safe work that needs no ruling: make all four lookups deterministic (add ORDER BY) and give
     the guard a distinct loud error when it finds more than one. Do that first; leave the unique
     index and any demotion until Ben rules on which owner wins.
3. #1723 — module SDK ergonomics. Blocked on merge order, not on design: items 1 and 3 change
   packages/module-sdk, which re-packs every module (see #1747), so it needs the module PRs landed
   and a version bump in the same PR. Item 2 (cross-module discovery) is a design question for Ben.
4. #1724 — CI Playwright browser install has no phase deadline.

## Standing constraints

- Dropped at Ben's explicit instruction: the per-food breakdown backfill / "re-analyse" action.
- Dev instance http://192.168.50.36:5173, API :3000, Postgres :55433. **:1533 is production —
  never a test target.**
- `gh pr merge --admin` is blocked by a ruleset; use `--squash --auto`.
- Never run the foundation gate or any DB-touching test without the `verify-gate` skill.
- Plain English in every chat message and every spawned agent brief.

## Update 2026-08-20 11:40 — #1723 merged, #1780 filed and fixed, Food live gap has an owner

- **#1723 / PR #1779: MERGED.** Shared local-day and list-limit helpers in the module SDK, Food uses
  both, all three module versions bumped. Item 2 (cross-module discovery) posted on the issue as a
  question for Ben, not built.
- **#1780 filed and fixed, PR #1781 open on auto-merge.** The chat drawer decided "is this session
  private" from two places with nothing ordering them, so a privacy response that landed just after
  the user pressed the toggle wrote its stale answer over the click — the drawer showed "not private"
  for a private session. Also the cause of the intermittent `chat-drawer-surface.test.tsx > resets
  state on a flip in both directions` CI failure. Guard proven load-bearing: removed, two tests fail;
  restored, twelve pass.
  - **Trap worth keeping.** The first version of that race test passed *with the fix removed*.
    react-query notifies through its own scheduler, so draining microtasks returns before the effect
    under test has run. Any test of this file that flushes with `await Promise.resolve()` pairs is
    measuring nothing; use a `setTimeout(0)` macrotask.
- **#1778 (Playwright install deadline) still open**, re-run after the flake above knocked it over.
- **#1737's last live assertion is blocked on Ben, not on code.** "Log a meal in Chat, see it on the
  Food page without a reload" needs a real chat turn, because write-risk module tools only execute
  inside one — the REST invoke path registers no waiter and returns 403 by design. A real chat turn
  needs a real model, and dev has only three `uat-fake-json-model` rows. Needs a provider key on a
  dev instance. Recorded on the issue (comment 5354523800) and queued through `needs-ben`.
  Deliberately did **not** insert a meal row straight into the database and call it proven — that
  exercises the page's re-read, not the journey, and would overstate the evidence.

Next up, in order, none blocked: #1662 (external-module-tools discards a sibling error and reports
failure as success), #1661 (audit notifier says "executed" when the audit log says it failed),
#1680 (sanitized errors redact by error type rather than by where the message is going).

## Update 2026-08-20 12:40 — #1662 shipped, #1661 in progress

**Merged since last entry:** #1778 (Playwright deadline), #1781 (#1780 private-chat race).

**#1662 — PR https://github.com/motioneso/moss/pull/1782, open on auto-merge.** Worktree
`.claude/worktrees/fix-1662`, branch `fix-1662`, commit b41eafbcb.

A module handler has one way to say "this failed": throw. Anything it returns is success. But every
module catches its own errors and RETURNS `{ status: "error", code, message }`. So a module
reporting a failure honestly got audited `success` and the user was told the action executed. When
the envelope also carried `data`, the error was not merely mis-audited but invisible — consumers
read only `.data`, so the model got a partial payload with nothing marking it partial.
`externalToolResult` now throws on that envelope. Nested error statuses (a bank link in an error
state, one failed item in a sync) are facts about the world, not failed calls, and are left alone —
a control test pins that. 8 tests; 4 fail with the guard removed.

**Trap worth keeping.** One of my own tests passed with the fix removed: a `try`/`catch` reading
`.code` also caught its own `expect.unreachable` and read `undefined` off it, which matched the
expectation. Any "throws with property X" test needs `toThrow` first and the property second.

**#1661 — NOT what the issue says.** The three call sites it names were already fixed on main long
ago (the ternary dates to #33). What is actually left is three pieces of wording drift, all in
worktree `.claude/worktrees/fix-1661`, branch `fix-1661`, uncommitted at time of writing:

1. `gateway.ts` — after a user approves a native tool, emitted "executed". That method decides
   PERMISSION and returns `decision: "allow"`; the tool runs outside the gateway, which never
   learns the result. The unattended-mode branch 40 lines up already says "allowed" and carries a
   comment explaining why (#1085 F4). This sibling was missed.
2. `gateway-notifier.ts` — "allowed" was hardcoded to read "Allowed by YOLO", so fixing (1) would
   have mislabelled a manual approval. Now "Allowed: <tool>".
3. `gateway-notifier.ts` + `message-row.tsx` — an error fell into the denial branch, so a tool that
   ran and failed was announced as "Not changed" / "Denied", while its audit row said `failed`. Now
   "Failed". "Not changed" was doubly wrong: a write that failed part-way did change things.

All three proven load-bearing individually (revert one, its suite goes red: 4, 3 and 2 failures
respectively). 53 tests green across the three affected files. Left deliberately alone and noted
for review: the peek line's "Changed" / "Not changed" chip still treats `allowed` as Changed, which
is the same overclaim in miniature — worth its own issue rather than widening this one.

Next after #1661: #1680 (sanitized errors redact by error type rather than by where the message is
going).

## 03:50 — #1661 shipped, #1784 filed, #1680 in progress

**#1661 done.** Committed `bc21e34f9`, branch `fix-1661`, PR #1783 open with auto-merge armed.
`pnpm typecheck` rc=0, prettier rc=0, eslint rc=0. Both #1782 (#1662) and #1783 sit at
`mergeStateStatus: BLOCKED` waiting on the "Verify foundation and app" CI job — that is the normal
pre-merge state, not a failure.

**#1784 filed** for the chip left alone above: `message-row.tsx:196` still counts `allowed` as
"Changed" and `error` as "Not changed". Written up as a design question rather than a rename,
because what the chip *should* say for an outcome the host never observed is a real decision.

**#1680 in progress** — worktree `.claude/worktrees/fix-1680`, branch `fix-1680`, uncommitted.

The issue understates it. The filed finding is that `sanitizedErrorMessage` (packages/notes/src/jobs.ts)
redacted by error type, so a raw errno message from the #1671 path resolver — Node builds those as
`EACCES: permission denied, lstat '<path>'` — reached the owner-scoped `lastError` field with the
caller's own requested path in it. True, but the larger hole is one level down: the worker's own
catch in `registerNotesWorkers` wrote `error.message` into that field with **no sanitizer at all**,
so every failure raised outside the per-file loop bypassed redaction entirely. The per-file guard
was decorative for those paths.

Fix, per the Fable direction (redact by sink, not by type): new `packages/notes/src/error-sink.ts`
holding the only function allowed to produce a string for that field. It never passes an arbitrary
`message` through. A real sentence reaches the user only when this module composed it, or when a
throw site opted in explicitly by throwing the new `NotesSyncFailure` (which the two total-failure
throws now do, so they keep their file counts). Everything else is described by errno code or class
name, both bounded by regex — neither is built from input, so neither can carry a path. An error
type nobody has thought of degrades to a generic line instead of leaking; that default is the whole
point and is what a type-keyed allowlist could not give.

Verified: 7 new tests pass; revert to the old type-keyed logic and 5 of the 7 go red. Wider notes
suite 28 passed across 5 files, rc=0. prettier and eslint rc=0. Typecheck running.

Scope note recorded on the PR: the original error is still rethrown to pg-boss, so full messages
stay in the server-side worker log where an operator needs them. Only the user-facing sink is
redacted.

## 05:10 — #1711 investigated, finding recorded, nothing built

Three PRs open with auto-merge armed, all three still running "Verify foundation and app"; every
other CI job green. #1782 (#1662), #1783 (#1661), #1785 (#1680). Nothing to do but let them land.

Picked up #1711 (all-day calendar events block focus-block scheduling) as the next issue needing no
ruling from Ben. It turns out to have been fixed already by `480292bd6` / PR #1717 — the issue is
open only because nobody closed it. But the shipped fix has a hole, and it is worth someone's
attention before the issue is closed:

`isAllDayInterval` (`packages/calendar/src/focus-time.ts`) recognises an all-day event by its
geometry — both endpoints on local midnight, duration a whole multiple of 24h. The production
caller (`packages/chat/src/calendar-write-impl.ts:125-135`) queries freeBusy with the part-of-day
band as the window, e.g. 09:00–12:00 local. If Google clips busy intervals to `timeMin`/`timeMax`,
an all-day event arrives as 09:00–12:00: not midnight-aligned, not a 24h multiple, so the filter
misses it, it spans the whole band, and `chooseSlot` returns no-clear-slot — precisely the reported
symptom.

No test can see this. Every case in `focus-time.test.ts` hands the helper a midnight-to-midnight
interval it built itself. The helper is correct on that input; the suite would stay green whether
or not the feature works.

Could not settle the premise. Google's own freeBusy reference documents the response schema and is
silent on boundary behaviour. A third-party guide (Nylas) states plainly that intervals are clipped
and that you should widen the window or use `events.list` if you need true extents — secondary
evidence, not proof. Settling it empirically needs a live Google-connected account, which this
session does not have.

Deliberately did not build. The fix that is correct under **both** readings is to separate the
query window from the search window: ask freeBusy for the whole local day(s) the band falls in,
filter, then run `chooseSlot` against the narrow band as today. Harmless if Google does not clip,
necessary if it does, one API call either way, no `events.list` (which the original design rejected
because it leaks event titles and guest lists for what is only an availability question). Worth
adding alongside: a test that feeds the pipeline a *clipped* interval — the assertion the suite is
missing, and one that fails today.

All of this is written up on the issue as comment 5354893624.

## 06:05 — #1711 built after all, PR #1786

Reconsidered and built it. The widening is correct whether or not Google clips, so it is not a
speculative fix — it removes a dependency on undocumented behaviour rather than betting on one
reading of it. Leaving a known hole in place while the answer was unavailable was the worse option.

`freeBusyQueryWindow()` in `packages/calendar/src/focus-time.ts` expands a window to the whole local
day(s) it touches; `proposeAndInsert` queries that and lets `chooseSlot` narrow back to the band,
which it already did by discarding non-overlapping intervals. One API call, no `events.list`.

The test that matters: `tests/unit/calendar-all-day-freebusy.test.ts` fakes a freeBusy that **clips
the way Google does**, so it exercises the caller's real query window instead of a hand-built shape.
That is the whole reason the existing suite could not see the bug.

Verified: 30 unit tests rc=0; 36 calendar integration tests rc=0 on isolated DB `jarvis_gate_1711`
(dropped afterwards), including Group D, the faked-Google impl suite; typecheck rc=0; prettier and
eslint rc=0. Knockout: restore the band-width query and 2 tests go red, including the end-to-end
reproduction.

Live-path status recorded on the PR as **code-complete, unverified** — proving it against the real
API needs a Google-connected dev account, which this session does not have. The live check is one
line: all-day event on a day, ask for a morning focus block that day, confirm it schedules.

Board at this point: #1782 merged. #1783 (#1661), #1785 (#1680), #1786 (#1711) open with auto-merge
armed, all still running "Verify foundation and app".
