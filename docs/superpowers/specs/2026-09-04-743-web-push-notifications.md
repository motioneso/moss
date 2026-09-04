# Web Push Notification Delivery (#743)

**Status:** approved by Ben in chat, 2026-09-04 (design questions answered 1 / 2 / 3 / 1, see
Resolved Decisions)
**Issue:** #743 (parent #1002). Promise surface: Settings > Modules > Notifications, the
`Coming soon · #743` row.
**Author:** Claude, brainstormed with Ben, 2026-09-04

## 1. Context

In-app notifications exist: owner-only rows in `app.notifications` with `title`, `body`,
`href`, `module_id`, `urgency` and `deferred_until` (quiet hours), a per-module on/off
preference (#735), and a digest job in the notifications module. The web app registers
`apps/web/public/service-worker.js` in production builds only; it handles install, activate and
fetch and nothing push-related. No push library, no signing key, no subscription table exists.

Push has been a visible `Coming soon` promise since #735. Ben asked to build it on 2026-09-04.

## 2. Goals

- A signed-in user can turn push on for the browser they are using, see that browser listed,
  and remove any of their browsers from any signed-in session.
- Every in-app notification that becomes visible produces one push to each of the recipient's
  subscribed browsers, carrying the notification's own title and a one-line body.
- Quiet hours are respected the same way in-app delivery respects them, with one summary push
  when quiet hours end.
- Nothing needs a hand-edited settings file; the app generates and stores its own signing key.

## 3. Non-Goals (v1)

- Phones, tablets and installed home-screen web apps. The design does not exclude them, but
  the live-path gate is desktop Chrome and Firefox only (Ben, question 3, answer 3).
- Per-module push preferences separate from the existing per-module notification preference.
- Rich pushes: images, action buttons, sounds, badges.
- Email digest (#742) and any other channel.
- Admin controls over push. Any user may enable it (Ben, question 4, answer 1, in line with
  "installing a module grants normal use").

## 4. Resolved Decisions

1. **Payload = title + one-line body** (Ben, question 1, answer 1). Body is the notification
   body's first line, trimmed to 120 characters. Title trimmed to 60. The payload also carries
   the notification id and its `href` path (app-relative only, never an absolute URL) so a tap
   opens the right screen. No metadata, no module data, no user data. Web push payloads are
   encrypted end to end (RFC 8291), so Apple, Google and Mozilla relay ciphertext; the text is
   still visible in the device tray, which Ben accepted.
2. **Quiet hours: one summary push at release time** (Ben, question 2, answer 2). Deferred
   notifications never push individually. When the deferral time arrives, one push reads "N
   notifications while you were away" (N = the recipient's notifications whose `deferred_until`
   fell inside the window just ended and are still unread). Urgent notifications are never
   deferred today and push immediately.
3. **Desktop Chrome and Firefox are the v1 proof targets** (Ben, question 3, answer 3).
4. **Self-service enable, no admin step** (Ben, question 4, answer 1). The instance signing key
   pair is generated the first time any user enables push.
5. **Signing key lives in the database, encrypted**, using the existing secret cipher in
   `packages/db/src/secret-cipher.ts` (AES-256-GCM at rest), never in an env var or compose file
   (Ben's 2026-09-01 ruling: no new feature may require a hand-edited settings file).
6. **Subscriptions are owner-only rows** under RLS. The worker role gets SELECT and DELETE for
   delivery and cleanup, mirroring the notification_reads worker grant pattern (0166).
7. **Job payloads are metadata only**: notification id and recipient id, or recipient id and
   release time. The delivery job reads the notification text inside the recipient's data
   context.

## 5. Architecture

### 5.1 Data (notifications module SQL, new files, never edits)

- `app.push_subscriptions`: `id`, `owner_user_id`, `endpoint` (unique per owner), `p256dh`,
  `auth`, `user_agent_label` (short, derived server-side from the User-Agent, for example
  "Firefox on Linux"), `created_at`, `last_used_at`, `failure_count`, `disabled_at`.
  Owner-only policies for the app role; worker role SELECT and UPDATE/DELETE of `failure_count`,
  `last_used_at`, `disabled_at` and row deletion.
- `app.push_signing_key`: single-row table (`id` fixed), `public_key` (base64url),
  `private_key_ciphertext`, `created_at`. Readable by app and worker roles; insert only through
  the generate-once path, guarded by a unique constraint on the fixed id so two racing enables
  produce one key.

### 5.2 Server (notifications module, declared in its manifest)

- `GET /api/notifications/push/config`: returns `{ publicKey, enabledDevices: [...] }` for the
  actor. Generates the key pair on first call if none exists (one insert, conflict ignored, then
  re-read).
- `POST /api/notifications/push/subscriptions`: body is the browser's `PushSubscription` JSON.
  Upserts by endpoint. Returns the device row.
- `DELETE /api/notifications/push/subscriptions/:id`: owner-only delete. Also used by the
  client after `unsubscribe()`.
- `NotificationsRepository.create` enqueues `notifications.push.deliver` with
  `{ notificationId, recipientUserId }` when the row is new and `deferred_until` is null, and
  enqueues `notifications.push.summary` with `{ recipientUserId, releaseAt }` (singleton key
  `recipientUserId:releaseAt`, start-after = `releaseAt`) when it is deferred.
- Worker `notifications.push.deliver`: loads the notification inside the recipient's data
  context, builds the capped payload, sends to every non-disabled subscription of the recipient
  with the `web-push` library (VAPID `sub` = instance public URL from existing instance config,
  falling back to `mailto:` with no address exposed). 404 / 410 delete the row; other failures
  increment `failure_count`, and five in a row set `disabled_at`. A success resets the count.
- Worker `notifications.push.summary`: counts the recipient's unread notifications with
  `deferred_until` in `(releaseAt - quietHoursLength, releaseAt]` and sends one push
  "N notifications while you were away" with `href` = `/notifications`. Zero sends nothing.
- Nothing about a subscription (endpoint, keys) reaches logs, job payloads, exports or AI
  prompts. Exports skip the table.

### 5.3 Web

- `service-worker.js` gains `push` (show notification with title, body, and `data.href`) and
  `notificationclick` (focus an existing app window and navigate to `href`, else open one).
- Registration: `registerServiceWorker` registers on the dev server too, guarded so the fetch
  cache logic stays production-only, because push cannot be proven on dev otherwise.
- Notifications settings page (`NotificationSettings` in `settings-module-subviews.tsx`): the
  Push row replaces the `Coming soon · #743` badge with:
  - unsupported browser or insecure origin: a sentence saying push needs a secure address, no
    button;
  - permission denied: a sentence on how to allow it in the browser;
  - otherwise an "Enable on this device" button; once enabled, a list of the user's devices
    with label, added date and a Remove button; the current device marked "This device".
- App map: `notifications.push` setting entry and the `Coming soon` promise mapping removed.
- Design system: `jds-*` primitives only, no new colours in module CSS, run the invented-class
  audit.

### 5.4 Error handling

- Browser refuses (`Notification.permission === "denied"`): show the denied sentence, no retry
  loop.
- Subscription registration fails server-side: toast with the real reason, browser subscription
  is unsubscribed so the client and server do not disagree.
- Delivery: as in 5.2. A disabled row shows in the device list as "Not reachable, remove and
  enable again".
- Key pair missing at delivery time (should not happen): job fails with a logged reason that
  names no key material.

## 6. Testing

- Unit: payload builder (caps, first line only, href stays relative, no extra fields);
  subscription cleanup rules (404/410 delete, five failures disable, success resets);
  summary counting window.
- Integration: creating a notification enqueues the deliver job with a metadata-only payload;
  a deferred one enqueues the summary job with the right singleton key; RLS blocks another user
  from reading or deleting a subscription; export excludes the table.
- e2e: settings row states (unsupported, denied, enable, device list, remove) with the browser
  push API stubbed.
- Live-path gate on dev over `https://xbmx-1.tail284f31.ts.net:5443`, desktop Chrome and
  Firefox: enable, receive a real push from a News or briefing notification, tap it, land on the
  right screen, remove the device. Recorded on the PR.

## 7. Exit criteria (#743 acceptance, restated)

- [ ] Approved spec (this file) defines platforms, payload boundary, subscription lifecycle and
      abuse controls (rate: one push per notification, subscriptions capped at 10 per user).
- [ ] Push is not shown as an active toggle before the delivery worker ships (both land in one
      PR series; the settings row ships last).
- [ ] Users can enable, disable and remove push per device.
- [ ] Live proof on desktop Chrome and Firefox recorded on the PR.

## 8. Hard invariants honored

No admin bypass; owner-only rows; secrets (private key, subscription keys) encrypted at rest
and never in logs, payloads, exports or prompts; metadata-only job payloads; new SQL files in
the module's `sql/` folder; no new required env var; app map updated in the same PR;
provider-agnostic AI untouched.
