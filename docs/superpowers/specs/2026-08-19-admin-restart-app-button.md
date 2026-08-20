# Admin "Restart app" button

Date: 2026-08-19
Status: proposed
Owner: Ben (kill-gate decision), agent (build)

## Problem

Restarting the app after a config change, a stuck worker, or a module install currently means
Ben SSHing to the box and running a Docker command by hand. He asked for a button in Settings
that does the same thing.

## Ruling: the API never gets Docker access

The obvious implementation — mount `/var/run/docker.sock` into the app container and shell out
to `docker restart` — was rejected. The Docker socket is root-equivalent on the host: any code
execution inside the app container (a dependency compromise, an SSRF that reaches a local exec
path, a future module escape) would become full host root. That is a permanent, unbounded
increase in blast radius bought for one convenience button.

Instead the app **requests** a restart and a small host-side unit **performs** it. The app's
entire capability is "create a zero-byte file in one bind-mounted directory". Even fully
compromised, the worst it can do is restart itself in a loop — noisy, recoverable, not root.

This mirrors the existing Herdr install route (`docs/superpowers/specs/2026-07-15-993-host-truth.md`):
a fixed, argument-free action behind an admin check, where no request-derived value ever reaches
the executor.

## Ruling: app container only, never Postgres

Prod runs two long-lived containers: `moss` (api + web + worker in one image) and `postgres`.
The button restarts `moss` only. Postgres restarts are a database-downtime event with a different
risk profile and a different reason to happen; they stay a manual operation.

## Shape

### 1. Control directory (new bind mount)

`infra/docker-compose.prod.yml`, `moss` service, add:

```yaml
      - ./control:/data/control
```

`infra/control/.gitkeep` is committed so the directory exists on a fresh clone. The `setup`
service already bind-mounts `.:/deploy`, so a bind mount from `infra/` is an established
pattern in this file, not a new one.

### 2. Host unit (new, installed once)

`infra/host/jarv1s-restart.path` and `infra/host/jarv1s-restart.service` — a systemd path unit
watching `/…/infra/control/` for `restart-requested`, and a oneshot service that:

1. deletes the sentinel first (so a failed restart cannot re-trigger itself in a loop),
2. runs `docker restart moss`,
3. logs the outcome to the journal.

`infra/host/install-restart-unit.sh` installs and enables both, and is run once by the host
operator. It is **not** invoked by the app.

Without the unit installed, the button still writes the sentinel and the API still returns
`accepted: false` with reason `host-watcher-absent` — see the liveness check below. The feature
degrades to a no-op with an honest message, never to a silent lie.

### 3. Liveness check

The host unit touches `/…/infra/control/watcher-alive` every time it starts, and
`install-restart-unit.sh` touches it at install time. The API reads its mtime:

- file absent → `hostWatcherInstalled: false`; the button renders disabled with the one-line
  reason and the install command.
- present → button enabled.

This is a weak check (it proves the unit was installed, not that it is running right now), and
the spec says so rather than overselling it. The strong signal is the restart itself: the page
loses its connection and reconnects. If it does not, nothing happened.

### 4. API surface

`packages/settings/src/host-restart-routes.ts`, wired in `index.ts` alongside the existing host
routes.

```ts
export interface HostRestartDependencies {
  /** Absolute path to the bind-mounted control directory. Absent ⇒ route fails closed (503). */
  readonly controlDir: string;
}

export interface HostRestartStatus {
  readonly hostWatcherInstalled: boolean;
  readonly lastRequestedAt: string | null;
}

export function registerHostRestartRoutes(
  server: FastifyInstance,
  deps: HostRestartRoutesDependencies
): void;
```

- `GET /api/admin/host/restart` → `HostRestartStatus`. Admin only.
- `POST /api/admin/host/restart` → `{ accepted: boolean; reason?: "host-watcher-absent" }`.
  Admin only. Writes the sentinel. Takes no body — there is nothing for a caller to choose.

Contracts go in `packages/shared/settings-api.ts` next to `postHerdrInstallRouteSchema`.

Admin check reuses `assertAdminUser`, exactly as `host-install-routes.ts` does. The write to the
control directory happens **outside** any open database context, matching the 3-phase ordering
that spec 993 established (exec/filesystem I/O never inside a transaction). An audit event is
written after.

### 5. UI

Settings → the existing host/admin section that already holds the Herdr install control. One
`jds-*` button, no new primitives, no new colours. Copy:

- Label: **Restart app**
- Help line: "Restarts the app so it picks up new settings or modules. Takes about 20 seconds.
  Your data is not touched."
- On click: a confirm step (this drops every open session, including the one pressing it), then
  the button goes to a waiting state reading "Restarting — this page will reconnect."
- Disabled state when `hostWatcherInstalled` is false, with the reason and the install command.

Run the `design-system` skill's invented-class audit before opening the PR.

## Security notes

- The app can create exactly one filename in one directory. It cannot name a container, cannot
  pass an argument, cannot run a command.
- The host unit takes no input from the sentinel's contents — the file is zero bytes and the
  unit never reads it. There is no injection surface because there is no parsed value.
- Non-admins get the same 403 path as every other admin route; the button is not rendered for
  them and the route independently rejects them.
- Restart is disruptive but not destructive: no data is written, deleted, or migrated.

## Tests

Unit (`tests/unit/host-restart-routes.test.ts`):

1. **A non-admin POST is rejected and no sentinel is written.** Fails against an implementation
   that authorizes after touching the filesystem — the order matters, not just the status code.
2. **POST with the watcher absent returns `accepted: false` and still does not throw.** Fails
   against an implementation that reports success for a request nothing will act on.
3. **POST with the watcher present writes exactly `restart-requested` in the control dir.** Fails
   against an implementation that writes a caller-influenced filename.
4. **GET reports `hostWatcherInstalled: false` when the liveness file is missing.** Fails against
   an implementation that defaults to enabled, which would render an enabled button that does
   nothing.
5. **The route registers with no `controlDir` configured and answers 503.** Fails closed, matching
   the Herdr install port's absent-dependency behaviour.

Script (`tests/unit/restart-unit-script.test.ts`): the unit file deletes the sentinel before
running `docker restart`, asserted against the shipped unit text. Fails against a unit that
restarts first, which loops forever if the restart fails.

E2E: not a Playwright candidate — the assertion is "the server goes away", which kills the test's
own connection. Live-path proof instead: press the button on the dev box, record the journal line
and the container's new start time on the PR.

## Verification

```bash
pnpm verify:foundation > /tmp/vf.log 2>&1; echo "EXIT=$?"    # expect EXIT=0
```

Run under the `verify-gate` skill with an exported scoped `JARVIS_PGDATABASE`.

## Kill gate

If the host unit turns out to need per-deployment editing to work (paths, compose project name,
user), the feature is not worth it — a button that only works on one box is worse than the
command it replaces, because it looks general. Ben makes that call after the first live press.

## Out of scope

- Restarting Postgres or the whole stack.
- Pulling a new image, or any form of update-and-restart. That is a deploy, and deploys need
  their own spec.
- Restart from the assistant/chat. This is a Settings button pressed by a human.
