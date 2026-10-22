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
Only committed setup offers Continue to companion; Start and hold opt-in remain
explicit on the companion screen. The ready-screen Start/hold controls from the
full spec are still a subsequent slice, not implemented in this commit.

Fields and sections stay mounted across action results. Background work updates
record-derived state; cooldown ticks do not rebuild controls. Codes are cleared
on submission/destruction and excluded from saved UI state. The new screen uses
existing NativeTheme roles, Archivo headings, numbered rules and native controls.
The guide and Meetings app-map declaration describe the actual flow and limits.

## Observed verification

Installed proof APK SHA-256:
`85eed7909225b89cf3f666bea20ac720a685d9c6c93fe34767852d5b2fc61d77`.
The isolated proof manifest includes the exact production setup and delivery
activities, preserving the original companion. It still declares no delivery
service; it is used here only for first-step UI and transaction checks.

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

## Remaining

Exercise the actual new wizard through browser approval, owner-entered native
Vocci sign-in, ring selection/restart and physical Verify. Then finish the
approved ready-screen Start/hold integration and prove fresh physical Meeting
and opted-in Main/text delivery. Complete authenticated-state theme/font,
recovery/upgrade and current-input foundation/CI acceptance. Keep #3565 open and
PR #3566 draft. No merge, production deployment or completed-onboarding claim.
