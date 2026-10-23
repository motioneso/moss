# Vocci product wizard: first installed checks

Part of #3565 / draft PR #3566. Implements the bounded
[product wizard plan](../superpowers/plans/2026-10-21-vocci-product-setup-wizard.md).
This is partial acceptance, not a finished setup-to-delivery result.

## Changes

The production launcher sends installs without configuration to `SetupActivity`.
Existing configured installs retain `DeliveryActivity`. The wizard composes the
existing production staged-link, native Vocci account and ring-verification
transactions. It exposes explicit email-code/resend/TOTP, saved lookup recovery,
owned-ring selection, Bluetooth and official-app handoff, and native Verify.
The first wizard slice offered Continue to companion after commit. A subsequent
ready-screen slice now adds explicit Start/Stop, permission/background settings
and hold opt-in through the same service commands used by the companion.
Opening setup preserves existing delivery and hold choices. Installed checks
for that subsequent slice are recorded separately below.

Fields and sections stay mounted across action results. Background work updates
record-derived state; cooldown ticks do not rebuild controls. Codes are cleared
on submission/destruction and excluded from saved UI state. The new screen uses
existing NativeTheme roles, Archivo headings, numbered rules and native controls.
The guide and Meetings app-map declaration describe the actual flow and limits.

## Observed verification

Installed proof APK SHA-256:
`85eed7909225b89cf3f666bea20ac720a685d9c6c93fe34767852d5b2fc61d77`.
The isolated proof manifest includes the exact production setup and delivery
activities, preserving the original companion. That proof build declared no delivery
service and was used only for first-step UI and transaction checks.

`SetupUiChecks` passed on the Samsung in light and dark themes at 100% and 150%
font scale. Each execution opened the actual production activity on empty state,
entered an invalid Moss address and pressed Connect. Assertions checked the
address error, retained input/view identity, disabled Vocci input before Moss,
no staging/auth/queue creation, unellipsized laid-out text and 48 dp button
heights. These are executable layout checks for the empty/error screen, not
visual acceptance of authenticated ring/ready states.

The initial installed UI test failed because the hidden Vocci email field was
still enabled before the Moss prerequisite. That prerequisite is now reflected
in control state, and all four restored UI runs passed. The test runner now
transports main-thread assertion failures as instrumentation failures rather
than allowing them to crash the app process.

Installed synthetic suites passed: 42 native-auth, 27 staged-link and 28 ring
transaction contracts, each `result=PASS` and instrumentation code `-1`. The
ring suite additionally checks that committed account/origin/ring summary remains
available after staging removal. These do not replace live account/ring proof.

The actual production development APK was also installed over the original
configured companion. Before installation, delivery was stopped and no browser
link request was pending. Its launcher opened the existing delivery screen,
without Vocci sign-in. Original encrypted configuration and delivery-journal
hashes matched before/after. Delivery was not started. This checks the upgrade
launcher/data boundary, not renewed physical delivery.

Host crypto/protocol/transfer/restart and generated two-hour WAV checks passed.
Sequential production/proof APK builds and signatures passed. Root TypeScript,
scoped ESLint, changed-document formatting and file-size checks passed. The old
full foundation run `20261021-191313` also finished exit 0 (4,075 integration
checks, 17,872 unit checks), but tested earlier clean `11278ea4a`, inputs
`7ff1e3b6c2d9`; it does not validate this wizard or the later account fix.

The first current-input foundation (`20261021-204603`) and live proof
(`20261021-204719`) both stopped before migration because the new Meetings
app-map description exceeded its 240-character contract. The descriptions were
shortened without dropping the setup prerequisites or recovery guidance; direct
module-registry validation now checks that runtime contract as well as TypeScript.
These failed launches are not live wizard acceptance.

## Production wizard live run

Canonical run `20261021-204858` tested clean `c770b6724`, inputs `bb237715ee19`.
The actual production empty launcher, native Connect, real browser approval,
account confirmation, restart, owner-entered native Vocci email-code sign-in,
real owned-ring inventory, explicit selection and selected-ring restart passed.
The harness then failed with an ADB operation error at its physical/owner commit
checkpoint. Its final exit code is 1; there is no combined green result.

Afterward the actual native screen showed Ring verified / Setup saved. Installed
state inspection reported COMMITTED, configuration present and staging absent.
Failure cleanup used the real browser Sign out device confirmation and observed
the disposable device row disappear. Only that revoked isolated configuration
was removed; installed inspection then reported EMPTY with no config/staging.
Original companion configuration/queue hashes matched across that cleanup.
These are separately recovered observations, not a passing combined run.

## Ready-screen installed checks

The subsequent ready-screen slice adds shared `DeliveryActions` used by setup
and the configured companion, plus Ring setup and delivery options to reopen
the saved summary. Start continues to use the service's existing explicit action;
voice changes use its existing worker-owned journal, stable-inventory baseline
and review/Send rules. New setup commits retain the confirmed account display
name; older configurations continue to use their owner-ID fallback.

Installed `SetupReadyChecks` passed on the Samsung in light/dark at normal/150%
font scale. These clearly synthetic isolated fixtures verify stopped hold controls,
no automatic Start or journal writes, preserved existing hold choice, explicit
Stop disabling restart recovery while retaining the journal, no ellipsized text
and 48 dp targets. This matrix used the no-service proof build and did not prove
actual Start or delivery. The final proof manifest now includes the real
production service and its permissions for the upcoming complete live run; the
launcher opens the same production delivery/setup route. A first matrix run exposed instrumentation termination
before fixture cleanup; cleanup now finishes before instrumentation reports its
result, and all four runs passed afterward. The dedicated fixture was removed.

All 42 native-auth, 27 staged-link and 28 ring contracts passed again on that
proof build. Host crypto/protocol/transfer/restart and generated two-hour WAV
checks and sequential APK builds passed. The direct proof-build invocation first
hit its non-executable script mode; invoking the existing script via Bash worked.

The final proof build SHA-256 is
`d7efd84b28dd9c9338eec192530505324b492429ac853c5af01e8440611ac03d`.
With the real service declared, both empty/error and synthetic ready matrices
passed again (eight executions total); all 97 auth/link/ring contracts also
passed again. The synthetic ready check never presses Start. Root app-map build,
scoped lint, formatting and file-size checks passed. Current-input full foundation
and physical service acceptance remain pending.

The original configured companion was upgraded again and its actual Ring setup
and delivery options button opened the saved Ready screen. Start was available,
delivery remained stopped, and original config/queue hashes matched. No new
Vocci sign-in or service Start was needed for that upgrade check.

## Latest bounded live checks

Run `20261021-211131`, on clean source `8f24358bd` (inputs `c9d68993572a`),
expired while the owner was away with the phone. Its browser cleanup confirmed
Sign out device and row removal. The later native screen showed that the owner's
selected ring had survived restart. This did not complete physical verification.

Run `20261021-214856` tested documentation HEAD `b9d546303` with the same
implemented source and one changed coordination document (inputs
`4e5c3b78edda`). Actual native Moss Connect, fresh browser owner signup and
approval, configured AI settings, account confirmation and process restart passed.
With the owner's express authorization, an assistant used the existing Chrome
Gmail session to read the newly requested Vocci email code and enter it directly
in the actual native UI. Only one code request was sent; an interrupted UI read
resumed the same request. Code values and account details are omitted here.
Native verification, the real owned-ring inventory, explicit selection and
selected-state restart passed. Android's intervening Save/No thanks prompt was
dismissed with No thanks before continuing.

The complete run still exited 1 at its physical/owner commit checkpoint. Installed
inspection reported LINKED, configuration absent and staging present. A separate
installed `SetupPhysicalCheck` then returned `result=FAIL`, reason `ring_connect`,
instrumentation code `1`. The owner also reported that fresh audio was unavailable.
Neither actual Start/hold nor new Meeting/Main delivery was reached in this run.
Browser failure cleanup confirmed disposable-device row removal. Only that revoked
isolated staging was removed; EMPTY was confirmed. Original config/queue hashes
matched across cleanup, and the original screen timeout was restored.

A separate harness defect was reproduced: passing an unquoted nested `sh -c`
command through ADB caused a true constant test to return 1; correctly quoting the
same command returned 0. Both private completion checks were corrected. That fix
was not rerun through complete setup and does not turn the failed run green.
The private observer now detects actual selected-ring UI rather than relying on
a chat marker; concurrent native UI inspection must be serialized.

CI passed, including its overall gate, Android, static, unit, integration,
Meeting, browser, compose and auth-control jobs, on the implemented source.
Local foundation `20261021-210957` failed one News focus-refresh unit test:
17,871 passed, three skipped. Its isolated rerun passed all 13 tests.
Full foundation rerun `20261021-214931` completed exit 0: 392 integration files,
4,075 tests passed and two skipped. It tested documentation HEAD `b9d546303`,
the same implemented source `8f24358bd`, and the changed coordination document
(inputs `4e5c3b78edda`). Documentation commit `3f5003a16` also passed CI.
This local receipt applies to those recorded inputs; it is not a final-HEAD rerun.

## October 22 resumed acceptance

The first resumed run (`20261022-101252`) exited 1 at native sign-in observation.
Gmail-assisted native sign-in and explicit selection passed separately. Suspending
the observer while it had an ADB child caused its subprocess deadline to expire.
Browser cleanup revoked the disposable device; isolated staging was removed and
EMPTY confirmed. The private harness now uses a cooperative completion marker
for native UI ownership, followed by an assertion of the actual selected summary.
The marker does not substitute for observing the production UI.

The subsequent run (`20261022-101640`) passed actual native sign-in, inventory,
selection and selected-state restart. Physical identity/key and fresh Moss owner
checks passed, configuration was committed atomically, the actual Ready-screen
Start launched the production service and completed a ring inventory, and the
separate hold opt-in enrolled against a stable inventory. Fresh Meeting/Main
sample collection expired after 240 seconds without fresh samples. The run
exited 1. Browser cleanup confirmed disposable-device removal; only its revoked
isolated configuration/delivery state was removed. Original configuration and
queue hashes matched the retained upgrade baseline. No combined green result
is claimed. The owner subsequently began a hold sample and planned a meeting
recording, after the isolated test session had ended; neither is delivery proof.

The real authenticated Ready screen also passed a light/dark × 100%/150% text
matrix. All four runs retained the configured identity and checked hold choice,
kept Stop available and preserved the encrypted configuration hash; original
font/theme settings were restored. These are actual native accessibility/control
state checks. Secure-window screenshots were blank, so they do not establish
visual acceptance; the earlier executable layout checks remain the evidence for
unellipsized text and target size.

## Long-recording clock-drift regression

The real service downloaded a 42-minute recording and all upload chunks, but
finalization returned HTTP 400. Its declared and decoded audio duration both
measured 2,513,160 ms; the ring's start/end timestamps spanned 2,509,000 ms.
The 4,160 ms difference exceeded the former fixed 1,500 ms consistency bound.
Packet framing, hashes and canonical WAV validation independently passed.

Elapsed timestamp validation now permits 0.2% drift plus one second of timestamp
quantization, with the existing 1,500 ms floor for short recordings. Declared
duration must still match decoded audio within 1,000 ms. Chronology, bookmark,
framing, hash and duration/size limits remain enforced. This is a measured
compatibility fix, not a claim that two-hour hardware endurance passed.

The retained private real-source reproduction failed before the fix and passed
after it. Generated source regressions cover the observed 42-minute pattern,
short-recording and excessive long-recording drift rejection, and mismatched
declared duration. The focused source/bundle suites passed all 59 tests.
Isolated HTTP receiver gate `20261022-103030` exited 0: all 13 integration tests
passed, including finalization with the measured drift pattern. These generated
fixtures are transport validation evidence, not physical recording or ASR proof.
Full foundation and CI must rerun for these source changes.

## Real meeting transcription regression

Run `20261022-105852` repeated native setup through Ready Start. The real
42-minute and 26-minute recordings both passed upload validation and created
Meetings; the latter preserved four bookmarks. The run exited 1 while the
harness waited 120 seconds for hold enrollment during transcription. Enrollment
completed afterward. This is partial evidence, not a combined green result.

The 26-minute recording subsequently failed transcription. Actual configured
ASR inference reproduced the failure in its fourth 30-second window: an empty
zero-duration segment overlapped the end of the preceding speech segment.
The timestamp parser rejected the entire response before Meeting validation.

The parser now ignores only empty or whitespace-only, exactly zero-duration
markers after validating numeric bounds, string shape and text budget. It
preserves speech and existing overlap limits, and rejects speech without any
retained timestamped segments. Generated regression tests failed before the fix
and passed afterward. The captured private response also failed before and
passed after. All 53 windows of the actual 26-minute source then passed fresh
ASR inference through the production parser and Meeting window validator.
No audio or transcript content is committed. This replay validates transcript
compatibility; it does not prove persisted Meeting summary or Main delivery.

Focused timestamp/configured-transcription/routes/app-map suites passed all
88 tests. Scoped ESLint passed. CI passed on previous source `b183b38ec` after
a browser dependency-installation retry; its local foundation passed static,
17,878 unit tests (three skipped) and 35 UAT-seed tests. Its integration run was
stopped after the parser changed and invalidated the recorded source inputs.
Those receipts do not validate this new fix. Root and test TypeScript checks
also passed for the fix.

## Subsequent live recovery checks

Run `20261022-112006` stopped at its empty-install prerequisite because revoked
state from the prior disposable run remained on the phone. The earlier browser
revocation was confirmed before removing that isolated state. Actual EMPTY and
unchanged original configuration/queue hashes were then checked.

Run `20261022-112204` passed Moss linking but exceeded native sign-in observation.
Separately, native sign-in cleanup, a fresh email-code request, owned-ring
selection and Cancel setup passed; actual EMPTY was confirmed. These separate
observations do not make the canonical run green.

Run `20261022-113711` recovered account inventory through the actual Finish ring
lookup control, explicitly selected the owned ring and observed its saved
selection after restart. Physical Verify did not commit configuration; the UI
showed the generic network/Bluetooth retry message. The exact failed boundary
was not established. No delivery journal was created and no fresh sample was
requested. Browser cleanup confirmed disposable-device removal, isolated state
was removed only afterward, and actual EMPTY plus unchanged original hashes
were confirmed. The owned browser, reverse and proof servers were stopped.

The private observer now retains verified sign-in for one explicit Finish ring
lookup retry, and can run the existing content-free physical diagnostic after
a failed Verify. A diagnostic does not substitute for production Verify/commit.
Instrumentation closes the app's foreground activity; after any such check,
reopen the native UI before observing controls. No instrumentation should run
concurrently with an owner of native UI automation.

On source `6982161f3`, isolated foundation `20261022-112201` passed static,
type/app-map, 17,888 unit tests (three skipped) and 35 UAT-seed tests. Integration
remained running. CI initially failed before unit tests during Playwright
dependency installation: Ubuntu download timeout followed by a retained apt
lock. The single failed-job retry completed successfully; workflow
`39830709914` is green on `6982161f3`. This does not resolve live acceptance.

The same isolated foundation run subsequently completed with exit 0: all
392 integration files passed, with 4,076 tests passed and two skipped. Its
receipt records clean source `6982161f3`. The later documentation-only commit
`a96c3b5cc` does not change that tested source. Live acceptance remains open.

## Latest installed setup and delivery run

Run `20261022-125024` retained native sign-in and selection across restart, but
the first production Verify did not commit. The existing physical diagnostic
passed without configuration. One actual Verify retry then committed and showed
the saved Ready state. The first failure's boundary remains unknown; the
canonical run still exited 1. Browser revocation, isolated EMPTY cleanup and
unchanged original configuration/queue hashes were confirmed.

Run `20261022-125849` passed actual Moss browser linking and restart retention,
native Vocci sign-in, explicit selection/restart, physical verification on its
first attempt, fresh Moss owner verification and atomic configuration save.
Actual Ready-screen Start retrieved recordings; explicit hold opt-in completed
stable-inventory enrollment. Three normal entries reached `complete` in the
production journal. No fresh post-enrollment hold entry arrived before the
15-minute outer timeout. The canonical run exited 1; visible Meeting outputs,
hold review/Send and Main text reply were not reached. Journal completion alone
does not establish those UI checks.

The timeout terminated the browser before its normal revocation cleanup ran.
The disposable server and its dedicated database container were destroyed by
the gate; browser revocation was **not observed**. A separate actual native Stop
disabled recovery. After confirming the disposable endpoint and database
container were gone, isolated setup/configuration/delivery files were removed.
Installed inspection confirmed EMPTY; original companion configuration/queue
hashes still matched the upgrade baseline. The owned reverse was removed and
the original phone screen timeout restored. These are recovered cleanup steps,
not a combined passing run.

One other normal entry failed before upload. Replaying its private captured
packet file through the actual production `RingProtocol.PacketReader` fails
after 48,846 complete packets with `packet header/length`. The phone's packet
file and captured copy are both 5,242,880 bytes; the last packet declares 101
bytes with only 71 remaining. This establishes an incomplete local packet file,
not its cause on the ring or during retrieval. No partial audio was uploaded and
no ring recording was deleted. Audio, timestamps, identifiers and transcripts
remain private.

The live gate's bounded browser window is increased to 30 minutes so native
sign-in, existing backlog processing, fresh samples and cleanup can fit in one
run. The private observer also handles termination through its failure/cleanup
path. Neither change supplies missing delivery evidence. Earlier foundation and
CI receipts validate their recorded source; a new live run remains necessary.
Scoped ESLint, root TypeScript, Prettier and diff whitespace checks pass for the
timeout-only gate change. These checks do not replace its pending live rerun.

CI on documentation head `9a9eb7b3a` initially failed before tests in the unit,
Meeting draft UI and Meetings runtime lanes during browser installation. One
failed-job rerun was requested for each affected workflow. The unit lane again
exhausted its five-minute install attempt while Ubuntu packages were still
downloading; its immediate second attempt failed because the first installer's
apt child retained the package lock. No third rerun was requested. Its workflow
now spends the existing two-attempt ten-minute total budget on one bounded
attempt, retaining the named timeout annotation and 45-minute job backstop.
All 16 existing CI phase/deadline tests, workflow formatting and diff checks pass.
Fresh CI is still required for that workflow change. Foundation
`20261022-152714` was stopped after the workflow changed; it has no passing
final-input verdict.

## Fresh hold received after complete setup

Run `20261022-152028` passed browser-approved Moss linking and restart retention,
native Vocci sign-in, explicit ring selection/restart, first-attempt physical
identity/key verification, fresh Moss-owner confirmation and atomic save. Actual
Ready-screen Start and stable-inventory hold enrollment passed. Three normal
entries completed, and the owner's new physical hold produced a receipt after
enrollment, outside the eight-entry baseline. No readiness marker or baseline
hold was substituted.

The automatic Meeting summary did not reach the observer's saved condition
within 150 seconds. The run exited 1 before visible Meeting output or hold
review/Send/Main reply checks. Receipt arrival alone does not prove those checks.
The observer now saves structural summary status and continues the independent
hold check after a summary failure; a missing summary still fails combined
acceptance. This private observer change compiles but has not passed a live run.

Actual browser failure cleanup removed the disposable device session. Isolated
configuration, staging and delivery were cleared; installed inspection confirmed
EMPTY and original companion configuration/queue hashes matched the baseline.
The owned browser and reverse stopped, and the phone timeout was restored. Native
Stop was not observed in this run. Private copies of short normal and fresh hold
audio were retained for server diagnosis without requesting another recording.
Replays remain separate from combined physical setup acceptance.

## Captured-audio runner diagnosis

A separate no-phone replay imported the retained short normal recording through
the real HTTP recording endpoint and completed transcription. The manually added
proof model initially advertised only Chat, so automatic summary failed with
`meeting_output_route_unavailable`. Enabling JSON and Summary through Settings
exposed `meeting_output_subscription_isolation_unavailable`: the private host
runner had not enabled per-user UID isolation. A separate retained-hold replay
reached actual review and Send to Main, but its reply was interrupted. Neither
replay establishes successful physical delivery.

An owned disposable container now enables real per-user UID isolation, uses
separate authentication and socket storage, and leaves production unchanged.
The relevant runner source hashes match this branch. Its proof-only executable
is the audited CLI version with the digest required by the constrained profile;
no version or isolation guard was relaxed. Constrained RPC preflight and actual
Meeting output availability now report ready/available. Replay
`20261022-155541` still exited 1 with `meeting_output_provider_failed`; a real
model probe identified a revoked proof credential. After a normal local CLI
login refresh and supported proof-token provisioning, both constrained and
ordinary fresh RPC probes passed. Replay `20261022-155858` completed transcription
and saved one automatic summary; it exited 1 at the Main reply assertion.

A separate loopback control reproduced the container networking mismatch: the
runner could not reach a host-local HTTP endpoint on its bridge network, then
could reach the same endpoint after switching the owned runner to host networking.
Both RPC readiness probes passed again. This repairs the proof topology without
changing app authentication or per-user homes. A new replay now also requires the
actual Meeting transcript/summary and Main reply to be visible. That replay,
`20261022-160251`, exited 0 on source HEAD `9493096ac` with two documentation
files dirty (input fingerprint `0469d6cf7c47`). It observed the actual Meeting
transcript and saved automatic summary, then the retained hold's review,
explicit Send to Main, persisted reply and visible answer four. The replay uses
an uncertain capture timestamp and is not fresh physical setup acceptance.
Its disposable endpoint/worker/database and provider stopped afterward.

All six CI workflows passed on `9493096ac`, including overall CI
`39865534417` after the pretest browser-install retry. Local foundation
`20261022-153110` completed with exit 0 on clean `9493096ac`, input fingerprint
`eae05e3c331b`: static checks, 17,888 unit tests (three skipped), 35 UAT-seed
checks and 4,076 integration checks (two skipped across 392 files) passed.
Integration took 3,638 seconds; quiet log intervals did not establish a failure.
The owned database container was removed. These receipts apply to their recorded
inputs. Captured audio and diagnostic authentication artifacts remain private.

## Current physical delivery and recovered output proof

Run `20261022-160626` tested `9493096ac` with two evidence documents dirty
(input fingerprint `1dfbdc789695`). Browser-approved Moss linking, restart,
authorized Gmail-assisted native Vocci sign-in, explicit owned-ring selection
and restart passed. Physical identity/key and fresh Moss-owner checks passed;
configuration was saved atomically. Actual Ready-screen Start and stable-inventory
hold enrollment passed with nine baseline identities. Normal recordings were
retrieved from the ring, uploaded and processed in this setup session; a separate
read-only check observed two saved automatic summaries.

The owner reported completing a hold, but no fresh entry appeared before the
420-second sample window. The journal included a ring connection failure. The
owner brought the ring beside the phone, then repeated the hold and confirmed
vibration. A new post-enrollment voice entry reached Moss just after the deadline.
The canonical run entered its bounded recovery pause and ultimately **exited 1**;
no completion marker or baseline hold was used to turn that result green.

A separate observer continued against that same running disposable instance and
actual configured phone, before canonical cleanup. It required a genuinely new
recording outside the saved baseline and the matching current enrollment. It
observed the actual Meeting transcript and saved automatic summary through the UI,
the fresh hold transcript in review, explicit Send to Main, and a persisted and
visible real text reply answering four. It then pressed the actual native Stop
control and observed the stopped journal. This supplemental observer exited 0.
These are recovered physical/UI observations, not captured-audio replay and not
a passing canonical gate receipt.

The canonical observer then used browser Active sessions to revoke the disposable
device, observed its row disappear, confirmed isolated EMPTY and unchanged original
configuration/queue hashes, and removed its browser and reverse. The wrapper was
collected with exit 1; its provider stopped. The original phone timeout was restored
to two minutes after hardware cleanup. No new owner action is pending. The first
hold's absence is unexplained; vibration and proximity on the successful repeat
do not establish its cause.

## Permission denial, saved-selection recovery and final CI

Focused native checks in runs `20261022-163642` and `20261022-164704` denied
Nearby devices access to the isolated proof package only. Pressing the actual
Verify control showed the actionable permission remediation. Configuration
remained absent, encrypted selection remained staged, and the original
companion configuration and queue hashes were unchanged. Interrupted native
sign-in was also recovered through the actual Clean up sign-in control; a new
request waited until Send code was enabled. No prior code or session was assumed
valid after cleanup.

Both canonical runs still exited 1 while automating the subsequent permission
grant. In the second run, a separate observer opened the actual native Allow
Nearby devices action, observed Android's permission-controller dialog, pressed
its Allow control and confirmed the platform grant. Without another email code,
it pressed the actual Verify ring control on the saved selection. Physical
verification and atomic publication completed; staging was absent and the
original companion hashes remained unchanged. The recovery observer exited 0;
this does not change the canonical failure into a passing receipt. The exact
cause of the missed automated permission grant is unresolved.

Actual browser failure cleanup then revoked the disposable device and observed
its row disappear. Isolated EMPTY and unchanged original hashes were confirmed;
the owned browser and reverse stopped. No new recording was requested in these
permission checks.

All six CI workflows completed successfully on `bcfcbc714`, including overall
CI `39871720426`, Android `39871720779`, app actions `39871720459`, Meeting
revocation `39871720631`, Meeting security `39871720513` and Meeting draft UI
`39871720714`. Unit and draft-UI jobs each needed one pretest dependency-install
retry. The retries passed without relaxing assertions. Local foundation
`20261022-153110` remains the complete passing receipt for its earlier recorded
inputs; this documentation update does not turn it into a receipt for a new HEAD.

## Bounded follow-up and stopping the repeated setup cycle

Focused run `20261022-170202` tested `bcfcbc714` with this evidence document
dirty (fingerprint `a6c212b98f7b`). Native/browser account setup, real Vocci sign-in,
explicit selection/restart, actual Android Nearby grant after one explicit
request retry, physical identity/key verification, fresh-owner confirmation,
atomic save and actual Ready Start passed again. The journal showed a genuine
pending ring download and hold opt-in requested; fresh hold enrollment and new
Meeting output were not claimed in this run.

The run was narrowed to a separate pending-download upgrade check instead of
waiting for another download of old long audio. That observer failed an assertion;
it did not retain enough assertion detail to identify the exact failed condition.
It is **not** a passing upgrade/restart receipt or evidence of a product regression.
The canonical observer was terminated through its owned cleanup path and exited 1.
Actual browser revocation, isolated EMPTY and original configuration/queue hashes
were confirmed. Its API, database, provider, browser and reverse stopped; the owned
proof runner stopped afterward. The phone timeout was restored to two minutes.
No further setup/sign-in run was launched.

## Acceptance accounting

| Approved requirement     | Evidence available                                                                                                                                                                                                                                                                                                                                        | Limit                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native feasibility       | Actual email-code sign-in, accepted binding GET and temporary-session cleanup; installed native contracts                                                                                                                                                                                                                                                 | Live account did not request MFA; TOTP and unsupported factors use synthetic contracts                                                                                                                    |
| Fresh setup and delivery | Physical run `160626` plus its same-instance successful recovery: real setup, Start, Meeting transcript/summary, fresh current-enrollment hold review/Send/Main reply and Stop                                                                                                                                                                            | Canonical wrapper exited 1; supplemental physical/UI observer exited 0                                                                                                                                    |
| Recovery                 | Installed auth/link/ring contracts and guard-removal controls; actual native Cancel/browser revocation, restarts, interrupted-sign-in cleanup, permission-denial remediation and saved-selection verification                                                                                                                                             | Not every network/MFA/identity failure was induced on the real account/ring                                                                                                                               |
| Upgrade                  | Actual original configured-app replacement preserved configuration/queue hashes; final [isolated installed proof](../../apps/vocci-delivery/upgrade-proof/README.md), `run-04`, passed 26 assertions covering APK replacement, Keystore/config reopening, partial/frozen bytes, source/queue/voice identity, actual Ready Start/Stop and stopped relaunch | Generated pending evidence and dummy account/ring data; no resumed physical pending transfer, enabled recovery, physical reboot or endurance claim. The earlier pending-download observer remains failed. |
| Quality                  | Installed APK/UI contracts, host checks, complete foundation `153110` and all six CI workflows on `bcfcbc714`                                                                                                                                                                                                                                             | Receipts apply to their recorded inputs; native secure-window captures do not prove screenshot appearance                                                                                                 |

## Current review status

The narrow upgrade persistence and selected-ring Back findings are resolved by
the final [isolated installed proof](../../apps/vocci-delivery/upgrade-proof/README.md),
recorded in proof documentation through `8712d0dd9`. `run-04` passed 26 named
assertions, exit 0, against baseline product source `7acb4b6b0` and corrected
candidate product source `901260d7e`. Actual APK replacement retained encrypted
configuration and Keystore decryptability, partial/frozen evidence and
source/queue/destination/voice state. Actual configured Ready skipped sign-in;
Start reached the expected closed-loopback network failure before owner
confirmation or ring access; native Stop and process relaunch preserved the
immutable evidence and stopped choice. A fresh candidate installation also
passed the actual **Choose another ring** control contract with synthetic Moss
approval, retained linking, renewed lookup, rejected discarded candidate and no
configuration publication.

Independent Standards and Spec re-review accepted this bounded evidence with no
remaining findings. The earlier real physical setup, Meeting and Main observations
remain separate evidence. The old `run_17` upgrade observer and failed combined
or intermediate harness runs remain failed. This proof does not establish resumed
physical pending transfer, enabled background recovery, physical reboot or
endurance. No further owner sign-in or new recording was required.

The user's subsequent instruction authorizes merge after independent review,
resolved findings and green required checks, superseding the earlier no-merge
status. Final exact-HEAD CI and repository checks are still required before
merging #3566 in dependency order. Keep #3565 open; this evidence does not claim
production deployment or completion of the broader onboarding/endurance task.

## Independent-review correction: return from selected ring

The selected-ring step now offers **Choose another ring** before configuration
is committed. It clears only the candidate from encrypted staging and returns
to Vocci lookup with the confirmed Moss account still connected. Lookup needs
another explicit Vocci sign-in because the previous temporary session was
cleaned up and unselected binding keys were released. The action cannot replace
a committed ring and does not start delivery, hold enrollment or ring proof.

`SetupRingChecks` adds clear-selection, recreated-controller, confirmed-link
retention, no-selected-ring verification rejection and replacement-proof cases.
`SetupSelectionChecks` adds an installed synthetic contract over the production
screen: a synthetic staged Moss approval and candidate enter the actual
**Choose another ring** control, then assert that Vocci sign-in is available,
Moss stays linked, and no runnable configuration was published. This fixture
uses a synthetic Moss port and does not prove real account or ring behavior.

At correction commit `901260d7e`, host protocol/crypto/generated two-hour PCM
checks and the development APK build passed; the separate proof APK compiled,
but the new instrumentation had not yet run. That interim status is superseded
by the [final installed proof](../../apps/vocci-delivery/upgrade-proof/README.md)
recorded through `8712d0dd9`: `run-04` passed the actual selection control and the
bounded upgrade persistence/reopen path described above. Its synthetic selection
responses and generated pending evidence remain explicitly disclosed.

The merge from current `main` preserves its CI installer implementation exactly:
privileged system-dependency timeouts followed by runner-owned Chromium download.
This supersedes the older single combined ten-minute installation workaround;
no product test or assertion was relaxed.
