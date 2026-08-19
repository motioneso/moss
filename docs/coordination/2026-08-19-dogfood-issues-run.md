# Run manifest — 2026-08-19 dogfood issues follow-through (checkpoint 2)

Context-meter hit 70%. This is a flush-and-relay checkpoint. Read this section only — older
sections below (and git history for this file) are historical record, not current state.

## Everything from the original dogfood-issues run is done

PRs #1703 (#1698 calendar lifecycle), #1717 (#1711 all-day scheduling), #1726/#1727/#1728 (#1702
app-map descriptions) are all MERGED. Confirmed live via `gh pr view`, not agent self-report.

**Not yet done (low priority, no rush):** the four #1702 lane agent panes (`appmap-lane-a/b/c/d`)
are still alive and idle, each flagged "needs your attention" in Herdr — they finished their work
and are just waiting to be told to stop / have their panes closed. Their worktrees
(`.claude/worktrees/1702-appmap-lane-a/b/c/d`, plus `1698-calendar-lifecycle`) are still on disk.
Fine to leave; clean up next time you're in this area.

## In progress right now: PR #1684 (#1319 signed module catalog)

Ben provisioned the real Ed25519 signing keypair and set the two GitHub secrets
(`MOSS_MODULE_CATALOG_SIGNING_KEY_ID`, `MOSS_MODULE_CATALOG_SIGNING_PRIVATE_KEY`) himself — no
agent touched the private key (deliberate, see D8 in the code comment). I committed the public
half into `packages/module-registry/src/distribution/catalog-signing.ts`
(`MODULE_CATALOG_PUBLIC_KEYS`), pushed as commit `851f9ba70` on branch
`build-1319-signed-module-catalog` (worktree
`/home/ben/Jarv1s/.claude/worktrees/build-1319-signed-module-catalog`).

First CI run after that failed a real (not stale) test: `tests/unit/catalog-signing.test.ts` had
two assertions hardcoded to expect an empty trusted-keys list — correct when the keyring was
empty, wrong now that it's populated. Fixed by asserting against the real
`MODULE_CATALOG_PUBLIC_KEYS` constant instead of a literal `[]`. Verified locally (12/12 pass),
formatted with prettier, committed + pushed as commit `4dbafeb67`, same branch.

CI on PR #1684 is green.

**Real signature check done and it worked.** I published the module list for real, with the new
signing turned on, and then checked the signature the way a real install would. First attempt
used the wrong version of the publish workflow (the one still on the main branch, before this
change) so it published successfully but with no signature at all — a real but low-impact
mistake: it did overwrite the live module list people's installs read from, but with the exact
same three modules, just a refreshed timestamp, so nothing broke. Re-ran it correctly against
this pull request's own branch, which does have the signing turned on. That run produced a real
signature file, and checking it with the same code a real install would use came back verified,
with the right key name. This is the proof needed before merge — the actual mechanism, run for
real, with a real key, checked and correct.

**Still needed before merge: Ben's explicit sign-off**, since this is security-tier (signing/trust
material) — green CI plus this real-world check is not enough on its own per this project's rule.

## PR #1654 (#1252 audit-truth/SSRF hardening) — not part of this run, no action needed

Code-complete, but held on a separate blocker: the UAT test harness it needs for live-path proof
is broken and being fixed on its own branch (`fix-1659-uat-chatscript`, tracked via issue #1659).
Nothing to do here until that lands.

## Just finished: release notes backfill + AWAITING-BEN cleanup

Ben noticed `docs/WHATS_NEW.md` (rendered live in Settings → Recently Released) hadn't been
touched since 2026-08-14 despite lots of merges since. I backfilled the "Edge channel" section
with everything genuinely user-facing merged since then (Food module Phase 1, calendar lifecycle,
all-day scheduling, app-map description fixes, export-resume fix, UI polish, module backup/pin
fixes, a rolled-up security-hardening line). Committed locally as `05027e548` on branch
`merge-local-into-main-2026-08-18` (this repo's shared checkout — **note: this branch is NOT
`main`** and has no upstream tracking; it's this session's local accumulation branch for
coordination-doc-only commits, consistent with many earlier commits on it this session). Also
cleared two stale resolved entries from `docs/coordination/AWAITING-BEN.md` (committed `fe689ba70`,
same branch).

**Not yet answered:** Ben asked whether updating the release-notes page on every PR merge can be
automated, while noting the actual plain-English description still needs a human/agent to write
it — automation can't invent that part. My answer-in-progress (say this to Ben, don't re-derive):
full automation of the *writing* isn't realistic since it needs judgment about what's worth
mentioning and how to phrase it for a non-technical reader; what CAN be automated is the
*mechanism* — e.g. require every user-facing PR to carry a `## Release note` section in its body
(CLAUDE.md already asks for "a short user-facing summary in release-note language" on every
meaningful PR, just not in a machine-extractable format today), then a GitHub Action on merge
extracts that section and appends it to `docs/WHATS_NEW.md` automatically. That's a CI/CD pipeline
change — per this repo's rules that needs explicit confirmation before building, not silent
action. Recommend: (1) tighten the PR template / CLAUDE.md wording to require a clearly-marked
`## Release note` section, (2) THEN build the extraction Action once Ben confirms he wants that
built. Until then, treat "update the release page" as a standing coordinator merge-checklist item
(manual, like this backfill) — add it to `.claude/skills/coordinate/SKILL.md`'s Phase 3 merge
steps.

## Coordinator identity (for lock purposes)

Session id 26201b49-079c-409a-b5e0-4a60987ca935, pane w1:pG4, labelled "Coordinator", tab w1:t6.
This is a plain-English-only project per CLAUDE.md — no jargon in anything Ben reads, including
whatever picks this checkpoint up next.

## Prod updated 2026-08-19 (this checkpoint)

All three merges from today (#1684 signing phase 1, #1732 release-notes automation, #1735
release-notes backfill) are now live on prod (~/JarvisProd, edge channel). Pulled the fresh image
after its build finished (main commit ea5ce0ba7), recreated the Moss container, confirmed
/health/ready returns ok. No chat-path code changed today, so the chat smoke check wasn't run —
only docs/tooling and publish-side signing infra changed, nothing in the chat/tool-call path.

Everything from this session is done: #1319 phase 1 merged with real signature verification
(phase 2 — actually enforcing/checking the signature on install — stays open, tracked via a
comment on issue #1319), release-notes automation live going forward, backfill caught up through
today, prod deployed and healthy.
