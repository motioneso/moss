# Rust server and app, slice 23 report

Issue: https://github.com/motioneso/moss/issues/4027

## Status

| Item                                                           | State                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1. Independent notifier, quiet hours, links, dedup             | Built, proven live on Linux                                                       |
| 2. Saved-server activation routing, shared-client coordination | Shared client id and window hand-off built and proven. Click activation not built |
| 3. Windows supervisor assembly and Stop                        | Not started                                                                       |

## What item 1 does

- `post` accepts text, body, urgency, event key and a same-origin `href`. One statement upserts by key, returns the notification to unread, and sets `deferred_until`.
- Quiet hours come from the Profile row `quiet-hours` (enabled, start, end, timezone). Start equal to end means always quiet. Urgent posts are never deferred. The bell still shows deferred rows.
- The desktop feed hides deferred rows and counts a receipt as accepted only when it is newer than the notification's last update. A keyed update alerts again.
- `moss-app notifier run|once|add|forget` is a separate process. It holds one lock, polls over the pinned HTTPS connection, raises the native notification, and records the receipt.
- The window enrols once per server. The server returns a 64-hex device token once and stores only its SHA-256 in `app.desktop_notifier_devices` (migration 0362). The token opens only `/api/notifier/notices`, and only with the matching client id.
- While the window is open it writes a heartbeat file. The notifier skips that server for 15 seconds after each heartbeat, so one alert is raised, not two.
- Removing the device deletes the row and the token stops working.
- Receipts carry the version of the notification that was shown, so a late receipt for an old version never covers a newer update. The open window treats a refreshed notification as new too.
- When the page sees a signed-out session, the app forgets the notifier entry for that server. The server-side token is not revoked at sign-out (the page cannot call a signed-out API), so it lives until the device is removed.
- Start equal to end holds alerts until quiet hours are switched off.

## Proof

`pnpm test:rust-module-assembly` through the gate runner: pass. It covers, over HTTPS with a throwaway database and a stand-in notification service on a private session bus:

- Token refused when missing, wrong, for another client, and on any other route.
- Only the hash is stored.
- Toast raised once, no repeat on the next round, repeat after a keyed refresh.
- Bell reads untouched by alerts.
- Quiet hours hold back, urgent goes through.
- Window heartbeat hands off, revoke stops alerts.

## Not proven

- Sign-out does not revoke the token on the server, only the local entry.
- Click on a notification does not open the app at the notification's server and path. The feed carries `href` but nothing uses it.
- Item 3 (Windows supervisor assembly and Stop) was not started.
- Windows and macOS notifier paths are not run. Only Linux is proven.
- The notifier is not started at login and does not restart after a reboot.
- Metadata and push are not ported.
- The quiet-hours rule for a clock time that does not exist or occurs twice (daylight saving) differs from the Node version.
- Row-level security is enabled but not forced on the devices table. Reads go through a definer function and writes through the owner's own session.
- The toast text for page-raised alerts is generic.

## Review

Round 1 (Codex): four major findings (alerts after sign-out, window swallowing refreshed alerts, stale receipt covering a newer version, always-quiet releasing daily). All fixed except server-side revocation at sign-out, which is listed above. Gate rerun passes, including a late-receipt check and an always-quiet check.
