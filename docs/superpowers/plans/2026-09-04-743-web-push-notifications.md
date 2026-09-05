# Implementation Plan: Web Push Notification Delivery (#743)

**Issue:** #2227 (Parent #743 / #1002)  
**Spec:** `docs/superpowers/specs/2026-09-04-743-web-push-notifications.md`  
**Author:** Antigravity  
**Date:** 2026-09-04

---

## 0. Process Gates

- [x] Approved design spec: `docs/superpowers/specs/2026-09-04-743-web-push-notifications.md` (approved by Ben, 2026-09-04).
- [x] GitHub task issue: #2227 ("Build: web push notification delivery (spec 2026-09-04-743)").
- [x] Front-end UI surfaces: notifications settings subview push device management and service worker notification events defined in spec 5.3.

---

## 1. Seams Check

Every capability this plan assumes exists is cited `file:line` from the current tree:

1. **AES-256-GCM Secret Cipher:**  
   `packages/db/src/secret-cipher.ts:63` (`JsonSecretCipher`) and `packages/db/src/keyring.ts:22` (`resolveKeyring`). Reuses `JARVIS_AI_SECRET_KEY` so no new env var is introduced.
2. **Metadata-Only Job Payload Validator:**  
   `packages/jobs/src/pg-boss.ts:88` (`ALLOWED_PAYLOAD_KEYS`) and `packages/jobs/src/pg-boss.ts:157` (`sendJob`). Enforces that push payloads contain only metadata keys.
3. **Actor-Scoped Worker Context:**  
   `packages/jobs/src/pg-boss.ts:343` (`registerDataContextWorker`) and `packages/jobs/src/pg-boss.ts:359` (`toAccessContext`). Binds the recipient's actor context via RLS.
4. **Notifications Data Model & Deferral Logic:**  
   `packages/notifications/src/repository.ts:184` (`NotificationsRepository`), `packages/notifications/src/repository.ts:63` (`QuietHoursPort`), `packages/notifications/src/repository.ts:120` (`computeDeferredUntil`).
5. **Notifications Routes & Serializer:**  
   `packages/notifications/src/routes.ts:25` (`registerNotificationsRoutes`) and `packages/notifications/src/routes.ts:108` (`serializeNotification`).
6. **Notifications Manifest:**  
   `packages/notifications/src/manifest.ts:42` (`notificationsModuleManifest`).
7. **Module Registry Workers & Queues:**  
   `packages/module-registry/src/index.ts:1562` (notifications queue and worker registration).
8. **Worker Runtime Job Registration:**  
   `apps/worker/src/worker.ts:369` (`NotificationsRepository` instantiation for module notifications).
9. **Notifications Settings UI:**  
   `apps/web/src/settings/settings-module-subviews.tsx:478` (`<Row name="Push" ... comingIssue={743} />`).
10. **Service Worker Script & Registration:**  
    `apps/web/public/service-worker.js:60` (`fetch` handler) and `apps/web/src/pwa/register-service-worker.ts:1` (`registerServiceWorker`).
11. **Coming Soon Promise Inventory Test:**  
    `tests/unit/coming-soon-inventory.test.ts:64` (asserts the `#743` coming soon promise).

---

## 2. Determinism Boundary

- Push delivery and summary notifications render strictly from database records (`app.notifications`), never from model output.
- No AI turns, prompt injections, or LLM summarizations are involved in push delivery.
- Model guidance word budget: 0 words (pure deterministic infrastructure).

---

## 3. Kill Gate

- **Kill gate trigger:** Inability of the browser service worker or web-push library to deliver RFC 8291 encrypted payloads on desktop Chrome or Firefox over HTTPS dev tunnel without native app shell dependencies.
- **Kill gate owner:** Ben.

---

## 4. Design Decisions & Technical Contracts

### 4.1 SQL Migration (`packages/notifications/sql/0223_push_notifications.sql`)

```sql
-- Migration 0223: Web push subscriptions and signing key (Issue #743 / #2227)

CREATE TABLE IF NOT EXISTS app.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  CONSTRAINT push_subscriptions_owner_endpoint_key UNIQUE (owner_user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_owner_user_id_idx
  ON app.push_subscriptions(owner_user_id);

CREATE TABLE IF NOT EXISTS app.push_signing_key (
  id text PRIMARY KEY CHECK (id = 'default'),
  public_key text NOT NULL,
  private_key_ciphertext jsonb NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.push_subscriptions TO jarvis_app_runtime;
GRANT SELECT, UPDATE, DELETE ON app.push_subscriptions TO jarvis_worker_runtime;

GRANT SELECT, INSERT ON app.push_signing_key TO jarvis_app_runtime;
GRANT SELECT ON app.push_signing_key TO jarvis_worker_runtime;

ALTER TABLE app.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_subscriptions FORCE ROW LEVEL SECURITY;

ALTER TABLE app.push_signing_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_signing_key FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select ON app.push_subscriptions;
CREATE POLICY push_subscriptions_select ON app.push_subscriptions
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_subscriptions_insert ON app.push_subscriptions;
CREATE POLICY push_subscriptions_insert ON app.push_subscriptions
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_subscriptions_update ON app.push_subscriptions;
CREATE POLICY push_subscriptions_update ON app.push_subscriptions
  FOR UPDATE TO jarvis_app_runtime, jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  )
  WITH CHECK (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_subscriptions_delete ON app.push_subscriptions;
CREATE POLICY push_subscriptions_delete ON app.push_subscriptions
  FOR DELETE TO jarvis_app_runtime, jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_signing_key_select ON app.push_signing_key;
CREATE POLICY push_signing_key_select ON app.push_signing_key
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (true);

DROP POLICY IF EXISTS push_signing_key_insert ON app.push_signing_key;
CREATE POLICY push_signing_key_insert ON app.push_signing_key
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (app.current_actor_user_id() IS NOT NULL);
```

### 4.2 Shared Contracts (`packages/shared/src/notifications-api.ts`)

```ts
export interface PushDeviceDto {
  readonly id: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly disabledAt: string | null;
  readonly endpointHash: string;
}

export interface PushConfigResponse {
  readonly publicKey: string;
  readonly enabledDevices: readonly PushDeviceDto[];
}

export interface RegisterPushSubscriptionRequest {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export interface RegisterPushSubscriptionResponse {
  readonly device: PushDeviceDto;
}

export interface DeletePushSubscriptionResponse {
  readonly success: boolean;
}
```

### 4.3 Payload Capping & Formatting (`packages/notifications/src/push-payload.ts`)

```ts
export interface WebPushNotificationPayload {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly href: string;
}

export function buildPushPayload(notification: {
  readonly id: string;
  readonly title: string;
  readonly body?: string | null;
  readonly href?: string | null;
}): WebPushNotificationPayload;
```

### 4.4 Push Crypto & Key Storage (`packages/notifications/src/push-crypto.ts`)

```ts
export class PushSigningCipher extends JsonSecretCipher {
  constructor(keyring: Keyring);
}

export function createPushSigningCipher(env?: NodeJS.ProcessEnv): PushSigningCipher;

export interface PushSigningKeyRecord {
  readonly id: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly subject: string;
  readonly createdAt: Date;
}

export async function getOrGeneratePushSigningKey(
  scopedDb: DataContextDb,
  cipher: PushSigningCipher,
  subject: string
): Promise<PushSigningKeyRecord>;
```

### 4.5 Queues and Jobs (`packages/jobs/src/pg-boss.ts` & `packages/notifications/src/push-jobs.ts`)

> Rebase note (2026-09-05): `createPushQueuePort` moved to `packages/jobs/src/push-jobs.ts`.
> `@moss/jobs` already depends on `@moss/notifications`, so the reverse import formed a package
> cycle (`check:package-deps`). The payload interfaces below stay in
> `packages/notifications/src/push-jobs.ts` and declare `actorUserId` directly instead of
> extending `ActorScopedJobPayload`; the shape is unchanged.

Added to `ALLOWED_PAYLOAD_KEYS` in `packages/jobs/src/pg-boss.ts`:

- `notificationId`
- `recipientUserId`
- `releaseAt`

Queues:

- `notifications.push.deliver`
- `notifications.push.summary`

Payload contracts:

```ts
export interface PushDeliverJobPayload extends ActorScopedJobPayload {
  readonly notificationId: string;
  readonly recipientUserId: string;
}

export interface PushSummaryJobPayload extends ActorScopedJobPayload {
  readonly recipientUserId: string;
  readonly releaseAt: string;
}
```

### 4.6 Enqueue Port in Repository (`packages/notifications/src/repository.ts`)

```ts
export interface PushQueuePort {
  enqueueDeliver(notificationId: string, recipientUserId: string): Promise<void>;
  enqueueSummary(recipientUserId: string, releaseAt: Date): Promise<void>;
}
```

### 4.7 Worker Handlers (`packages/notifications/src/push-worker.ts`)

- `runPushDeliverJob`:
  Loads notification inside recipient data context, retrieves non-disabled subscriptions, sends web push payload via `web-push`. 404/410 deletes row, 5 failures in a row sets `disabled_at`, success resets count.
- `runPushSummaryJob`:
  Counts unread deferred notifications in release window, sends summary push if count > 0.

### 4.8 Service Worker (`apps/web/public/service-worker.js` & `apps/web/src/pwa/register-service-worker.ts`)

- Register service worker in dev mode (`/service-worker.js?dev=1`).
- Fetch cache remains production-only (bypass caching if URL has `dev=1`).
- `push` event: calls `self.registration.showNotification(title, { body, data: { href }, icon: "/icons/icon.svg" })`.
- `notificationclick` event: focuses matching app window and navigates to `href`, or opens a window.

### 4.9 Settings View (`apps/web/src/settings/settings-module-subviews.tsx`)

Replaces the `Coming soon · #743` row with:

- Insecure origin or unsupported message when unavailable.
- Browser permission instructions when denied.
- "Enable on this device" button otherwise.
- List of registered devices with "This device" badge and Remove button.

### 4.10 Manifest & App Map

- Declare `settings: [{ id: "notifications.push", ... }]` in `notificationsModuleManifest`.
- Remove `#743` coming soon promise assertion from `tests/unit/coming-soon-inventory.test.ts`.

---

## 5. Tasks & Phasing

### Phase 1: Data Model, Secret Cipher & Shared API Schemas

- **Task 1:** Add SQL migration `packages/notifications/sql/0223_push_notifications.sql`. Update manifest database declarations and typescript types.
- **Task 2:** Add shared API schemas and DTOs in `packages/shared/src/notifications-api.ts`. Export in `packages/shared/src/index.ts`.
- **Task 3:** Add push secret cipher and key generator in `packages/notifications/src/push-crypto.ts`. Add unit tests in `tests/unit/push-crypto.test.ts`.

### Phase 2: Payload Capping, Repository Enqueue & Push Worker

- **Task 4:** Implement `buildPushPayload` in `packages/notifications/src/push-payload.ts` and unit tests in `tests/unit/push-payload.test.ts`.
- **Task 5:** Allow metadata keys in `packages/jobs/src/pg-boss.ts` (`notificationId`, `recipientUserId`, `releaseAt`). Implement `PushQueuePort` and integrate into `NotificationsRepository.create`.
- **Task 6:** Implement push workers in `packages/notifications/src/push-worker.ts` (deliver and summary). Add unit tests for subscription cleanup (404/410 delete, 5 failures disable, success reset) and summary window in `tests/unit/push-worker.test.ts`.
- **Task 7:** Register push routes (`GET /config`, `POST /subscriptions`, `DELETE /subscriptions/:id`) in `packages/notifications/src/routes.ts`. Register queues and workers in `packages/module-registry/src/index.ts` and `apps/worker/src/worker.ts`.

### Phase 3: Web Front-End, Service Worker & App Map

- **Task 8:** Update `apps/web/public/service-worker.js` with `push` and `notificationclick` listeners. Update `apps/web/src/pwa/register-service-worker.ts` to register in dev mode while bypassing fetch caching.
- **Task 9:** Implement push notification device management UI in `apps/web/src/settings/settings-module-subviews.tsx`.
- **Task 10:** Update `notificationsModuleManifest` settings declaration and update `tests/unit/coming-soon-inventory.test.ts`. Run `pnpm build:app-map`.
- **Task 11:** Run all quality gates and unit tests. Verify zero lint, typecheck, format, or design token violations.
