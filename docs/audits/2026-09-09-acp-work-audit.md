# ACP Work: transcript, token, and delivery audit

Audit window: **Sunday, September 6, 2026, 8:55 a.m. PDT through Wednesday, September 9, 10:05:15 p.m. PDT** — 85 hours 10 minutes. The cutoff is a fixed snapshot; later work is excluded.

**Revised September 9, 2026:** incorporates the Opus automation conversations, deployment logs, and newly recovered Gemini native usage. The original files are preserved privately. Whole-run measurements describe several successive configurations, not the final automation setup alone.

**The largest confirmed delivery problem was losing completed work at handoffs. The largest accounting problem was undercounting multi-call agent turns.** Repeated tests contributed, but the evidence does not support blaming every repeated gate or removing independent review. Review repeatedly found real security, lifecycle, persistence, and live-UI defects.

**Revised token-utilization grade: C, for the historical workflow.** The first D assessment over-weighted routing overhead that was subsequently reduced and misinterpreted Gemini adapter failure flags as independent failed reads. The revised evidence shows useful controls being deployed and working, with remaining coordination, verification, and adapter gaps. This is an observational process assessment, not a model benchmark or a grade of the final automation setup.

## 1. What was located and how it was measured

The application is **Viberoom**, a separate server process. Its current room name is `ACP Work`; its persistent ID is `moss-work`. Original records:

- Room messages: `~/.viberoom/rooms/moss-work/history.jsonl`.
- Raw agent protocol transcripts: `~/.viberoom/rooms/moss-work/transcripts/`.
- Native Claude records: `~/.claude/projects/`, matched by exact room session ID and traceable child directories.
- Native Codex records: `~/.codex/sessions/`, matched by exact room session ID and child-to-parent metadata.
- Native OpenCode records: `~/.local/share/opencode/opencode.db`, queried read-only by exact session IDs.
- Local gate receipts: `/tmp/jarv1s-gate/build_acp_slice1_chat-*.log`.
- GitHub: [product PR #2427](https://github.com/motioneso/moss/pull/2427), its branch's workflow runs, and their job/step records.

The [transcript inventory](2026-09-09-acp-work-evidence/transcripts.csv) lists **all 94 files**, including startup-only and failed-start files, with role, protocol implementation, session ID, size, time bounds, and SHA-256. This includes the early Muse, Fitz, Fable/Foble, and Builder seats as well as the later PM, Architect, Scout, reviewers, builders, and Prover. Names changed over time: they are not reliable provider identifiers. Muse initially used **OpenCode with GLM-5.2**; later OpenCode Builder work used a different model. Gemini's functioning adapter identifies itself as Antigravity.

| Observation | Count | Meaning |
|---|---:|---|
| ACP transcript files | 94 / 183.88 MB | On-disk protocol records; bytes are not tokens |
| Agent prompt turns | 1,048 | Includes silent and unsuccessful turns |
| Distinct recorded tool calls | 8,066 | Deduplicated by file and tool-call ID; some occur outside room-prompt windows |
| Visible agent chat records | 809 | Omits silent turns and much internal work |
| Human-labeled chat records | 221 | **61 carry auto-reset/watchdog prefixes; at least one additional recovery was posted by the external Opus session**, not manually by Ben |
| System / hidden records | 476 / 9 | Included in room inventory |
| Native metered coverage | All prompted Claude, Codex, OpenCode, Gemini sessions | 39 Claude, 20 Codex, 2 OpenCode, 3 Gemini; Gemini recovered in this revision |
| Identified child sessions | 14 | 8 Claude, 6 Codex; no OpenCode descendants found |

Sources: [descriptive counts](2026-09-09-acp-work-evidence/summary.json), [native accounting](2026-09-09-acp-work-evidence/native-token-validation.md), and [session token inventory](2026-09-09-acp-work-evidence/native-tokens-by-session.csv).

**Timestamp discipline matters.** A room message's timestamp can represent the beginning of a long turn, while its final text describes something completed later. Delivery delays below use actual protocol completion or gate receipt times. Overlapping agent time, CI runner time, and wall-clock delay are kept separate. The entire 85-hour window is not treated as active work or charged as waste.

## 2. Token utilization and grade

### Corrected token accounting

| Agent runtime | ACP response counters | Native direct room-associated sessions | Identifiable children | Measured total |
|---|---:|---:|---:|---:|
| Claude | 379,746,102 | 410,715,157 | 51,631,833 | **462,346,990** |
| Codex | 17,252,088 | 470,022,005 | 7,728,370 | **477,750,375** |
| OpenCode, including Muse and Builder | 23,577,112 | 258,038,105 | 0 found | **258,038,105** |
| Gemini / Antigravity | Unavailable in ACP | 132,686,735 | None found in native trajectories | **132,686,735** |
| **Known total** | **420,575,302** | **1,271,462,002** | **59,360,203** | **1,330,822,205** |

The original 1,198,135,470-token total covered Claude, Codex, and OpenCode. This revision explicitly adds **132,686,735 Gemini tokens**, recovered by exact session ID from 1,336 native usage events across its 14 room prompts. Unrecorded usage still cannot be recovered. Direct native sessions also include asynchronous task completions and some cross-session messages: this is not exclusively consumption initiated by visible room prompts. The external Opus automation-engineering sessions are supporting evidence, not additions to this room-agent denominator.

**1,271,450,806 tokens — 95.5% of the known total — were cached-input reads.** These represent repeated processing of context, not 1.3 billion newly generated tokens. Cache reuse is a positive finding. No dollar total is defensible without the actual billing arrangements, models, and rates. Subscription usage, cached tokens, and output tokens cannot be priced identically.

Why the counters differed:

- **Codex's ACP response exposes the last model call, not the full multi-call turn.** One Luna turn made 413 native calls totaling **66,837,197 tokens**, but its ACP response reported **238,728**. Its source prompt/response are `Luna-Builder-2026-09-08T21-52-11-671Z.jsonl:6907` and `:11267`.
- **OpenCode has the same last-call effect.** All 119 recorded ACP prompt responses matched the final native assistant message. One Builder turn consumed **43,891,417** across 96 calls; ACP reported **480,378**. Sources: `Builder-2026-09-07T20-36-55-650Z.jsonl:3620` and `:4139`.
- **Claude requires message-ID deduplication.** Its direct logs contain 5,944 assistant records but 3,529 distinct message IDs. Summing every content-block record would overcount. Native logs also capture work absent from completed ACP responses.

For the original three metered providers, response-only totals understated direct native consumption by **63.1%**. Gemini adds a separate omission. Its driver records cumulative `totalTokenCount` excluding cached input; adding its cache counter once yields the comparable total. The new usage shim is a different measurement: a derived context-size gauge, not a cumulative consumption total. Comparing providers using the room counters would therefore produce a misleading ranking. See the [original native validation](2026-09-09-acp-work-evidence/native-token-validation.md) and [Gemini accounting correction](2026-09-09-acp-work-evidence/gemini-accounting.md) for exact formulas and evidence.

### Observable efficiency

| Indicator | Measured result | Interpretation |
|---|---:|---|
| Turns returning exactly `[silent]` | 228 / 1,048 = **21.8%** | Whole-run count spans both old and corrected routing |
| Silent turns with no ACP tool calls | 222 / 1,048 = **21.2%** | **25,214,992 native tokens**, now including all three Gemini silent turns |
| Tokens attached to pure-silent turns | **1.89%** of the revised known combined total | Material, but not evidence that most tokens were wasted |
| Gemini reads marked failed by ACP | 451 / 461 = **97.8%** | **Corrected interpretation:** all 451 IDs had prior successful native read results before later adapter flushes |
| Native adapter flush events | **10 events**, 452 read occurrences / 451 unique IDs | Real triggering errors and timeouts must be separated from misleading read statuses |
| CI observation commands | **458 tool calls** | Includes useful diagnosis and waiting; not 458 redundant polls |
| Standalone `sleep N` commands | **193 calls**, 7,387 requested seconds | 2h03m of requested agent waiting; not additive critical-path delay |
| PM-family visible messages | **311 / 809 = 38.4%** | Coordination volume, not a waste percentage |

**Correction:** the original “25-call failed-read streak” is a sequence of ACP records, not proof of 25 independent serial retries or 21 minutes of failed reading. Native logs show successful nonempty read results with empty errors before the adapter later flushes them as failed. All 451 affected IDs are covered by this reconciliation. The ten actual flush triggers include guessed/missing search paths, internal grep errors, an invalid model tool call, and two 600-second command timeouts. Opus diagnosed the first two batches and supplied path/batching guidance at 17:55 PDT; later flushes show remaining problems. The actionable issue is adapter lifecycle/error reporting and actual failing batch steps, not a demonstrated 97.8% underlying read-error rate. There are also 17 graph “project not found or not indexed” errors and 10 gate-pipe block responses. Pending-check exit statuses likewise must not be treated as defects.

**Grading rubric and revision:** A/B means verified useful work with negligible or isolated avoidable overhead; C means useful outcomes with recurring inefficiency and partially effective controls; D means major unresolved workflow failures; F means no verifiable useful outcome. **C** fits the revised record: substantial implementation and defect-catching review, 21 normal guarded resets, one proven live watchdog wake, and reduced silent dispatches coexist with stale handoffs, nondeterministic gates, and adapter errors. The earlier D relied in part on an invalid interpretation of the read-failure flags and treated the run too much like one unchanged configuration. This is an analyst judgment, not a statistical model benchmark. The final setup has too little comparable post-deployment exposure for its own reliable grade.

## 3. Where time was lost

### Completed work did not reliably reach the next owner

| Event, PDT | Evidence | Completion-to-recovery interval |
|---|---|---:|
| Sep 8, overnight builder completion | Sonnet finishes at 00:27:45.275, saying checks pass and “I can't page PM directly.” Ben wakes PM at 05:52:43.131; PM then assigns review. | **5h24m58s** |
| Sep 9, green local gate | Gate receipt ends 14:54:15; the external Opus session posts a recovery to the room’s human channel at 15:30:57.951. | **36m43s** |
| **Non-overlapping identified subtotal** | Completed-work handoffs only | **6h01m41s** |

Sources: history sequences **750–752**; Sonnet protocol file `Sonnet-Builder-2026-09-07T22-38-53-174Z.jsonl:2105–2757`; history **1278**; gate receipt `build_acp_slice1_chat-20260909-141757.log:358–359`.

This is a documented opportunity to reduce completion-to-next-step latency, not a guarantee that the eventual feature would ship exactly six hours earlier. Subsequent dependencies could absorb part of that gain. The two intervals equal 7.1% of the calendar window, but are not a complete idle-time measurement. **Neither demonstrates a failure of the enabled stall watchdog:** the overnight interval predates it, and the September 9 gate interval occurred during its deliberate log-only trial. The sidecar Opus session enabled live mode at 15:30:33 and posted the recovery 24 seconds later; that recovery was not an autonomous watchdog action. Sources: Opus session `c75f2856…:1672–1676` and watchdog log `:44`.

Additional qualified findings:

- Green CI completion to a wake-up: about **12m20s** on Sep 8; red CI completion to reporting/dispatch: about **34m35s**. The latter may include local investigation. Sources: history **829–831**, **839–844**.
- Ten hop-limit notices collapse into **six human-reset episodes**, totaling **10m56s** from first notice to the next human message. This is blocked-recipient exposure, not global room idle. Sources: history **544–554**, **582–583**, **623–624**, **661–662**, **695–698**, **733–734**.
- The gate runner already supports background `wait --follow`, and a room stall watchdog was subsequently enabled. The residual gap is reliable per-run terminal delivery and acknowledgement by the assigned room owner. The watchdog is a useful room-silence fallback, not evidence that each gate completion reaches its owner.

### Rework caused by coordination and incomplete acceptance checks

- **Stale instructions rebuilt already accepted work.** PM accepted a cleanup fix at `7aaf21246` in history **922–924**. Luna later acted on an old outstanding-finding message; PM acknowledged the unnecessary rework in **956–959**.
- **One completed report was requested again.** PM requested a full SHA and skipped checks (**1449**); Gemini supplied them (**1451**); PM immediately requested the same allegedly missing fields (**1453**), producing another answer (**1454**).
- **Both branches edited the plan.** Missing CI runs led to a new branch/duplicate PR #2434 and billing speculation before a merge conflict was diagnosed. Architect identified plan edits on both main and the build branch; the duplicate PR was closed. Sources: **565–595**, **613**. There is insufficient evidence to assign the entire diagnostic interval as wasted wall time.
- **Task 8a was rejected three times.** Reviews reported six findings, then six findings, then two remaining blockers (**1433–1440**, **1457–1459**, **1506–1513**). These are report findings, not necessarily fourteen distinct root causes. Tests missed serialized snapshots, persistence, downstream notification consumers, redaction, and forced ordering inversion. Fixes introduced regressions. This points to acceptance-test boundaries rather than simply a slow model.

## 4. Gates and tests: what actually repeated

### Local gate receipts

| Detached gate | Launches with receipts | Pass / fail | Total runtime |
|---|---:|---:|---:|
| Full `verify:foundation` | **10** | **6 / 4** | **4h21m28s** |
| Standalone `verify:static` | 2 | 1 / 1 | 4m01s |
| Standalone `test:unit` | 2 | 2 / 0 | 7m37s |

A successful full gate's median runtime was **36m33s**. Integration tests account for approximately 29–30 minutes of each successful run. The foundation script already includes static checks and unit tests before migrations and integration checks.

The command ledger additionally finds **28 explicit static-check attempts, 25 unit-suite attempts, 75 typecheck attempts, and 188 `vitest run` attempts**. These are deliberately conservative command-pattern counts, not an exhaustive count of successful test processes. They include compound commands and some blocked/failed attempts; they exclude command text embedded in document-writing scripts. They overlap gate receipts and must **not** be added as separate full runs.

Concrete avoidable or reducible repetitions:

1. **Three full-gate launches failed before expensive tests**, at 00:47, 00:48, and 00:50 on Sep 9: unused import, formatting, then a 1,006-line file-size breach. Their runtimes total **3m08s**, not three times 36 minutes. A static preflight after the final edit would catch these before gate setup.
2. **A timestamp-sensitive integration assertion failed after 37m35s**, comparing two identical `updated_at` values. The agent restarted the full gate to see whether it reproduced; that run passed after **36m15s**. The logs establish this rerun and its cause, not that rerunning was unjustified under current rules. Fixing the time-sensitive assertion would remove this failure mode; until then, repeat full gates are a tax on nondeterminism. Sources: `build_acp_slice1_chat-20260909-100250.log:351–378`, the following `104113` receipt, and Sonnet protocol file `Sonnet-Builder-2026-09-09T04-54-32-897Z.jsonl:5482–5554`.
3. **Gate receipts omit the tested commit and dirty-tree fingerprint.** That prevents a defensible global count of redundant same-input local gates. Identical command text is insufficient: code may have changed. Record these identifiers before trying to cache or reuse a prior result.

### CI on the product branch

There were **53 CI workflows on 53 distinct heads**, with **41 passing and 12 failing**. A further 45 module-registry workflows ran. These are branch results from the requested window; this is not a repository-wide CI audit.

| CI job | Attempts | Failures | Observed runner-minutes |
|---|---:|---:|---:|
| Static checks and unit tests | 53 | 11 | 412.2 |
| Integration shard 1 | 53 | 1 | 696.8 |
| Integration shard 2 | 53 | 1, plus 1 cancelled | 656.4 |
| Web/browser tests | 53 | 1 | 270.0 |
| Dev compose smoke | 53 | 1 | 319.4 |
| Production compose smoke | 53 | 3 | 165.4 |

Including scope detection and the final gate, this totals **2,527.75 runner-minutes / 42.13 runner-hours**. Jobs overlap, so this is compute exposure, not 42 hours added to delivery. Image publication and docs verification jobs were skipped on these product-branch runs; skipped jobs are excluded from runtime.

**There is no evidence here of 53 duplicate full workflows on one unchanged SHA.** Each run had a different head. Local and CI verification also cover different environments; current local green does not replace required CI or live proof.

However, **five heads failed the static-check step**. All jobs on those five runs consumed **209.27 runner-minutes**, including **199.43 minutes in other test/smoke jobs**. Preventing those pushes with reliable final-edit static validation could have avoided that compute. This is a conditional opportunity, not a measured 209-minute reduction in wall time. Another five heads failed unit tests; their workflows consumed 242.77 runner-minutes, but the evidence does not establish that every failure would reproduce locally.

The cheapest useful policy is: targeted checks while editing; one static/unit preflight before the proposed handoff; the required full gate and CI on a settled head. Reuse evidence only when tested inputs and environment match. Preserve the independent tests that caught real defects. Do not serialize every CI job behind a slow preliminary job without measuring the impact on successful-run latency.

Sources: [gate receipts](2026-09-09-acp-work-evidence/gate-receipts.json), [command counts](2026-09-09-acp-work-evidence/command-counts.csv), and [CI job/step ledger](2026-09-09-acp-work-evidence/ci-job-ledger.json), which includes run IDs, heads, timestamps, failed steps, and GitHub URLs.

## 5. Revised suggestions, accounting for deployed automations

### The conversations and implementation sequence

The two principal Opus conversations are `~/.claude/projects/-home-ben/de8a90e9-128b-4d37-b311-39d2ec6d36a5.jsonl` (Sep 9, 00:05–01:47 PDT) and `c75f2856-2a1f-45d4-8ba0-dfdbbbdf537a.jsonl` (08:43–19:03 PDT). The second explicitly resumes the first checkpoint. An earlier Sonnet session, `396016af…`, delegated the original automation feasibility research to an **Opus child on Sep 8 at 16:17 PDT**, then implemented the first guard. These identifications come from native model/session records, not names inferred from prose. The [conversation inventory](2026-09-09-acp-work-evidence/automation-conversation-manifest.json) preserves the paths and hashes.

| Effective time, PDT | Change and observed result | How it changes the recommendation |
|---|---|---|
| Sep 8, 20:25 | Memory guard starts; Astra reset completes at 20:26:58, Sonnet at 21:54:49 | Guarded note/save/reset already exists; measure its correctness and recovery, not its mere presence |
| Sep 9, 00:16–00:22 | Concurrent per-agent rounds, fresh-note checks, cooldown correction, then flat 130k trigger and a 200k Claude auto-compaction window | Early percentage/window mismatch was diagnosed and changed; do not recommend the obsolete initial settings |
| Sep 9, 09:25 | Stall watchdog starts **log-only**, deliberately observing before sending | Earlier silence and the later dry-run escalation are not evidence that a live notifier failed |
| Sep 9, 11:33–12:00 | Claude tool deny list trimmed; untagged-human routing patch written, then loaded by the **11:52:55 restart**; you confirm no wake at **12:00:25** | Untagged wake suppression is implemented. Tool-overhead savings require actual process/session exposure; the claimed 7k-per-agent saving is not independently established here |
| Sep 9, 12:27 and 13:52 | Guard waits while the agent works, with a five-minute idle-without-notes deadline and three-hour ceiling; save-and-stop wording later strengthened | Both are already implemented, despite a stale note listing wording as “not started” |
| Sep 9, 13:55–14:09 | Stuck-detector test resets Sonnet **and erroneously PM**; fixes at 14:08/14:09 stop banking idle time and limit detection to `thinking` | The reset regression was real and corrected in the guard. Preserve lifecycle protections; test resets against one explicit participant |
| By Sep 9, 14:17 | Backlog reduced 50→15; full brief 8→10 turns and 20k→40k tokens | These context reductions are already configured. The human command/output proves backlog at 14:17; the exact earlier brief-setting change time is not established |
| Sep 9, **15:30:33** | Watchdog becomes **LIVE**, with automatic stop disabled; existing fallback is last speaker → current `PM` → Ben | Retain and complete this service; per-run delivery, reset awareness, and bounded fallback remain the work |
| Sep 9, 17:44 | Reset thresholds become window-aware: 50% free / 65% busy, capped at 300k / 400k | “Add large-window support” is already addressed on disk **and loaded**; Prover’s larger-window setting was also changed |
| Sep 9, 18:06–18:07 | Muse bridge tested and recipe staged | Built capability, awaiting the room restart needed to load its recipe |
| Sep 9, 18:57 and 19:01–19:03 | `agent-check` and provider aliases available at 18:57; Gemini context-usage shim later tested and recipe staged | The diagnostic command works immediately. The room’s Gemini recipe still needs restart/load proof; native consumption recovery does not depend on that restart |
| Sep 9, **19:16:37** | One real watchdog nudge; PM is **prompted 3.697 seconds later**, first reply chunk at 12.128 seconds, completed reply at **16.270 seconds** | Proven successful wake. It does not prove task completion or live second-/third-stage escalation |

Detailed timestamps, log lines, backup comparisons, and loaded-versus-written distinctions are in the [deployment appendix](2026-09-09-acp-work-evidence/automation-deployments.md). Through the fixed cutoff the guard records **21 normal reset completions**, **two stuck-reset completions, one erroneous**, and **11 skipped rounds**. Restarts and incomplete rounds make a simple success-rate denominator misleading. These operations do not directly establish tokens saved.

### What changed in the measured workload

Using your behavioral confirmation at **12:00:25 PDT on Sep 9** as a conservative comparison boundary:

| Prompt-start period | Room turns | Pure-silent turns | Rate |
|---|---:|---:|---:|
| Before confirmation | 874 | 208 | **23.8%** |
| After confirmation, through cutoff | 174 | 14 | **8.0%** |

That is a **15.8 percentage-point decrease**, or about **66% lower observed rate**. It is not a causal savings estimate: roles, task mix, exposure duration, resets, and other settings also changed. The old 222-turn whole-run count is not the rate of the final configuration. The patch prevents immediate untagged dispatch; text can still consume context later through backlog. Source: [phase metrics](2026-09-09-acp-work-evidence/automation-phase-metrics.json).

### Remaining work, in priority order

| Priority | Current status and next step | Evidence / success criterion |
|---|---|---|
| 1 | **Complete existing completion delivery.** Keep the live watchdog; route terminal local-gate/CI results to the task owner with one acknowledgement. | Historical lost handoffs total 6h01m41s; live watchdog has one 3.7-second prompt dispatch / 16.3-second completed reply. Measure terminal-result→owner acknowledgement separately from room silence. |
| 2 | **Correct batch/tool lifecycle reporting.** Preserve Opus’s path/batching advice, validate search paths, and handle the actual failed batch step without relabeling already successful reads as independent failures. | Native results reconcile all 451 affected read IDs across ten flush events. Regression test: a successful read followed by a failed sibling search retains a correct terminal status. Diagnose real 600-second timeouts separately. |
| 3 | **Activate and verify staged provider work at an agreed idle boundary.** Prove the room loads the Gemini shim and Muse recipe, then verify the upgrade watcher reapplies and reloads them. | Disk recipes postdate the 11:52 running hub; the API still lacked Gemini counters at review. The repatch service ran, but an actual upgrade-trigger→patch→loaded-process chain is unproven. |
| 4 | **Separate context gauges from consumption accounting.** Use the already recovered native totals for the audit; retain request/session identity, children and cancellation in ongoing accounting. | Gemini is now measured at 132.69M native tokens. Its staged gauge reports a derived prompt-size estimate, not those cumulative tokens; Codex/OpenCode last-call ACP undercount remains. |
| 5 | **Finish reset and stale-handoff correctness.** Existing fresh-save and save-and-stop rules are present; revalidate notes before a delayed reset, preserve current task/head/finding status, and scope reset tests. | Normal path can delay reset after the initial freshness check; stuck path accepts any nonempty note. PM lost its assignment during the low-threshold test. Stale instructions previously rebuilt accepted work. |
| 6 | **Repair the watchdog’s remaining classifier gaps before giving it stop authority.** Keep automatic stop disabled while validating lifecycle and reset-awareness. | Its guard-log parser expects a one-word room name and misses `ACP Work`; it still banks idle time, unlike the corrected guard. Current code also counts system notices as activity and lacks the proposed AWAITING-BEN suppression. |
| 7 | **Keep task sizing and executable boundary checks upstream of resets.** You already instructed session-sized work; verify that acceptance criteria exercise the real boundary before building. | A queued save request cannot prevent compaction inside a long active turn. Three task-8a rejection rounds and the shutdown/cancellation escapes remain relevant despite automation improvements. |
| 8 | **Preflight and reuse verification evidence on matching inputs.** Keep the watchdog’s gate/CI holdoff; add tested-head/dirty-tree/environment receipts and fix nondeterministic tests. | 36m33s median full gate; one 36m15s timestamp-related rerun; five static-failing CI heads. Holdoff avoids false alerts but does not deduplicate tests or prove a terminal handoff. |
| 9 | **Measure residual dispatch overhead after the fixes.** Keep the untagged rule, backlog 15, and reduced brief frequency; inspect unnecessary explicit tags and reset nudges. | Current comparison is 14/174 pure-silent turns, not 222/1,048. Preserve useful reviewer wake-ups; target the remaining no-op dispatches without claiming all historical silent tokens are still recoverable. |

No new daemon is needed to cover behavior these sidecars already implement. Node polling does not itself invoke a model; its wake/reset messages do, and those room-agent responses are already counted. The external Opus implementation sessions remain outside the room token totals. The live review here changed no service, script, room setting, or agent state.

The savings remain **non-additive and conditional**. The 25.21M pure-silent tokens describe the entire historical workload, mostly preceding the routing correction, not a future savings promise. A successful reset is not proof of net token savings, and one successful watchdog wake is not enough to grade its long-term reliability.

Keep the checks that earned their cost:

- Integrated review found six significant cross-component defects after task-local passes, including wrong-provider credentials, identity allocation, readiness enforcement, misleading handshake proof, cumulative buffers, and incomplete close behavior (**600–605**).
- A shutdown test passed because its fake released polling immediately. A later negative check removed the real wait and confirmed the corrected test failed (**660**, **694**, **722**, **730–731**).
- Task 6 review found that stopping a session left an approval usable; the earlier test only cancelled the approval directly (**999–1001**).
- Live proof caught a missing session-open log and dropped queued messages (**1308**). Follow-up checks explicitly exercised mid-flight queueing before claiming success (**1403**, **1407**, **1414**).

The faster workflow tests these boundaries earlier and reviews subsequent changes against the findings. Removing review would hide the defects rather than reduce the work needed to deliver correctly.

## 6. Delivery state and corrections to the room's own retrospective

The room produced an ACP investigation, an approved design and evolving plan, reusable protocol work, and substantial implementation. Tasks 1–7 were reported complete by cutoff, with task 7 eventually backed by live evidence. **Product PR #2427 remained open; ACP was not shipped.** Task 8a remained rejected, and further tasks were outstanding. Sources: history **1495**, **1506**, **1516**, and the GitHub PR snapshot.

Several retrospective claims need correction:

- “Six plan revisions each ran the full suite” conflicts with contemporaneous reports that docs-only PRs skipped code/browser/integration jobs (**426**, **965**, **1026**, **1088**). A CI workflow existing does not mean every suite executed.
- “Nobody noticed the pass for an hour and a half” includes time while the gate was still running. The evidenced completion delay was **36m43s**.
- “Few replies cost nothing” is false: context, internal tool calls, and silent turns consume tokens. Suppressing an immediate wake can still leave the text in a later backlog.
- The first audit’s “451 failed Gemini file reads” and “25-call retry streak” were interpretations of ACP status flags. Native post-tool results invalidate the independent-read-failure interpretation.
- The note calling the save-and-stop wording “not started” is stale; it was loaded at 13:52. Conversely, a Gemini shim/recipe on disk does not prove the running hub loaded it.
- The original five-phase outside-agent implementation is relevant context for the revert, but its entire cost cannot be assigned to these room sessions without provenance.
- Provider/seat comparisons are observational, not controlled experiments. Work complexity, model changes, context size, adapter reliability, and incomplete contracts differ. The room's displayed counters would make the comparison even less reliable.

## 7. Evidence, reproducibility, and remaining gaps

The [evidence directory](2026-09-09-acp-work-evidence/README.md) contains inventories, source-line command counts, gate receipts, CI job records, native token methodology, and analysis scripts. `H:N` in the workflow appendix means sequence N in the original room history; its source line matches that sequence in this snapshot. ACP filename/line references resolve under the original transcript directory given above.

Raw room transcripts and native source copies are retained privately at `~/.local/share/acp-work-audits/2026-09-09/`. Raw inputs contain session configuration and private conversation contents; the repository report publishes aggregate measurements and references instead of copying those payloads.

Remaining gaps: actual billing, any unrecorded requests, exact local gate commit/dirty-tree identity, a reliable global critical-path trace, and live proof of the staged recipe/shim and upgrade-trigger chain. Gemini native consumption is now recovered; its live room gauge remains a separate deployment question. Native source copies were captured after the room snapshot and filtered to its cutoff. GitHub was queried afterward for historical runs. The automation revision preserves the original observation window and original report privately. No product code or live automation was changed, and no product gates/tests were launched for this audit.
