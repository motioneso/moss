# VP-PLAN-R2 — approved session-sized remainder

Status: APPROVED by Ben on 2026-09-17 ("approve", confirmed by PM).
Approval covers the ordered decomposition and regional intermediate acceptance
with designated full-image completion owners. Finalized by Architect for PM's
timeline update. The existing filename is retained to preserve shared links.
No live timeline, P1 record, product file or existing proof contract changed.
This approved plan does not replace the required per-task dispatch records.
Source: merged VP-PLAN-R1 sections 1–3, P2–P8 and completion, and VP-SPEC-R2
sections 4, 5, 7 and 8, read on primary commit
37aded6086278be4046b10f2f6d7f110b3715eb9.
P0, P0.5 and P1 are completed prerequisites. The remaining work begins with
`proof-case-selection`; this plan does not claim whole-feature completion.

## Approved sizing and acceptance change

Replace seven broad product slices with 26 product tasks below. First perform
one bounded proof-readiness task: 27 tasks total, ordered and individually merged.
Desktop/phone views of the SAME state stay together; automatic/proposed,
News/Sports, successive steps and save/handoff states do not.

The approved plan/spec amendment is: intermediate tasks accept only
their predeclared owned region against the mockup, while retaining full populated
captures and base/head guards for every affected image. The named completion
owner below accepts each FULL image once its constituent regions are complete.
Regional acceptance is never reported as full-image acceptance. Without this
change, the existing whole-image rule would force unfinished sibling surfaces
back into the same task and defeat the requested resize.

Keep <=0.5% comparable-pixel differences, <=2px geometry, exact typography and
colours, generated-text mask limits, contrast, actor/data safety and the full
static gate. No new identity masks or relaxed thresholds. Preserve strict fresh
pair identity and current-head proof. Previously accepted regions must not regress.

Each task has ONE independently runnable product boundary plus the established
common checks. This does not mean one screenshot or exemption from required
cross-surface guards. No product task also builds capture/matrix infrastructure.
If a necessary proof capability is missing, stop before dispatch and propose a
separate bounded infrastructure task; update the approved timeline first.

## Historical completed prerequisites

These prerequisite records remain part of the authoritative plan history and
are not replaced by the 27-task remainder below.

### P0 — `p0-parity-tooling`

P0 delivered the real-stack parity runner, shared populated fixture, 32 mockup
capture/diff/report path, light-theme token alignment and declared baseline
dimension debt. Its historical targets were exact mockup capture regions from
spec section 3.1, all 32 report entries, deterministic repeated captures,
real disposable-stack data, generated-text-only masks, and Tasks, Calendar,
Settings and Today populated guards at 1440 and 375. Its files included the
parity UAT spec/helpers, fixture seams, tokens and the bounded design-token
check; regressions were the existing unit/e2e suites and the host-scoped seam
test. P0 was accepted through PR #2522, merged as
`cd2411dc62a4fbbf236db0985c496d38960fce98`, with final head
`4fec08fbae729199ed22b60b1503e3c3a1a95744`; its baseline visual RED was
measurement evidence, not a claim of product parity.

### P0.5 — `p0.5-plan-docs`

P0.5 published exactly these two repository documents from the approved
workspace sources, with repository-relative links and the approved metadata:
`docs/superpowers/specs/2026-09-16-visual-parity.md` and
`docs/superpowers/plans/2026-09-16-visual-parity.md`. It changed no product,
test, fixture, image or proof implementation. P0.5 was accepted through PR
#2524, merged as `37aded6086278be4046b10f2f6d7f110b3715eb9`, with pushed head
`f59d29c5e97a94c4db4a6d98c4db98ed19361ebb`; its docs/static checks and bounded
changed-path check were green.

### P1 — `p1-shell-navigation`

P1 delivered the app-wide pale shell navigation and assigned populated Tasks
toolbar overflow correction. Its owned regions were x=0..194 of
`morning-1440-news.png` and y=0..64 of every 375 Today capture; its files
included the shell navigation/app-shell markup, shell CSS, nav storage/tokens,
and the named Tasks toolbar styles plus the shared parity harness checks. Its
guards covered Today, Tasks, Calendar, Settings and Chat at 1440 expanded and
rail, 1180, 920 and 375; regressions covered navigation names/order,
collapse/reload/expand persistence, phone drawer/focus behavior, Chat and
populated Tasks controls. P1 was accepted through PR #2525, merged as
`c0e86d51348968e68eae7fe0fb1dad116ca2a5c8`, with final pushed head
`3414eb6e8e40db39bdcb46e023bd047b8996dab2`. Its accepted R4 evidence remains
historical; it does not accept any later P2–P8 image or whole feature.

## Ordered task list

Keys below are the approved stable timeline keys. Counts refer to owned reference
images, not total guard/theme/evidence artifacts. Prefixes today/, morning/ and
evening/ mean the three asset directories in spec section 4; names omit .png.

| Order / key              | One owned surface or behavior                                                    | Independently runnable boundary / full-image owner                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `proof-case-selection` | Existing parity runner: explicit case manifest and selection, no product changes | Select one existing populated desktop/phone case pair plus declared guards; missing/duplicate case or base artifact fails; unselected cases cannot be claimed. Retain one timed disposable-stack proof. Reuse P0/P1 machinery; implement only missing selection/manifest checks. |
| 2 `p2-morning-hero`      | Morning hero, headline/summary and prepared time                                 | Hero region at 1440/375 in both opening variants; morning entry/reload. Other Today content is a base guard.                                                                                                                                                                     |
| 3 `p2-weather-links`     | Weather row and section-jump row                                                 | Weather/links regions in both morning opening variants at 1440/375; jump targets and populated weather.                                                                                                                                                                          |
| 4 `p2-timeline`          | Preparation timeline                                                             | Populated meeting/task/preparation rows at 1440/375; row actions and reload.                                                                                                                                                                                                     |
| 5 `p2-action-rail`       | Quick-action rail and its Meds dialog interaction                                | Rail layout at 1440/375, Meds Escape/focus return, no missing/extra owned headings. Full completion owner of all FOUR today/morning-{1440,375}-opening and -opening-weather images.                                                                                              |
| 6 `p3-evening-summary`   | Evening recap and unresolved commitments                                         | Owned summary regions at 1440/375 using evening seed; morning guards.                                                                                                                                                                                                            |
| 7 `p3-tomorrow-entry`    | Tomorrow summary and Plan tomorrow entry                                         | Entry opens the existing dialog and preserves focus behavior; full owner of TWO today/evening-{1440,375}-opening images.                                                                                                                                                         |
| 8 `p4-news`              | News lead and secondary stories                                                  | Populated photo/headline/secondary items, link action and news opt-out; full owner of TWO today/morning-{1440,375}-news images.                                                                                                                                                  |
| 9 `p4-sports-scores`     | Four-score block and followed-team imagery                                       | Four populated scores, followed teams first, fixture images load without 404, sports opt-out; score region at 1440/375.                                                                                                                                                          |
| 10 `p4-sports-recap`     | Sports photo recap and Tonight block                                             | Populated photo/recap/Tonight; full owner of TWO today/morning-{1440,375}-sports images.                                                                                                                                                                                         |
| 11 `p5-reader-frame`     | Shared morning reader frame                                                      | Header/title/tabs/footer, open/close/focus, phone viewport cap and footer back slot at 200% zoom. Frame region in Read/Review cases; evening dialog guards. No narrative/review-row work.                                                                                        |
| 12 `p5-automatic-read`   | Automatic Read content and schedule rail                                         | Prepared line, narrative/callout, schedule and phone disclosure, rail heading; full owner of TWO morning/{1440,375}-automatic-read images.                                                                                                                                       |
| 13 `p5-proposed-read`    | Proposed Read state                                                              | Proposed content/status with accepted reader frame; full owner of TWO morning/{1440,375}-proposed-read images.                                                                                                                                                                   |
| 14 `p5-reader-news`      | Reader News link treatment                                                       | Populated news link and destination behavior; full owner of morning/1440-news.                                                                                                                                                                                                   |
| 15 `p5-reader-sports`    | Reader Sports link treatment                                                     | Populated sports link and destination behavior; full owner of morning/375-sports.                                                                                                                                                                                                |
| 16 `p6-automatic-review` | Automatic Review state                                                           | Review rows/status at desktop/phone; Read tab guards; full owner of TWO morning/{1440,375}-automatic-review images.                                                                                                                                                              |
| 17 `p6-proposed-review`  | Proposed Review rows and accept controls                                         | Proposed rows, individual/bulk accept path, checked/pending semantics; full owner of TWO morning/{1440,375}-proposed-review images.                                                                                                                                              |
| 18 `p6-partial-review`   | Partially accepted Review state                                                  | Seed mixed accepted/pending rows, preserve accepted data and status, reload; full owner of morning/partial-review.                                                                                                                                                               |
| 19 `p7-tomorrow-data`    | Tomorrow day selection in existing evening rail                                  | Real seeded today/tomorrow distinction; behavioral regression must fail on base and pass on head. No rail/frame redesign; retain populated visual guards.                                                                                                                        |
| 20 `p7-evening-frame`    | Shared evening dialog frame                                                      | Header, numbered steps, persistent footer and tomorrow rail; phone bounds and step navigation. Frame regions across steps 1–4; morning dialog guards.                                                                                                                            |
| 21 `p7-reflection`       | Step 1 prompt/reflection choices                                                 | Reflection selection and next/back preserve state; remove only this step's unapproved headings; full owner of TWO evening/{1440,375}-0 images.                                                                                                                                   |
| 22 `p8-commitments`      | Step 2 commitment choices                                                        | Populated choice cards, choose/undo/back/next preserve state; full owner of TWO evening/{1440,375}-1 images.                                                                                                                                                                     |
| 23 `p8-capacity`         | Step 3 capacity and primary task                                                 | Capacity/task controls and tomorrow rail, state preservation; full owner of TWO evening/{1440,375}-2 images.                                                                                                                                                                     |
| 24 `p8-review`           | Step 4 review groups and save entry                                              | Changes / Keep as they are / No change groups, save control and back navigation; full owner of TWO evening/{1440,375}-3 images.                                                                                                                                                  |
| 25 `p8-changed-review`   | Step 4 changed-plan state                                                        | Seed changed choices and verify exact review grouping and values; full owner of evening/changed-plan-review.                                                                                                                                                                     |
| 26 `p8-saved`            | Saved confirmation state                                                         | Save once, no duplicate/lost changes, persisted status/reload; full owner of evening/changed-plan-saved.                                                                                                                                                                         |
| 27 `p8-phone-handoff`    | Phone saved handoff                                                              | Populated saved phone state through morning handoff, T21 boundary; full owner of evening/changed-plan-handoff-phone.                                                                                                                                                             |

Full-image accounting: Today 4+2+2+2=10; morning 2+2+1+1+2+2+1=11;
evening 2+2+2+2+1+1+1=11. All 32 existing mockups retained, no additional
product feature. Earlier tasks still capture every affected image as required.

## Delivery timeline

Exact ordered rows for PM to place after the existing completed P1 row on #2521.
Preserve completed P0/P0.5/P1 rows and their keys/status; replace the old future
P2–P8 delivery rows with these, rather than maintaining duplicate task lists.

- [ ] [task:proof-case-selection] Proof readiness: explicit case selection and required evidence
- [ ] [task:p2-morning-hero] Morning hero, summary and prepared time
- [ ] [task:p2-weather-links] Weather row and section links
- [ ] [task:p2-timeline] Preparation timeline
- [ ] [task:p2-action-rail] Quick-action rail and Meds interaction; complete morning opening images
- [ ] [task:p3-evening-summary] Evening recap and unresolved commitments
- [ ] [task:p3-tomorrow-entry] Tomorrow summary and planning entry; complete evening opening images
- [ ] [task:p4-news] News lead and secondary stories
- [ ] [task:p4-sports-scores] Sports scores and followed-team imagery
- [ ] [task:p4-sports-recap] Sports recap and Tonight; complete Sports images
- [ ] [task:p5-reader-frame] Morning reader frame and responsive footer
- [ ] [task:p5-automatic-read] Automatic Read content and schedule
- [ ] [task:p5-proposed-read] Proposed Read state
- [ ] [task:p5-reader-news] Reader News links
- [ ] [task:p5-reader-sports] Reader Sports links
- [ ] [task:p6-automatic-review] Automatic Review state
- [ ] [task:p6-proposed-review] Proposed Review and accept controls
- [ ] [task:p6-partial-review] Partially accepted Review state
- [ ] [task:p7-tomorrow-data] Tomorrow selection in the evening rail
- [ ] [task:p7-evening-frame] Evening dialog frame and navigation
- [ ] [task:p7-reflection] Reflection choices; complete step 1 images
- [ ] [task:p8-commitments] Step 2 commitment choices
- [ ] [task:p8-capacity] Step 3 capacity and primary task
- [ ] [task:p8-review] Step 4 review groups and save entry
- [ ] [task:p8-changed-review] Changed-plan review state
- [ ] [task:p8-saved] Saved confirmation and persistence
- [ ] [task:p8-phone-handoff] Phone saved state and morning handoff

Mandatory prerequisite: with P1 already merged, `proof-case-selection` runs before
`p2-morning-hero` or any other dependent product task. Its proof demonstrates
explicit selected-case/guard accounting, required baseline failure checks and
one timed populated desktop/phone run. Reuse existing capabilities; no product
changes. Its measured timings determine admission of the first product record.
After it merges, PM and Architect may dispatch up to five ready product lanes
when their dependencies, files and mutable resources do not overlap. Serialize
only real dependencies, shared files or shared mutable resources; the canonical
task-list order is not a blanket dependency chain. Each lane still has its own
branch, worktree, evidence path, review, CI and proof boundary, and a failed lane
stops only that lane and its dependents.

PM operating decision (Ben, 2026-09-17): PM may adapt task execution when
repeated friction or failures expose a workflow weakness, provided the approved
spec/plan order and review/proof/merge gates remain intact. The
`proof-case-selection` prerequisite must consolidate the P1 lessons: one
branch-owned authoritative harness, a fast populated-data/Chat/responsive
preflight, visible-content readiness instead of network-idle, fixture request
logging, a deliberate comparison-system control, automatic baseline checksums
and failure artifacts, and one short smoke case before the full matrix.

## Session-size admission check

Recorded P1 harness debt (smoke4): replace raw Evening API-summary-to-body matching
with a tested understanding of the rendered heading/body contract. The populated
page separates the h1 from the body; the first 120 API-summary characters cannot
be required inside .jds-brief\_\_body. Evidence: workspace/evidence/visual-parity/p1/
r3-base-smoke-4/run.log; preserve its failure DOM/trace. Deferred to the existing
proof-case-selection task, not another P1 smoke/matcher iteration. P1 retains
Evening heading/body observations and all other populated/font/capture checks.

Before EACH dispatch, Architect traces the current implementation and names exact
helpers/files. PM confirms the task has one owned surface/state, a runnable probe
already available, explicit artifact paths/case count, ready exact-base artifacts
or a bounded baseline command, and no unresolved setup question. Records include
every room-required field and the full literal static command; this plan is
not a substitute for those records. Base is the previous task's merge commit.

PM's later sizing amendment applies to EVERY subsequent task record: one
dispatch must fit one context window and produce one concrete deliverable.
The former combined 60-minute implementation plus 30-minute verification budget
is retired; it allowed an oversized assignment. Use measured setup/run/static
timings and expected reading/editing load to admit each work package separately.
No planned compaction, reset relay or evidence-through-push dispatch.

Each future record explicitly separates remaining specific implementation plus
targeted checks then stop BEFORE static/browser acceptance; cleanup/full static/
amend/push then stop; and parallel independent Reviewer/Prover verification of
the pushed head. Prover owns the populated browser acceptance run; do not also
assign the same complete acceptance run to Builder. Keep the task's
one commit and timeline key; these are internal handoffs, not extra tasks.
Each dispatch names entry readiness, exact bounded files/command or probe,
deliverable and stop condition. A missing runnable probe is separate preparation,
not permission to expand an evidence run into harness development. A failed run
ends that handoff after teardown; PM scopes any correction before redispatch.
No automatic continuation to the next phase or repeat until green.

Before returning, save handoff ID, exact head/dirty files, command/exit,
probe/evidence paths, cleanup, unresolved findings and one next action in state.
PM reads that checkpoint before the next dispatch. If a package cannot fit,
split BEFORE starting; no promise that a reset/successor will finish it.
Reviewer and Prover each receive one independently executable boundary. Reuse
valid receipts as workflow.md permits, without duplicating entire acceptance
runs or weakening required gates. Waiting for CI opens no new build slot.

Two desktop/phone views can remain one task only while they exercise the same
state and implementation. Shared-frame edits must list every affected case and
all required guards up front. If that fan-out breaks the session budget, split
the frame task further before approval/dispatch, not after an oversized build.

## Proof and scope discipline

Each record declares: populated widgets; exact owned regions; expected base,
head, reference, diff, geometry and pair artifacts; counts derived from that case
list; deterministic seed and state; common checks plus targeted behavior.
The probe fails absent cases and never equates a recorded screenshot with an
executed comparison. Full captures remain available for independent inspection.

Reuse unchanged P0 fixture/capture helpers and the corrected P1 fail-closed
baseline discipline. New proof infrastructure has its own task. No duplicated
runner, no expanding shared helper beyond the file-size cap, no ad hoc mask added
to pass a product task. Frozen records and fresh-head proof remain mandatory.

Full static/CI/review remain per task. Required dark/canyon Today/dialog captures
and contrast remain common checks; T20/T21 follow the approved applicability and
documented exact-base equivalence decision. Do not silently remove these legs
under the phrase 'one proof boundary.' Any proposed gate change needs separate
approval and a recorded contract change. Receipt reuse is only what workflow.md
actually permits on the declared head/revision, never borrowed GREEN prose.

Previously accepted regions are guarded against the immediate base and retained
accepted reference; unowned unfinished regions are base guards, not mockup passes.
If a later region exposes a defect in an accepted one, classify and handle it via
the bounded correction rules; never make the final image owner a hidden cleanup
task. Unrelated findings remain ledger follow-ups. Existing V7/V8 findings are
mapped to these task records before dispatch; closure is evidenced or explicitly
deferred, never dropped during resizing.

## Approval and completion

Ben approved this ordered decomposition and the explicit regional intermediate-
acceptance amendment; no repeat approval is needed for this finalized list.
PM updates #2521 from the exact rows above before any post-P1 dispatch. Carry the
approved amendment into the repository's source plan/spec and merge it before
dependent product work; until then this file is the approved handoff, not a claim
that primary already contains VP-PLAN-R2. Required task records still precede
dispatch. Completed P0/P0.5/P1 retain their existing keys, scope and verified
merge history; P1 is merged, not active or continuing.

Before feature closure, Architect reads the merged revised plan by section and
the acceptance ledger: all 32 full images accepted on primary with no later
regression; pre-P1 shared-page guards preserved except approved changes; every
approved task merged and timeline row checked. If final reconciliation finds a
gap, the feature stays open and PM records a bounded correction before dispatch.
No implicit 'final polish' task or slice-only completion claim.
