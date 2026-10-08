# Email alerts and quiet hours — throwaway preview

Design-only preview for [#3103](https://github.com/motioneso/moss/issues/3103), part of
[#3096](https://github.com/motioneso/moss/issues/3096), using product definition #3097,
revision `13cd364fe`. Branch: `prototype/email-alerts-quiet-hours`.

One clickable desktop/phone Settings flow, with fictional data and browser-memory state.
The earlier chat layout is preserved: 380px dock, closed three-line overlay, direct typing
in new side chats, automatic titles, and no main-chat update banners. The controls above the
app are review tools, separate from product UI. One presentation is intentional: this is the
final flow following the earlier layout decisions, rather than another layout comparison.

No production entry imports this preview. No account, scheduler, connector, notification,
worker, database, browser-storage or permission changes occur. App-map declarations describe
shipped behavior and therefore remain unchanged. Keep this branch out of main.

## Run

From this throwaway branch in `~/Jarv1s-interruption-preview`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
INTERRUPTION_PREVIEW_PORT=$(devports claim interruption-design)
pnpm prototype:interruptions --port "$INTERRUPTION_PREVIEW_PORT"
```

Open `/interruption-preferences.prototype.html`. Use `example=<key>` to share an example and
`view=phone` for the narrow preview. Stop the server and release its port when finished.

The dedicated Vite config also builds the fictional entry; it is separate from the app build.
The built HTML, assets and public fonts can be served as static files. Private preview addresses
and repeatable Firefox checks/evidence live in the Moss vault.

## Try

- Turn off **Automatic email alerts**. Run an automatic alert, requested inbox watch, and
  requested news check: only the unsolicited alert stops.
- Run work at 11 PM. Open chat: useful messages are already readable. **End quiet hours**
  releases waiting sample device interruptions without adding duplicate chat messages.
- Mark a finding urgent: it still waits. Use **Change in chat**, then send
  “Let Maya’s reply interrupt me during quiet hours”. Only that watch gains an exception.
  Remove it with “Stop Maya’s reply interrupting me during quiet hours”.
- Open Notifications and turn off This device. Even the exception cannot bypass that choice.
  Email digest is an independent scheduled summary, not a second inbox-alert switch.
- Select different saved quiet hours: choose the saved off preference or saved 10 PM–8 AM
  schedule explicitly. The preview refuses to infer an authoritative value.

| `example`      | What it demonstrates                                                       |
| -------------- | -------------------------------------------------------------------------- |
| `fresh`        | Automatic email alerts on when no email choice is saved                    |
| `saved`        | A saved email-off choice stays off                                         |
| `disconnected` | Saved alert choice remains; no email checked until connected               |
| `revoked`      | Disabled email access remains respected; requested email checks cannot run |
| `conflict`     | Explicit reconciliation of different saved quiet-hour settings             |
| `empty`        | No requested tasks or exceptions to edit                                   |
| `loading`      | Preferences unavailable while loading; use the review selector to finish   |
| `error`        | Failed load with a Try again action                                        |
| `saveError`    | Failed quiet-hour save keeps the old effective schedule and unsaved draft  |
| `muted`        | Existing module-notification mute blocks outward interruptions             |

All examples use a fictional saved 10 PM–7 AM Pacific quiet-hour schedule, except the explicit
conflict. This is sample data, not a new default for quiet hours. Native time inputs validate
required values; matching start/end values are rejected. The sample clock is local to the
selected zone; it does not simulate daylight-saving transitions or real wall-clock scheduling.
Email links open the sample connected provider's Gmail in a new tab. Production must use the
actual connected provider, rather than hardcode Gmail. Arbitrary text receives a short sample
reply; this is not a real assistant. Review controls may run a new fictional finding repeatedly.

## Existing controls inspected and proposed reconciliation

- **Email access**, in Connectors: `settings-personal-data-panes.tsx` reads account feature
  grants and updates them via the existing feature-grant mutation. It authorizes reading and
  must remain separate from alerts. Enabling alerts never reconnects or grants access.
- **Email source monitoring**, `proactive.monitoring.v1`: its master and email source default
  off, with saved per-source caps (`proactive-monitoring-api.ts`, proactive preference routes,
  preferences repository and scanner). The proposed Automatic email alerts switch reuses the
  existing email source choice. Default on applies only when there is no saved choice; saved
  source/master-off choices require preservation and explicit treatment before implementation.
- **Notification choices**: existing Notifications has per-module enable/mute, device push,
  and Email digest (`settings-module-subviews.tsx`, notification preference routes). These
  describe delivery, not email-reading permission. The preview shows a saved module mute and
  existing channels; it adds no global notification switch or external integration.
- **Profile quiet hours**, `quiet-hours`: defaults off, 22:00–07:00, optional timezone;
  exposed in Profile and referenced by Notifications (`settings-personal-panes.tsx`,
  `quiet-hours-routes.ts`). Notification creation currently lets urgent events bypass this.
- **Proactive quiet hours**, `proactive.monitoring.v1.quietHours`: defaults on, 22:00–08:00;
  the proactive anti-spam path separately defers cards (`proactive-monitoring-api.ts`,
  `anti-spam.ts`). Both settings and their consumers were inspected.

Proposal for review: make the timezone-capable Profile preference the one authority behind
**Alerts & quiet hours**; existing surfaces link to that page. Preserve saved choices, and
explicitly ask which schedule to use when old values disagree. Continue and persist requested
work during quiet hours; defer only outward interruptions. An exception comes only from an
explicit request for the particular task and still respects disabled notification channels.
Do not inherit the existing generic urgent-event bypass for this feature.

Still needs agreement before production: exact migration of saved master/source preferences;
how legacy proactive-card deferral and caps coexist with immediate chat delivery; whether saved
per-source caps also govern unsolicited chat updates; conflict detection for old preferences;
and where user-requested exceptions are stored/enforced. These are review decisions, not
implemented migrations. The preview shows the proposed behavior without changing saved data.

## Review and verification

Ready for Ben's review; no screen decision is accepted merely because this preview is runnable.
Issue #3103 stays open. Scoped formatting/lint, web typecheck, design-token/UI-class checks,
and dedicated preview build are checked before handoff. Firefox exercises the source and
hosted copy, desktop/phone, 320/375/414/768px widths, light/dark/Teal, saved-off choices, all
recovery states, quiet-hour boundaries, explicit exceptions, disabled channels, fixed dock
geometry, overlay focus/inert/Escape, and reload reset. Browser requests must be local GET
assets only; browser storage stays empty. The repeatable checks are saved outside the public
repository in the Moss vault.

This validates fictional UI interactions only. Persistence, real scheduling, permissions,
notification delivery, preference migration, timezones/DST and background concurrency need
separate implementation and live proof against the approved feature specification.
