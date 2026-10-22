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

## Remaining

Obtain a green combined production-wizard run with the reachable ring and prove
fresh physical Meeting and opted-in Main/text delivery from the final controls.
Complete remaining recovery/upgrade and final-input foundation/CI acceptance.
Authenticated-state native theme/font controls passed as documented above;
secure-window images do not establish visual acceptance. No code-entry request
is pending; authorized existing Gmail access can finish the next sign-in. Keep #3565 open and PR #3566 draft.
No merge, production deployment or completed-onboarding claim.
