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

## Remaining

Obtain a green combined production-wizard run and prove fresh physical Meeting
and opted-in Main/text delivery from the final controls. Complete authenticated-state theme/font,
recovery/upgrade and current-input foundation/CI acceptance. Keep #3565 open and
PR #3566 draft. No merge, production deployment or completed-onboarding claim.
