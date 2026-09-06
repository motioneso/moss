# Master key store: new secrets never break updates

Date: 2026-09-05. Decisions locked with Ben 2026-09-05 (admin generates keys in
Settings, Settings banner notification, all three existing families plus the rule).
Task: #2312.

## 1. Problem

Some secrets protect other secrets (the keys that encrypt stored credentials). Today
those key-encrypting keys live only in the env file and the server demands them at
startup. When a new one is added, anyone upgrading hits one of two bad outcomes:
their container fails at boot with a missing-key error, or they must hand-edit a
secrets file they were told never to touch. This already crash-looped a container
once (#918), and the current tree repeats the shape: the server builds the
integrations cipher eagerly at startup (`apps/api/src/server.ts:448`), so an env file
from before the new keys fails the next upgrade. The setup script refuses to touch an
existing file, so it cannot heal this either.

What Ben wants: new keys are announced in Admin settings, created there with one
action, stored encrypted, and a missing key degrades one feature instead of stopping
the app. Updates never break unless absolutely necessary.

## 2. Decisions (locked)

- One master secret stays the single required env value: the existing AI secret
  (`JARVIS_AI_SECRET_KEY`), which already encrypts the Brave search key. No new env
  value is added by this change, ever.
- The integrations, module-credential, and news keys move into the database as
  encrypted instance settings, locked with the master. Same envelope shape and
  registry guards the Brave key already uses.
- The admin creates each key in Settings (Generate button), rotates it there later.
- The admin is told through a Settings banner only. No feed notification.
- Standing rule: no future update may add a required env value. New secrets go
  through this store or the update does not ship.

## 3. Design

### 3.1 The store

Three new registry entries in `packages/settings/src/instance-settings-keys.ts`,
all `secret: true` so the generic list/upsert routes keep rejecting them (400) and
only dedicated encrypted routes touch them:

- `keys.integrations`
- `keys.module_credential`
- `keys.news_credential`

Each row holds an AES-256-GCM envelope of 32 random bytes, encrypted under the
master keyring. The envelope carries a key id, so rotation keeps old envelopes
readable through the existing retired-key path in `resolveKeyring`
(`packages/db/src/keyring.ts`).

No migration DDL is needed: `app.instance_settings` is key-value and already exists.

### 3.2 Loading (lazy, never at boot)

Today each cipher builds synchronously from env at startup. After this change each
family gets one async loader with this order:

1. Env value wins when set (existing installs keep working untouched).
2. Else the store row, decrypted with the master.
3. Else missing.

Loaders cache in memory and expose an invalidate hook called on save/rotate, mirroring
`invalidateWebSearchProviderCache` in `packages/web-research/src/providers.ts`.
Call sites change from boot-time construction to first-use loading; the eager
`createIntegrationsCipher(process.env)` in server startup is removed. Nothing in the
boot path throws for a missing family key again.

Signatures (new, in the settings package near the existing ciphers):

- `loadIntegrationsKeyring(scopedDb) -> Promise<Keyring>`
- `loadModuleCredentialKeyring(scopedDb) -> Promise<Keyring>`
- `loadNewsCredentialKeyring(scopedDb) -> Promise<Keyring>`
- `generateFamilyKey(scopedDb, input {family, actorUserId, requestId}) -> Promise<void>`
- `rotateFamilyKey(scopedDb, input {...}) -> Promise<void>`
- `getFamilyKeyStatus(scopedDb) -> Promise<{family, source: "env" | "store" | "missing"}[]>`

### 3.3 Missing means degraded, named per feature

- Integrations: chat tools backed by connections are unlisted; the integrations admin
  screen shows "needs attention" with a jump link.
- Module credentials: decrypt attempts fail with a setup-guidance error naming the
  Settings screen, never a crash or a raw keyring throw.
- News: credentialed publisher sources are skipped in refresh; the news settings show
  the same "needs attention" state.
- Status endpoints report presence only, never key material (the Brave-key status
  shape is the template).

### 3.4 Migration for existing installs

- Env set: nothing to do, env wins silently. A later Rotate in Settings moves the
  family into the store (env row left for the operator to remove; status shows
  `source` so they can see the move happened).
- Env missing: banner appears after upgrade; admin presses Generate per family.
- Fresh installs: setup keeps generating only the master plus connector keys it
  already owns; it stops writing the three family keys, so there is exactly one path.

### 3.5 Backup warning (must ship in the same change)

A database backup now holds the locked family keys. Restore needs the backup plus
the env file holding the master; either alone is useless. The deploy backup docs are
updated to say this in plain language.

## 4. Settings screens and app map

One new Admin screen, "Encryption keys", plus a banner slot on the Settings home.
Mockups below are the agreed look (plain boxes; final styling uses the authored
`jds-*` primitives and tokens, no new classes).

Settings home banner (only when something is missing):

```text
+----------------------------------------------------------+
| !  Encryption needs attention                [ Review ]  |
|    2 keys are not set up. Some features are paused.      |
+----------------------------------------------------------+
```

Keys screen:

```text
Encryption keys
Some features pause until their key is set up. Keys are locked
with your master secret and never shown here.

  Integrations connections      Ready (env file)      [ Rotate... ]
  Module credentials            Needs attention       [ Generate  ]
  News publisher keys           Ready (stored)        [ Rotate... ]
```

Screen states: loading shows skeleton rows; a failed status read shows the rows
greyed with "could not check, try again" and a retry button; Generate/Rotate
confirm inline and the acknowledgement renders from the saved record, never from
model output (no model is involved anywhere in this flow).

App map (same change, per the truthfulness rule): core settings gain the screen and
banner entries; each owning module manifest gains the "needs attention" error plus
the remediation pointing at the keys screen.

## 5. Failure handling

- Master missing in production: unchanged, boot refuses (it is the one required
  value, and setup always writes it).
- Store row corrupt: treated as missing for that family (degraded + banner), with a
  metadata-only log naming the family, never the material.
- Generate/rotate races: last write wins per key row; upsert is atomic.
- Downgrade: an older build ignores unknown `keys.*` rows, so rollback is safe.

## 6. Testing

- Unit: store round-trip encrypt/decrypt; env-wins ordering; missing row gives a
  missing status, never a throw; generic upsert rejects the three secret keys (400);
  rotation keeps envelopes written under the retired id readable; status payloads
  contain no key material (assert on serialized JSON).
- Integration: upgrade simulation — boot with an env file lacking all three keys:
  boot is green, status reports all missing, features degrade per section 3.3.
- Live path (merge gate): on a dev instance, remove a family key, confirm the banner
  and paused feature through the real UI, press Generate, confirm the feature
  resumes. Recorded on the PR with exit code and assertions.

Verify unpiped, expected exit 0:

```bash
npx vitest run tests/unit/settings-master-key-store.test.ts > /tmp/ks.log 2>&1; echo "EXIT=$?"
npx eslint packages/settings/src/master-key-store.ts --max-warnings=0 > /tmp/kslint.log 2>&1; echo "EXIT=$?"
```

## 7. Build slices (kill gate after slice 1)

- Slice 1: store + lazy loaders + banner + ONE migrated family (integrations) +
  the backup-doc update + README/docs update covering admin key generation
  (Ben 2026-09-05). Kill gate: upgrade simulation green and live proof recorded;
  Ben judges before slice 2 is planned in detail. Owner: whoever builds slice 1.
- Slice 2: remaining two families + setup stops writing the three keys.
- Slice 3: the standing no-new-required-env rule lands in the contributor checks
  (a test that fails when a reader demands a new env name outside the store).

## 8. Out of scope

- Moving the Brave key (already follows this pattern).
- Scheduled auto-rotation.
- Scoping keys per user (instance-wide, admin-only, like today).
- Changing what the master secret is.
