# Calendar JS-60: packaged screens checkpoint

Card 525. Part of #4027. Working folder: `~/Jarv1s` task worktree.

This is a checkpoint under the brief's context bound, **not final Calendar acceptance**.
PR #4055 is included from main. The full Rust rewrite remains approved; Workshop and
Food remain excluded. Completing the remaining execution layer and authenticated
composition would exceed this checkpoint's context bound.

## What this adds

The Calendar package declares two real Rust/Leptos screens: Calendar and view-only
Calendar automation settings. Calendar shows Day, Week, work week and Month views,
all-day events, overlapping events, event details, month overflow, navigation,
loading, retry and retained-data messages. Its model uses the account's timezone,
exclusive all-day ends, midnight clipping and clock format. Event details disclose
read-only Outlook events, unconfirmed events, RSVP state and Moss-held blocks.

The screen refreshes through the host bridge every thirty seconds. Unchanged events
do not remount the body or dialog. Viewport scroll and keyed keyboard focus are
restored when changed events replace the body; the outer scroll container stays mounted. Display choices use account-scoped package KV;
invalid fields cannot change automation settings. Automation settings remain read-only
and say so visibly. The screen does not offer provider or execution controls.

The UI starts its document MessagePort before loading Wasm, keeps the iframe opaque
and sends every account request through the parent bridge. It never fetches private
API data directly or stores credentials. Packaging requires actual generated Wasm
and JavaScript alongside the unchanged fifteen SQL files. The manifest's navigation,
settings and feature declarations describe this delivered checkpoint and its gaps.

## Shared seams

The shared module UI kit gains Calendar event chips, month cells and a native modal
peek with focus containment, Escape/close dismissal and browser focus restoration.
The stylesheet builder reads the canonical startup reset as well as the existing
canonical tokens, primitives and fonts. Module layout reads the authored Calendar
CSS; generated assets stay outside the repository.

Real browser tracing reproduced a startup race: the initial document's queued
`postMessage` arrived after its frame load event, so the old bridge revoked it.
The shared `openModuleFrame` helper now pins the installer's verified same-origin
screen with a fresh document nonce. Only that nonce can open the initial document
port, even if its message arrives after the first load. Missing/wrong nonces and
replacement ports are rejected, and any later load revokes the connection. Legacy
`connectModuleFrame` behavior stays fail-closed. The nonce never authenticates an
account; authenticated requests still belong to the parent. It must never be reused.

The opaque-frame CSP permits inline style attributes for event geometry while
retaining its existing script policy and sandbox. A focused host test asserts that
script sources do not gain inline script permission. This is a shared host change,
not a Calendar-specific authentication bypass.

Host, guest, browser UI and bindgen targets remain separate. The UI uses the existing
project-local bindgen helper; no tool is globally installed. The existing manually
wrapped guest component ABI and its compiler target are unchanged.

## Verification boundary

The UI differential runner compares date grids, month navigation, event segmentation
and overlap packing against the actual production TypeScript Calendar model over six
timezones, including DST, leap dates, all-day ranges, midnight ends and invalid dates.
Native rendering tests check escaping, read-only details and retained-data retry.
Installed-package tests exercise account-private view persistence and rejection of
an injected automation-setting field without altering the saved view. They also
assert the production twenty-four-hour default when no locale is saved. All four
read-only preference/reference resources reject generic KV set requests under a
scope captured from an actual installed invocation. The same assertions fail when
only those set calls bypass Calendar's wrapper for the real downstream KV service,
then pass through the wrapper; exact rejection messages prevent unrelated failures
from satisfying the assertions.

The disposable browser fixture downloads and installs a genuinely signed local
registry package, uses the real database and guest dispatch, serves verified package
assets with the real host headers, and connects the actual opaque-frame bridge.
Its account is synthetic and it binds only to loopback. Its visible banner says it
is not signed-in Moss. This is useful screen/package proof, **not** authenticated
shell, provider, second-device or HTTPS acceptance. All database runs use verify-gate.
Command receipts and real screenshots are published in the task proof artifact.

## Review checkpoint

Both allotted independent review rounds were recorded on their reviewed commits.
The second round found that the frame opener used `randomUUID`, unavailable on
non-secure LAN origins. The same bootstrap test failed with that API absent, then
passed after switching to `getRandomValues`. CI also exposed missing dependency
preparation for the newly added offline UI build; the workflow now fetches the UI
and binding-generator lockfiles and watches both shared inputs. These final fixes
require another authorized review round before this checkpoint can be ready.

Minor findings remain visible rather than blocking the screen checkpoint: an open
event peek is a snapshot until closed; explicit retry has no progress indicator;
toolbar controls wait for a saved view response (up to the bridge timeout). The
canonical reset adds shared `body`, `box-sizing` and `.center-screen` rules; the
counter example was not visually verified. The older host `frame_check` example
still uses the load-sensitive lower-level bridge and needs a separate update.
Browser receipts initially relied on timestamps rather than installed-asset hashes.
The differential runner does not cover every heading, date-range or overflow-order
case. The KV fault witness detects a missing Calendar-specific rejection; it does
not additionally pin the downstream service's successful write result. These are
documented follow-ups below the required major-finding bar, not parity claims.

## Remaining acceptance work

1. Preserve all thirteen original HTTP contracts, including request envelopes,
   contextual projections, defaults and exact error/status behavior. The two new
   display routes are package presentation routes, not replacements for missing
   original routes. The host still sanitizes guest failures to a generic message.
2. Port `listVisibleEvents`, `createEvent`, `deleteEvent` and `rescheduleEvent` tools,
   including provider behavior and authenticated public tool/approval policy.
3. Port both job kinds, execution, retry, retention and recovery. Reconcile the
   shared host's fixed retry behavior with Calendar's original policy.
4. Port preview/approval, reserved batches, apply/idempotency, confirmation,
   follow-through, automatic mode and monitoring.
5. Supply real actor-scoped public Tasks, People, Briefing and connector adapters;
   validate complete source-run provenance before exposing the original create route.
6. Compose installed Calendar into the authenticated Rust shell and chat/action flow.
   Complete writable automation settings, provider status, event deep links and the
   rest of the original Calendar UI contract. Exhaustive Intl timezone aliases and
   locale formatting remain open. The current view choices move from device storage
   to account storage; no migration of previous device-local choices is implemented.
7. Run the full assembled parity gate and prove sign-in, trusted origins, real UI
   and an actual second device over HTTPS on LAN or tailnet. A phone-sized viewport
   on the fixture is not a second device.

The existing JS-54 draft integer-bound difference and generic-error normalization
remain open. No job/provider execution, signed-in shell, chat gateway, LAN, tailnet,
HTTPS or second-device result is claimed. #4027 and final Calendar acceptance stay open.
