# Moss Computer spec/plan: independent review

- **Candidate:** the exact spec, plan and qualification evidence in this documentation branch.
- **Reviewer:** `/root/independent_review`, independent of author Codex `/root`.
- **Current status:** startup-readiness-r8 stopped before image load at the required fresh RAM floor; startup readiness and replacement persistence remain unqualified. Earlier scoped recovery acceptances and historical failures remain recorded below.

The reviewer must check authority, product destination, source/installed identity separation, private viewing and egress gates, resource/storage limits, named finish controls, manual versus automated acceptance, actual-replacement requirements, shared ownership, stop boundaries, and evidence honesty. Record exact document hashes or commit, verdict and material findings here. Do not convert documentation acceptance into runtime acceptance.

## Round 1

Independent reviewer found one missing guardrail: the plan needed to prohibit disabling container security profiles or the browser sandbox to make the image work. It also requested that the proposed next assignment explicitly include enforced egress combined with viewing. Both findings are retained and corrected in the spec, plan and evidence report.

The reviewer otherwise found the product direction, automated/manual distinction, source/installed identity separation and `NOT_RUN` classifications sound. Overnight authorisation does not override failed launch gates.

Reviewed SHA-256 before correction:

| Document | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| Spec     | `0fb9836ed94f2ab65a8e6e74520f66ce62e23fc6c696861734f20d17f08184d5` |
| Plan     | `ade0784deca38fcea86fd6053a4b03591c46cfbc7f0097e39968b885a3a92c3d` |
| Evidence | `44654dfa09da8733d5ca004884dc1eeb5148b7bc0f20c513838d79f220fca337` |

## Correction review: accepted

Reviewer verdict: “PASS — corrected documents accepted. Both review findings are resolved. No remaining blocking document findings.” This accepts the spec, plan and readiness report, not runtime suitability. No proof should start while entry gates remain unknown.

Accepted SHA-256:

| Document | SHA-256                                                            |
| -------- | ------------------------------------------------------------------ |
| Spec     | `dcec5bc44df45652e78197a208cad358e1ada3ddb784ebb68f957fd450a85f3e` |
| Plan     | `1364a70f10732a7027b075aaf3f6c4bf9f6ffdb4208fda32e18e0459923c132d` |
| Evidence | `bf24e1bea1888c8c64c9a53a09e95c6b4b45004280aa5c11eed72beee72143dd` |

## Historical documentation-only closure at commit83ec63b2a

The three accepted documents were preserved unchanged at that checkpoint after correction review. Later implementation amendments are reviewed separately below. Scoped Prettier and relative-link/private-content checks passed. No database, product UAT or full foundation gate ran for this docs/preflight change.

At closure, `docker ps -a --filter name=moss-computer-qualification` returned no containers. Production `moss` was running and healthy. No image was pulled, proof runtime launched, port reserved or data volume created; there is no unattended job to finish. The task and parent remain open. The isolated documentation worktree is committed/pushed separately without modifying the original shared checkout or merging.

## Autonomous implementation: first candidate review

Ben subsequently authorised autonomous implementation. Reviewer independently accepted commit `1f110888f2a6801554cd325d2de8d6db22aca243` for one actively supervised offline qualification, using image `sha256:95edd6e239f22851b46c0748090d1ddebba50b2eae5223698b6c0a80a65b0c30`. This is launch-readiness approval, not runtime acceptance.

Material prelaunch findings corrected: fixed Compose name could collide; monitor omitted writable socket directory; Nginx temp paths could target the read-only root; receipt writes could prevent fail-closed stopping; fallback run ID and stop-failure reporting needed to be explicit. Exact corrected supervisor hash: `95abc5d8161c9c15d8b1666d1156549b688cf05b6ff3038ffe37c51b0284ffd9`.

Runtime exposed an installed dependency mismatch and missing published listener. Reviewer accepted the bounded correction direction (pinned Websockify 0.13 wheel, normal bridge only for trusted gateway) pending exact-file review. No browser or persistence acceptance followed the failed launch.

## Final independent review: partial evidence accepted, recovery gate FAIL

Reviewer `/root/independent_review2` did not author the candidate or evidence. It independently
reviewed raw receipts and the final exact files. Verdict: **PASS for report accuracy and static
candidate; recovery gate FAIL.** No blocking inaccurate claim remained. Full product acceptance
and merge readiness do not follow.

Accepted covered cases: substantive framebuffer and keyboard input, actual browser sandbox
inspection with unavailable user namespaces disclosed, real replacement/file/profile/bookmark
survival, observed failing security negative controls and fail-closed stopping. Crash transport
reconnect passed before recovered rendering timed out; recovered input was not reached. Cause is
unknown. The reviewer accepted one focused recovery qualification before owner integration.

The reviewer independently confirmed source hashes against the receipt, shell syntax/whitespace,
absence of proof containers/network/listener5180, removed ephemeral keys, retained home and healthy
Moss. Full foundation/Moss live-UI/platform gates did not run for this internal candidate.

| Exact reviewed artifact | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Evidence ledger         | `f42c34d9fdfcf29b8b7aeca9302ee7a4dc8935f7fea6d781224b84058540bdb5` |
| Runtime receipt         | `ebfb7e4fd6894b4bac59d173f2b888ca2b92293f14dde08cab67c2a881e88388` |
| Spec                    | `d9b671fcf45f9810896cb449c2cd0fb56ec274af0d4dafd5e3bffdb4b3b4896a` |
| Qualification plan      | `f7ef806710d44a39cc3e51ad434db0eefa9d32d5c38da96d57d96063ff4e21b8` |
| Proposed recovery plan  | `d61653771562c9d6e7584af61931e309ad94da5e16126d89bce9d7faf2c5c662` |

## Recovery dispatch: missing candidate, reviewed preflight

Ben dispatched the recovery packet with “proceed”. Before runtime, Docker reported the exact
previous image absent. Reviewer `/root/independent_review2` independently checked the final
report, receipt and packet and returned **PASS; no blocking findings** for report accuracy and
the bounded reconstruction proposal. Recovery remains **NOT_RUN / BLOCKED_MISSING_PINNED_CANDIDATE**.

The reviewer confirmed the image is absent, source hashes unchanged, retained marker present,
no proof containers/listener5180, released port reservation and healthy Moss. No runtime acceptance
transfers to a rebuild. The next proposal reconstructs and independently adopts/rejects one exact
candidate, stopping before recovery runtime; it has not started.

| Exact reviewed artifact          | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| Recovery preflight report        | `c7239714a7511cdbc6c04df2ee2fb8a73e7f7287b43bab5661e2d2b9950eaefd` |
| Recovery preflight JSON          | `824512498af32a6b1c7cb9c2501a22f6f76d8899a80afd6d33cb12f34b3e0098` |
| Dispatched/blocked recovery plan | `43c37819ca66608fe927ffe32a848bfdd970915ffeb80e25256be76e24ea4c64` |

## Reconstruction checkpoint: adopt for later recovery trial

Ben dispatched the proposed reconstruction checkpoint. Reviewer `/root/independent_review2`
independently accepted staged build readiness, conditional on the actual resource/cancellation
probe. That probe passed before the candidate build. Exact readiness hashes:

| Artifact              | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| Reconstruction plan   | `bc82b637a8c6d7e8e37177105b36a5ceabadfafb0bf40b46a5cc26a22e96f57e` |
| Run-scoped supervisor | `735d959829e24a2484eec3f9835706a0caf2a59831d320dac09a5d09c6d6b780` |
| Derived Dockerfile    | `a55c342c055e6eaaf6feba9ec5805d82ee20e113eda0ec457b3d20dcda231765` |
| Diagnostic Dockerfile | `2db0cee911f9b6b10bef0427eb9d313e33626617a5b514da5a104e57f1848575` |

Final independent verdict: **PASS — ADOPT_FOR_LATER_RECOVERY_TRIAL**, exact candidate
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
No blocking report inaccuracies. Reviewer independently checked package inventory equality,
actual image configuration and packaged source, probe limits/cancellation, archive checksum/config
identity/layer list, final image existence, no checkpoint containers and healthy Moss.

| Exact reviewed report   | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Reconstruction Markdown | `67986be966f9b3eb350598ec57d0578f5d6521957a94e481bdd3aa03626d79cb` |
| Reconstruction JSON     | `9c7f2b07284e03af63015e24861fe99e084f56894d74a14b7a7b2048f7ab9459` |

This accepts the reconstructed artifact for a later trial, granting no desktop, recovery,
persistence or security acceptance for it. Earlier recovery failure and original image loss remain
unexplained. The proposed next step independently reviews an amended recovery packet before
runtime; this checkpoint stops here. No merge readiness or guide progress follows.

## Recovery r3: rapid fixed-host restart evidence accepted

Reviewer `/root/recovery_review`, independent of author/operator Codex `/root`, issued
**PASS — exact reports and scoped rapid-restart recovery evidence accepted; no blocking findings.**
No reviewer edits. The reviewer first blocked the frame predicate because a hidden canvas could
pass; author added positive visible viewport geometry/styles and the reviewer accepted readiness.
Exact initial packet at `f5ed18a39`: SHA-256
`c4dcd53e53a76f92d1545d170f7dfe567b53c4857742be160ec7bbae17b95169`.

The first loop exposed the installed Playwright async-false predicate returning immediately.
Reviewer accepted the subsequent synchronous actual UI/RFB polling correction and amended packet,
then independently confirmed the stopped-guest control failed at its actual12s frame assertion
with empty canvases, and strict recovery passed real visible frame/fresh keyboard input. Earlier
provisional evidence is retained, not used as final readiness proof. No viewer/image/security
change was authored. Exact final runtime/supervisor/config hashes are in the
[receipt](2026-10-23-recovery-r3.json).

Final review independently checked all raw/source/runtime hashes, sanitised comparisons, retained
marker bytes, current-image access removal/restoration controls, sampled resources, privacy and
relative links, scoped formatting and whitespace. Closure inspection confirmed no proof containers,
network, listener5180, reservation, owned scripts/watchdog or ephemeral keys; home/archive retained
and Moss healthy. The watchdog's normal operator closure was exercised, no new fault injection.

| Exact reviewed artifact | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Recovery-r3 report      | `5aa5597b8594721527a9f8040dcd04e6e59f12c3e3b890124509ae901ae6f395` |
| Recovery-r3 JSON        | `01e61804fb9d9a307654f9542dcd71cbfb9cf14bbe726d30f06adb498d0deac0` |
| Final recovery packet   | `901e13041242d6cff0d3bfed238e2fe2d12895306efcb42ef4db99ef57f985cd` |
| Final spec              | `424f5847d8138d7d0ccf14b497d57f5c742d85c4dda687321996a79ae881ffb3` |

Acceptance is rapid restart only: kill→host-start-return142ms, WebSocket reopen about1.118s.
Delayed-restart recovery remains unqualified, historical canvas root cause UNKNOWN. No rebuilt-image
Firefox/profile/replacement, Moss integration, remote manual, platform or release acceptance.
One next proposal is an independently reviewed delayed-restart explicit reload proof; not dispatched.
Task3578/parent3577 remain open and PR3579 draft. No merge or automatic parent adoption.

## Recovery r4: delayed restart and one reload evidence accepted

Reviewer `/root/delayed_review`, independent of author/operator Codex `/root`, issued
**PASS_READY** for exact launch packet commit `aa8c01601ffe4f65f803fb3cc47207720e2d09d7`,
then **PASS — bounded delayed-restart/reload evidence accepted; no blocking findings.**
No reviewer authorship or edits. Fresh floors and watchdog alive/first healthy sample were checked
before launch; exact eight runtime/config hashes matched the committed packet and launch bytes.

Final independent review checked all42 raw receipt hashes, eight runtime hashes, seven source
hashes and raw/sanitised agreement. Actual failed automatic retry preceded the stopped-guest frame
assertion's12010ms timeout. One reload created a new document/RFB, substantive visible frame and
fresh unique retained viewer-keyboard marker. Detached prior pixels and the initial one-colour
transport frame did not qualify. Kill-return→start-return13392ms; reload→substantive frame1372ms.
Access removal/restoration controls, actual isolation/cgroups and sampled resources were verified.

Independent current closure checks found no r4 containers/network/listener5189/reservation,
watchdog PID or keys; owned runtime closed, homes/archive retained and Moss healthy. Browser closure
is supported by the harness awaiting `browser.close` and its finite exit0. Scoped formatting,
whitespace, privacy and relative links passed.

Full gateway ID and supervisor numeric exit were not retained; retrospective daemon event collection
was empty. The reviewer explicitly found these disclosed collection limits **non-blocking for this
narrow recovery acceptance**: full guest ID plus real UI/RFB/frame/input evidence establish recovery;
normal supervisor stop receipt and current no-runtime checks establish closure. No daemon-event
corroboration or broader host/service restart resilience is claimed.

| Exact accepted artifact | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Recovery-r4 report      | `29042adf34a0427d0ba3dc18f264032d057927d260e133737780166a6f7415a0` |
| Recovery-r4 JSON        | `6984a6f9ea95b3d8223ae0a72a42bd552656d425fb5490f2bcf54a5974840e75` |
| Final spec              | `95ff0fdc87fbade5dcb9c043da8f6e8cf7ab17542329d3af4dcacd1eea35b76b` |
| Launch packet           | `be5b3c5b58bae6a46c6a8f4e66d07f94326fb88b42643c565920139b081d96d3` |

Acceptance is one approximately13.4s guest outage with an explicit browser reload after terminal
retry failure, on the exact adopted image. Arbitrary outages, recovery without reload, historical
original-image canvas-timeout/image-loss/Herdr incident causes, rebuilt-image Firefox/profile/
replacement, owner integration and manual/platform/release gates remain separate. The one next
proposal is bounded active Firefox sandbox plus file/profile replacement qualification on the
adopted image, not dispatched. No merge, automatic parent adoption or issue close.

## Persistence r5: entry-rejection evidence accepted

Reviewer `/root/persistence_entry_review`, independent of author/operator Codex `/root`, returned
**PASS — bounded entry-rejection evidence accepted. No blocking findings.** The reviewer did not
author fixes or edit files, retry the resource gate, restore an image or launch runtime.

The exact [report](2026-10-23-persistence-preflight.md), [receipt](2026-10-23-persistence-preflight.json)
and spec were checked against the dispatched handoff, inherited initial tool outputs and private
receipts. Available RAM 8,330,731,520 bytes was below the 8,589,934,592-byte floor by 259,203,072
bytes. Entry rejection follows the Start section's mandatory stop. The required image was absent;
no load/build or launch preparation followed the failed RAM gate.

Both private receipt hashes and sanitised values matched. Independent exact-label closure checks
found no owned containers/networks and Moss remained `running healthy`. Earlier homes/archive
were present at the claimed size; no content rehash or archive validation was asserted. Relative
links, scoped privacy/formatting and whitespace checks passed; only the scoped checkpoint was
added to the spec.

| Exact accepted artifact      | SHA-256                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| Persistence-preflight report | `07c57d30aeb51da22f2bf35b768bdaf271b60924cf2a47480c185e701683ebdd` |
| Persistence-preflight JSON   | `35c59e35f30f1b89747ce3cb8d597e663410d6c8997078eaf87ebf0d973420b5` |
| Final spec                   | `7925e316adf85f6d6665daee4cc165b90e051fc3b1d049520fd6b049a157881d` |

Initial entry measurements are explicitly transcript copies; original raw command files and the
separate exact RAM-sample timestamp were not retained. These disclosed limits are non-blocking
for accepting the entry rejection. Archive checksum/config/layers, active Firefox sandbox and
replacement persistence remain NOT_RUN. This is no runtime qualification or product acceptance.
The one next proposal is the same bounded qualification after fresh entry floors pass, including
archive validation if needed and committed exact-artifact prelaunch review. No further run,
automatic merge or issue close is dispatched.

## Subsequent requirement amendment: idle sleep and wake

After the persistence entry rejection, Ben required Computer to sleep when unused to release
resources for other host work. Reviewer `/root/persistence_entry_review` independently returned
**PASS — bounded sleep/wake requirement amendment accepted. No blocking findings.** No reviewer
edits, runtime operations or resource-gate retries were performed.

Exact amended spec SHA-256:
`14378d6c2fb961aacd71071fbb213e048d3dabde0a37a96cf9fb667dd6b45dae`.
This later spec supersedes the spec snapshot accepted for persistence-r5; both preflight report
and JSON hashes remain unchanged. The operative requirement consistently replaces continuous
running with idle sleep/on-demand wake. Clean stop is a future design requiring flushed state,
active-work inhibition, no silent unsaved-work loss, owner checks and wake resource admission.
The timeout/inhibitor decisions, live proof and same-PR product app-map updates remain pending.
Scoped formatting and whitespace checks passed. This accepts a requirement amendment, with no
implemented sleep/wake capability or resumed qualification claim.

## Persistence r6: exact readiness and final rejection evidence

Reviewer `/root/persistence_entry_review` performed read-only investigation, exact prelaunch review
and exact final evidence review, with no authorship, fixes or runtime operations.

The initial packet `fa461517106dfa8cfc136f286da2db473ed86800` was rejected before launch: overly broad
content-process classification, zero-level environment exemption, missing pristine-copy green
controls/WAL handling, shutdown race, unchecked cleanup exits/host-browser timeout cleanup and
formatting. Revised `adedb01547f7ced71af325771170db20308c2af7` still had a shutdown-lock setup failure
that bypassed emergency stop. That distinct gap was rejected before launch. Revised exact packet
`08a3b2111d6d79ff2aa3972ab56f655e32ed10ef` received **PASS_READY — no blocking findings**, conditional
on the live watchdog/healthy sample gate. All15 final artifacts, syntax/formatting/resolved config,
actual retained archive checksum/config/seven layers and synthetic certificates were independently
checked. Clipboard setter redirection and emergency exact-label shutdown were included.

Accepted packet SHA-256 `02a28f03c5b7add2b09b5d2fb7a4740d334c536708fa5219a1ff8a08dafb79ab`;
private artifact-manifest SHA-256 `2ecc8a88f66efa71683869f78a44584ef11b939b0988955c97d5147aa690e26a`.
Readiness was not runtime acceptance.

One subsequent run failed before actual sandbox collection at an invalid cached Firefox window.
The reviewer independently accepted the exact final documents as **PASS — final rejection evidence
accepted, no blocking findings**. Acceptance is limited to **REJECTED_INCOMPLETE_PROOF and verified
closure**. Active Firefox sandbox and replacement persistence remain unqualified.

All33 private receipt hashes matched, as did raw/sanitised values, unchanged15 launch artifacts,
monitor/cgroup observations and closure facts. The exact bookmark existed on the disposable
postmortem profile copy, and real retained main/WAL/designated-file hashes matched; that diagnostic
was correctly excluded from clean UI flush/replacement acceptance. The47 repeated BadWindow
occurrences, stop-rule weakness, unknown window-loss cause, missing gates and pre-cleanup inspect
timing were preserved. Links, privacy, scoped Prettier and whitespace passed.

| Exact accepted final artifact                    | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| [Report](2026-10-23-persistence-r6.md)           | `126f65643a632ef1411fb1fddbb098643abb16196c8400d15d567b589c884b04` |
| [Sanitised JSON](2026-10-23-persistence-r6.json) | `fb743583f40396231fec70c98a8e1fe3a60cc9216e6ddcb20ecc61f96f44a158` |
| Final spec                                       | `83dd88b6189259cee3c0372da4afd86eef6ddbd1d4ec6d46c2e45fe9210d610f` |

Independent current closure checks found no exact-label containers, project network, listener or
reservation5188, owned script/watchdog, recorded browser identity or ephemeral keys. Prior homes
and archive remain present; Moss is healthy. No rehash of all prior contents was claimed.
No further runtime, automatic merge, parent adoption or issue close follows. The sole next proposal
is bounded current-window rediscovery/error handling and failure diagnostics, then separately
reviewed/dispatched qualification with fresh resource gates.

## Persistence r7: exact amended readiness

Reviewer `/root/independent_review` independently verified the retained archive size/SHA256, actual
config identity and all seven layers before PASS_RESTORE_READY for one bounded exact load. No
reviewer authored files or performed runtime mutations.

Initial candidate `071a27801` was NOT_READY: author and reviewer found that `terminal(command)`
shadowed the command helper. Actual terminal call-site regression observed TypeError before the
parameter correction and passed afterwards. No runtime launched from that candidate.

Amended committed packet `93cbe881ebe6645a8610c85246280d89aa6555ae` received **PASS_READY**, conditional
on the live alive/healthy watchdog/resource gate. Packet SHA256
`c14026788dde8fee980ce64ee85bbe17db72d5575d303b9833fdf931c9f3e05f`; private18-artifact manifest
SHA256 `911cd237a99a9d83f7add8b9226d069b8077ad8bd1a85cdeede75b00ab2675c7`.
Reviewer checked every actual hash/table, regressions/Node/Python syntax, scoped formatting/whitespace,
resolved configuration/security, synthetic certificates/foreign rejection, empty fresh home/socket,
port reservation, exact image and cleanup design. No blockers remained; readiness was not runtime
acceptance. Final r7 result review is recorded separately below after exact evidence review.

## Persistence r7: final rejection evidence accepted

Reviewer `/root/independent_review` returned **PASS — exact final r7 rejection evidence and verified
closure accepted; no blocking findings**. Acceptance is limited to REJECTED_INCOMPLETE_PROOF and
closure. Viewer/Firefox/window/sandbox/clean flush/persistence/replacement remain NOT_RUN.
No reviewer authored fixes or performed runtime mutations.

Before final acceptance, author privacy scan and independent review caught absolute host paths in
public JSON dictionary keys. The sanitizer was corrected to clean keys as well as values; private
closure receipts stayed unchanged. Corrected public bytes below passed renewed privacy checks.

| Exact accepted final artifact                    | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| [Report](2026-10-23-persistence-r7.md)           | `cdbf14ce9066002869982d90437c96dc1ef3adf5fd6ece479da23dbd1714be59` |
| [Sanitised JSON](2026-10-23-persistence-r7.json) | `01291249ab867c2fed850b542fca697170150204c77df02d52b2351f703d2e13` |
| Final spec                                       | `ed6cf6e27c3c054b7e35f17bc5e2b3031fa604db78887428d3f54861853c96c7` |

All32 raw receipt hashes, three supporting hashes and18 unchanged launch hashes matched. Raw and
sanitised values agree, including closure keys and sampled isolation addresses. Actual pre-cleanup
inspect settings/IDs/cgroups, protected502, no Firefox/harness/replacement, missing gateway upstream
log and single-prelaunch-sample limits were independently checked. Scoped formatting/privacy/links/
whitespace passed. The ledger before this final verdict append had SHA256
`41a10aa89c5b504670f6f04b5185901aa136bdb12ff68e8011cee8ed4fd9ac27`.

Independent current closure checks confirmed both full container IDs absent, zero owned labels/
network/listener/reservation/scripts/host-browser identity/keys, retained homes/archive and healthy
Moss. Next proposal is separately reviewed startup readiness with actual current UI/RFB and gateway/
backend diagnostics. No second run, integration, merge, automatic parent adoption or issue close.

## Startup readiness r8: pre-load rejection evidence accepted

Reviewer `/root/readiness_review`, independent of author/operator Codex `/root`, returned
**PASS — exact r8 rejection evidence and preparation closure accepted; no blocking findings.**
No reviewer edits, resource-gate retries or runtime mutations occurred.

The reviewer first independently verified the actual retained archive size/checksum, config identity
and all seven actual layer payload hashes, returning PASS_RESTORE_READY conditional on fresh
resource floors before one load and subsequent exact identity/layer inspection. Archive-verification
receipt SHA256 `fc21d375c92822a19cad0f3486b5e3cba3439adae01bd9583a531ec84ac9f48f`.
The fresh pre-load RAM gate failed before `docker load`:8,490,229,760 bytes, below8GiB by99,704,832.
No image load, runtime, startup correction or launch packet was completed.

| Exact accepted artifact                         | SHA-256                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| [r8 report](2026-10-23-startup-readiness-r8.md) | `35d1484b82816280bfc55b2429b3d6175ea3c6234f3d7d11a1e52bd73feae21d` |
| [r8 JSON](2026-10-23-startup-readiness-r8.json) | `5b27658e19354551a781a3e84638c4ff507f90ffa51a661f32b8eeaf27636f73` |
| Spec with section18                             | `b88f8b0fd39e0ff92e45666b6a62d6f42e88a78f49abc4e65ce4e23cc62d8eb7` |

All eight raw receipt hashes and the closure checker hash matched. Raw/sanitised samples, archive,
conditional review, closure and arithmetic agreed. The unrun load/runner/watchdog exits are null;
pre-load wrapper1, operator closure0 and port release0 are recorded. Scoped formatting, privacy,
relative links and whitespace passed.

Independent current closure found zero exact-label containers/network/listener5184/reservation or
owned private-root processes; fresh home/socket/identity directories were empty and no host-browser
identities existed. Earlier homes including r7 and the archive remained; Moss was `running healthy`.
This accepts **BLOCKED_BEFORE_LAUNCH** accuracy and preparation closure only. Startup/access/current
UI/frame/input/runtime supervision, active Firefox sandbox and replacement persistence remain
NOT_RUN or unqualified. One next proposal is the same bounded qualification after separately
dispatched fresh capacity/identity/packet gates. No automatic retry, merge or issue close.
