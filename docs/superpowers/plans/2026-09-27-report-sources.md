# #2745 plan — morning report sources say what each source contributed

Issue: morning report sources say what each source contributed (#2745), part of #2521.
Gap: gap-check item 9 — the mockup's "What informed this briefing?" lists each source
with its time and what it contributed ("Calendar, 6:40am: meetings, lunch, travel,
and pickup."); live's "Sources" shows freshness and status only.

## Decision

Derive every contribution line on the reader from counts already saved on the run,
plus one additive backend count for goals. No migration, no DTO change, no job-payload
change, no prompt change. Tier stays routine.

Why not model-written lines: the synthesis prompt is explicitly forbidden from
inventing source facts, and a contribution sentence from the model would be
unverifiable prose. Counts saved at compose time are the record of what fed the
report. Topic nouns from the mockup example ("meetings, lunch, travel, and pickup")
cannot be reproduced honestly from counts, so lines name quantities and kinds
("4 events fed the schedule"), never topics. A source with no recorded items shows
no contribution line.

Why one backend line: every freshness row except goals already has a saved count to
derive from. The goals section is composed (packages/briefings/src/compose.ts:412)
but its count is never saved, so a selected goals source would show a time with no
contribution. Saving `goalsCount` fixes that with one additive field.

Rejected alternative: a per-source `contributions` block written at compose time
with pre-rendered sentences. Steelman: it would let old and new runs share wording
and could carry topics. Rejected because it duplicates data already stored, needs a
contract decision for every future source, and sentences frozen at compose time
cannot follow later copy changes. Counts plus one frontend formatter is smaller and
stays truthful for old runs (missing field means no line, which is honest).

## Seams (all verified on this branch)

- Reader Sources disclosure: apps/web/src/today/morning-briefing.tsx:474
- Row renderer and source labels: apps/web/src/today/briefing-freshness.tsx:31
  and :6. `formatTime`/`formatDate` with locale already used by the reader.
- Saved counts per source: packages/briefings/src/compose.ts:557
  (`commitmentCount`, `taskCount`, `calendarCount`, `calendarEventCount`,
  `calendarSignals`, `emailCount`, `emailMessageCount`, `emailSignals`,
  `vaultCount`, `chatTurnCount`, `notes`, `gaps`, `editorial`, `planSnapshot`).
- Goals has no saved count: compose.ts:412 (section built, count dropped).
- Freshness entries follow section keys: packages/briefings/src/freshness.ts:34.
  Realtime keys include tasks, commitments, chats, goals, day_plan: freshness.ts:25.
  Day-plan key: packages/briefings/src/plan-prose.ts:7.
- Editorial evidence (news stories, sports games/stories with counts):
  packages/shared/src/briefing-editorial-evidence.ts:77.
- Saved plan context (evening intent, blocks with counts):
  packages/shared/src/briefing-action-rows.ts:93.
- Tests pinned the "Sources" heading: tests/unit/morning-briefing.test.tsx:91.
  Coordinator approval (2026-09-27) retitles the disclosure to the mockup heading
  "What informed this briefing?" — nothing on main rules against it (the parity
  runner asserts no heading text; the settings "Sources" group is unrelated).
  Tests updated to the new heading in the same change.
- Visual-parity plan covers reader source provenance but not contribution lines:
  docs/superpowers/plans/2026-09-16-visual-parity.md:433 (morning amendment,
  read by section). No plan amendment needed: this adds no stored shape the plan
  does not already assume, beyond one additive count.

## Changes

1. `packages/briefings/src/compose.ts` — save `goalsCount: goals.count`
   alongside the existing counts. Additive only; old runs read as absent.
2. New `apps/web/src/today/briefing-contributions.ts` — pure function
   `contributionFor(source, sourceMetadata): string | null`.
   Exported signature only; no component code in this plan.
   Mapping (null means render no line):
   - `calendar`: calendarEventCount, else calendarSignals length.
   - `email`: emailSignals length, else emailMessageCount scanned.
   - `tasks`, `commitments`, `chats`, `vault`: taskCount, commitmentCount,
     chatTurnCount, vaultCount.
   - `goals`: goalsCount (absent on old runs, so null there).
   - `news`: editorial news stories length. `sports`: editorial sports
     games plus stories lengths.
   - `day_plan`: planContext present with evening intent or blocks;
     line names the saved evening blocks count, else null.
   - Gap-listed, zero-count, absent, or unknown sources: null.
3. `apps/web/src/today/briefing-freshness.tsx` — each row names the source,
   its absolute local time from `asOf` (mockup style "Calendar, 6:40am";
   "unknown" when asOf is null; realtime rows show the capture time), keeps
   the existing relative age, and adds the contribution line when non-null.
   Props gain `locale` and `sourceMetadata`; both are already held by the
   caller (`ReportBody`, morning-briefing.tsx:386).
4. App map in the same PR: update the morning-reader entry
   (`packages/shared/src/app-map-core.ts` or the owning manifest) so the
   sources disclosure truthfully describes time plus contribution lines.
5. PR Release note: Category Changed; title "Morning report names what each
   source added"; one plain sentence describing per-source time and
   contribution lines. PR body states rows name quantities (for example
   "4 events fed the schedule") rather than the mockup's topic words, and why:
   topics cannot be derived from the saved record without inventing them, so
   the visual reviewer must not count the wording difference as a gap.

## Determinism boundary

All row content renders from the saved run record. The model has no job here
and the synthesis prompt is untouched (guidance added: zero words). No
model-authored value enters user data, so no validator or diff acceptance
applies.

## Tests first (TDD)

- `tests/unit/briefing-freshness-ui.test.tsx`: contribution line per source
  from counts; no line for zero/absent/gap sources; absolute time shown;
  "unknown" with null asOf; old runs without goalsCount show no goals line.
- `tests/unit/morning-briefing.test.tsx`: reader Sources block shows time
  and contribution rows end to end; heading stays "Sources".
- Backend: extend the compose unit coverage asserting `goalsCount` is saved
  (sibling: tests/unit/briefings-compose.test.ts).
- Each test must fail against the current tree (no lines rendered today) and
  pass after the change.

## Verification (unpiped, expected exit 0)

- `pnpm vitest run tests/unit/briefing-freshness-ui.test.tsx tests/unit/morning-briefing.test.tsx tests/unit/briefings-compose.test.ts > /tmp/2745-unit.log 2>&1; echo "EXIT=$?"`
- `pnpm typecheck > /tmp/2745-tc.log 2>&1; echo "EXIT=$?"`
- `pnpm lint > /tmp/2745-lint.log 2>&1; echo "EXIT=$?"`
- Full gate only via the verify-gate skill, never piped, never on the shared
  dev database.
- Live-path proof: parity runner (tests/uat/visual-parity) on a disposable
  stack, never the shared dev database, never port 1533; capture the report
  sources section at 1440 and 375 as cropped images plus command and exit
  code posted as a PR comment.

## Kill gate

If the disposable-stack parity run cannot reach a readable Sources disclosure
(frames 1440/375), stop after phase 1 (merged unit-green code, no PR claim of
proof) and escalate to the coordinator. Owner of the call: coordinator.

## Stored-data / contract statement

One additive stored field (`goalsCount` in schemaless `sourceMetadata`); no
migration, no DTO or API change, no job-payload change, no prompt change.
Old runs render contribution lines for every source except goals.
