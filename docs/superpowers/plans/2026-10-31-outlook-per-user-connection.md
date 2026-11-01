# Outlook per-user connection: build plan

| Key                          | Value                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Issue                        | #3570 (task); mail follows in #3766                                                                                        |
| Design (approved 2026-10-22) | `docs/superpowers/specs/2026-10-22-outlook-user-setup-design.md`                                                           |
| Build spec                   | `docs/superpowers/specs/2026-10-22-outlook-user-setup-build.md`                                                            |
| Mockups                      | `docs/superpowers/mockups/outlook-user-setup/` (14 Settings-card states)                                                   |
| Progress record              | `docs/superpowers/plans/2026-10-22-outlook-user-setup-progress.md`                                                         |
| Foundation code              | draft PR #3571, branch `moss/outlook-user-setup-design` (16 commits ahead, 50 behind `main` at planning time)              |
| Merged base                  | operator-bound sync, PR #3568; spec `docs/superpowers/specs/2026-10-21-outlook-browser-calendar-sync.md`                   |
| In-flight fix                | PR #3934, branch `fix/outlook-settings-menu`: Settings button hidden under the "..." menu; adds state `settings-not-found` |
| Ruling                       | Ben, 2026-11-01: build now, so any Moss user can connect their own work calendar without IT approving an app               |

The design, build spec, mockups and progress record live on the #3571 branch today. This PR
brings them to `main` unchanged so lanes can build against them (plan and spec documents are
committed before any lane starts). Amendments this plan proposes are listed in section 9 and
need Ben's approval; the documents themselves are not edited here.

## 1. What ships first

- Any signed-in user on an installation whose operator ran the one-time host setup connects
  their own Outlook primary calendar from Settings → Connections.
- Each user signs in to Microsoft in their own managed browser, shown in a Moss sign-in window.
- Moss confirms the account, imports yesterday through the next 30 days, refreshes every five
  minutes, and removes events plus the saved session on disconnect.
- Release-1 scope is Linux x86_64 hosts with rootless Podman. That is narrower than "any
  installation", because the documented install path is Docker Compose only. Other hosts show
  the approved "browser unavailable" state with the operator remediation.
- Sign-in from a desktop browser (Chrome, Firefox, Safari). Phone sign-in follows later
  (decision D2).
- The legacy operator binding keeps working. Its owner switches by disconnecting it first.

## 2. Seams check

Cited against `main` at `5b6639222` unless marked "branch" (#3571 head `bb95e1c0e`).

| Capability                                               | Evidence                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Browser auth session resolution                          | `packages/auth/src/session-bindings.ts:21-30` (`resolveBrowser`, `assertLive`); impl `:69` rejects bearer headers, needs cookie |
| Route reads browser session id                           | `apps/api/src/companion-routes.ts:250-253`                                                                                      |
| Trusted-Origin check pattern to reuse                    | `apps/api/src/companion-routes.ts:158-175` (`requireTrustedOrigin`, 403 `invalid_origin`)                                       |
| Global CSRF / fetch-metadata middleware                  | **None.** Only per-route Origin checks (companion, recording, `external-module-tool-invoke.ts:99`)                              |
| Legacy Outlook routes                                    | `packages/connectors/src/outlook-calendar-routes.ts:59,70-71`; manifest routes `packages/connectors/src/manifest.ts:136-161`    |
| Legacy five-minute schedule (one owner)                  | `packages/connectors/src/outlook-calendar-jobs.ts:182-186` (`boss.schedule`, key `operator-binding`)                            |
| Pause after three incomplete attempts                    | `packages/connectors/src/outlook-calendar-jobs.ts:111`                                                                          |
| Worker-only scheduling                                   | `apps/worker/src/worker.ts:117-136`; registration `packages/module-registry/src/index.ts:2025`                                  |
| Collector account check (clicks Settings)                | `packages/connectors/src/outlook-calendar-browser.ts:63-79`; timeout maps to generic `partial` at `:438`                        |
| Collector connects over CDP to a loopback HTTP endpoint  | `packages/connectors/src/outlook-calendar-browser.ts:33-51,275`                                                                 |
| Source error codes and stages                            | `packages/connectors/src/outlook-calendar-source.ts:13-16`                                                                      |
| Shared status contract                                   | `packages/shared/src/outlook-calendar-api.ts:4-30`                                                                              |
| Calendar import (public)                                 | `packages/calendar/src/mirror-import.ts:76-140`                                                                                 |
| Remove all events for one connection                     | **None public.** Cascade exists: `packages/calendar/sql/0011_calendar_module.sql:3`                                             |
| Legacy disconnect only marks revoked                     | `packages/connectors/src/repository.ts:216-230`                                                                                 |
| Admin instance setting precedent                         | `packages/settings/src/web-search-key-routes.ts:52-114`; storage `app.instance_settings` (`web-search-key.ts:54`)               |
| App map entry for Connections                            | `packages/shared/src/app-map-core.ts:197-201`; connectors features/errors/remediation `manifest.ts:337-385`                     |
| Settings card                                            | `apps/web/src/calendar/outlook-calendar-status.tsx`; mounted at `apps/web/src/settings/settings-connections-pane.tsx:77`        |
| Prod install                                             | Docker Compose, `infra/docker-compose.prod.yml`; `README.md:77-110`; `docs/operations/deploy.md:5-7`                            |
| API and worker share one container and UID               | `infra/docker-compose.prod.yml:143`; `scripts/start-jarv1s.ts:72-81` (default UID 1000), `:199-200`                             |
| Browser sidecar precedent (socket in named volume)       | `infra/docker-compose.prod.yml:217,242-280` (sports browser)                                                                    |
| Lifecycle tables, leases, cleanup queue (branch)         | branch `packages/connectors/sql/0346_outlook_browser_lifecycle.sql`; `outlook-setup-repository.ts:39-269`                       |
| Lifecycle sweep, not scheduled (branch)                  | branch `packages/connectors/src/outlook-lifecycle-worker.ts:14`                                                                 |
| Unix lifecycle client, allocate/remove only (branch)     | branch `packages/connectors/src/outlook-lifecycle-client.ts:29-60`; `infra/outlook-browser/broker.py`                           |
| Browser frames / input / DevTools channel to a container | **None in product code.** Spike only: branch `spikes/outlook-browser-runtime/broker.py:67-78`; verifiers use `podman exec`      |
| Screen viewer in the web app                             | **None.** Closest: `apps/web/src/settings/terminal-modal.tsx:75` (WebSocket ticket)                                             |

Open questions, each owned by the slice named:

- Q1 (S1): does Microsoft accept a containerised Chromium sign-in from the server, and for how long does it stay signed in?
- Q2 (S1): does headless Chromium pass, or does it need a real display? See decision 3.3.
- Q3 (S2): which database role runs the branch's lifecycle sweep, and does the policy at branch `0346_...sql:56-59` amount to an RLS bypass for a runtime role? See section 5.
- Q4 (S5): what peer UID the broker should trust when the app container runs as the host's login UID. See section 3.2a.

## 3. Decisions

### 3.1 Where the managed browsers run

| Option                                           | What it is                                                                    | For                                                                                      | Against                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Host broker with rootless Podman (chosen)** | One service on the host, one container and volume per connection              | Built and tested on #3571; strongest boundary between users; no engine socket in the app | Needs a one-time host step; Docker-only installs cannot use it                                                                          |
| B. Compose sidecar                               | One `moss-outlook-browser` container, one OS account per connection inside it | Ships with plain Compose; works wherever Moss runs; sports browser is a precedent        | Users share a kernel namespace and network; the design forbids relying on profile folders alone; would discard the tested boundary work |

Steelman for B: it reaches every installation with no host step, and an OS account per
connection plus Chromium's own sandbox is a real boundary. It loses because per-connection
network control, the tested egress policy and crash recovery would all be rebuilt, and the
approved build spec already chose A. B stays the candidate for a later "Docker-only
installs" follow-up.

Two facts weaken A and stay visible. Docker Compose is the only documented install path, so A
reaches only operators willing to install Podman on the host. And the candidate runner
starts Chromium with `--disable-setuid-sandbox` (branch `infra/outlook-browser/image/runner.py:44`), so the browser's own sandbox inside a rootless
container is unproven on a production-like host. S1 checks the sandbox in the probe container;
S4 repeats the check at install.

### 3.2 How the worker drives a managed browser

| Option                                                       | For                                                                      | Against                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **A. Broker relays DevTools for a collector lease (chosen)** | Reuses the live-tested collector unchanged; one browser-reading codebase | Worker gets full browser control during a scan (it already has that on the legacy path)                      |
| B. Collector runs inside the browser container               | DevTools never leaves the container                                      | Node plus Playwright in the browser image; two packagings of one collector; event content crosses the broker |
| C. Rewrite collection in the Python broker                   | No Node in the host service                                              | Throws away proven reading logic                                                                             |

Chromium starts with `--remote-debugging-pipe` (no TCP listener at all). The runner bridges
that pipe to a Unix socket in the runtime's private folder, which only the broker opens. The
broker offers fixed frame/input/start operations to the API and a raw DevTools stream only
under a collector lease.

Playwright cannot attach to an existing browser over a pipe; `connectOverCDP` needs a
WebSocket URL. So for each scan the worker opens a loopback listener on a random port with a
random secret path, relays it to the broker stream, and closes it when the scan ends. The
endpoint validator (`outlook-calendar-browser.ts:33-51`) changes to accept that secret path.

- Exposure: every process in the app container shares its network namespace, so during a scan
  any of them that learns the port and path could drive the signed-in browser. The secret path
  and the scan-length lifetime narrow this; they do not remove it. S1 measures it and S3
  tests that a request without the secret path is refused.
- Lease exclusivity: one lease per connection, viewer or collector. A scheduled scan skips a
  connection whose viewer is open; the viewer shows "busy" while a scan runs and refuses input.
- The collector checks the page origin before reading identity, because the user controls
  where that browser has navigated.

### 3.2a Who may call the broker

API, worker and cli-runner run as one UID in the app container (`scripts/start-jarv1s.ts:72-81`,
`:190-200`). By default that UID is 1000, often the host's login account. The cli-runner hosts
AI-CLI and terminal sessions, so a peer-UID check alone trusts far too much.

- The installer creates a dedicated group with a fixed GID and gives the socket folder mode
  0750 with that group.
- `start-jarv1s.ts` spawns only the API and worker with that GID as their primary group.
  The cli-runner, conversation accounts and the host login user lack it.
- The broker checks peer UID **and** peer GID from `SO_PEERCRED`.
- `JARVIS_HOST_UID` does not change, so existing installs keep their data-volume ownership.
- This is a design, not a proven property. S4 and S5 each carry a control that must fail
  when the GID check is removed. If it cannot be made to hold, release 1 is limited to
  single-user hosts (decision D7).

### 3.3 Headless versus a real display

Start with the candidate's headless mode. Headless Chromium announces itself in its user
agent, and Microsoft may treat that as unusual. If S1 shows a refusal, switch to a headed
browser on a virtual display inside the same container. Never disguise the user agent; the
design forbids working around Microsoft's checks.

### 3.4 Enabling the runtime without a hand-edited settings file

- The socket folder has a fixed path inside the app container, `/run/moss-outlook`.
- Compose always mounts a host folder there. `scripts/setup-prod.ts` creates it for new
  installs. On an existing install that only pulls the new compose file, Docker creates it
  root-owned and empty. Moss then reports "absent" and starts normally; the host installer
  later takes ownership. S5 tests both paths.
- The installer writes a root-owned identity file into that folder naming the broker's UID
  and GID. Moss trusts only a socket matching it. Nothing is trusted on first use.
- An admin turns the runtime on in Settings → Oversight once health is "disabled" (socket
  present and matching).
- Limits: one live runtime per user, plus at most one being removed; an instance cap the admin
  sets on the same panel (default 10). Setup beyond the cap shows "unavailable".
- No new environment variable. No new required setting. Absent runtime means "unavailable".

### 3.5 Legacy binding

- Managed and legacy connections share the existing one-account-per-owner row
  (`0331_outlook_browser_calendar.sql`), so both can never be active for one owner.
- The legacy owner sees their legacy connection. To switch, they disconnect it, then connect
  the managed way. A matching source keeps its external IDs, so events update in place.
- No automated migration in release 1.

### 3.6 Layout drift pauses with a named step

- The collector is a fixed sequence of named steps: `open-settings`, `account-tab`,
  `identity`, `timezone`, `calendar-list`, `week-header`, `week-navigation`.
- Each step may try a short, reviewed list of ways to reach its control (for example the
  Settings button directly, then the "..." overflow menu from the in-flight fix).
- When every way fails, it throws `layout-changed` with that step. This is a pause, not one
  of the three transient retries. Settings shows the approved "could not read this calendar
  view" state; the step name goes to the status record and app-map remediation, never page
  text or addresses.
- `settings-not-found` from the in-flight fix becomes `layout-changed` with step
  `open-settings`. S7 starts after that fix merges and keeps its tests.

### 3.7 Disconnect removes events

The calendar module gains one public function. Connectors calls it; it never deletes calendar
rows itself.

```ts
// packages/calendar/src/mirror-import.ts (public export)
export function removeCalendarMirror(
  db: DataContextDb,
  input: { readonly connectorAccountId: string }
): Promise<{ readonly removed: number }>;
```

## 4. Merge blockers: what blocks release 1

| Progress-record blocker                               | Blocks release 1?          | Why                                                                                                                                                                    | Release-1 minimum                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session-bound viewer and API                          | **Yes**                    | Without it, any user could see or type into another user's work session                                                                                                | S6 with every negative control failing when its guard is removed                                                                                                                                                                                                                                                                                                  |
| Settings onboarding                                   | **Yes**                    | It is the product                                                                                                                                                      | S9                                                                                                                                                                                                                                                                                                                                                                |
| Lifecycle sweep scheduled                             | **Yes**                    | Abandoned setups and disconnects would leave signed-in profiles on disk forever                                                                                        | S5                                                                                                                                                                                                                                                                                                                                                                |
| Host ingress denial inputs delivered by the installer | **Yes, simplified**        | Private ranges are already refused; the gap is the host's own public addresses and Moss's public origin. A browser that can reach Moss's own front door is a real hole | S4 derives them from Moss's configured public origins plus discovered host addresses; S10 tests against the real deployment                                                                                                                                                                                                                                       |
| Maintained browser releases                           | **Yes, simplified**        | An unpatched browser holding a work session is the largest standing risk                                                                                               | S4 rebuilds the image from the pinned Alpine branch on every Moss update; `updateMoss` and the documented update path run the rebuild. An image older than the installed Moss release shows a named "browser image out of date" state with the operator remediation, pauses collection and keeps stored sessions. Published signed multi-arch images follow later |
| Full Chromium network acceptance                      | **Partly**                 | Redirects and address checks are proven; one DNS-rebinding case is cheap                                                                                               | S3 adds one rebinding test. Public IPv6 browsing: fail closed, follow-up                                                                                                                                                                                                                                                                                          |
| Hard-crash recovery                                   | **Partly**                 | Exhaustive crash injection inside Podman has no end                                                                                                                    | S4 adds a startup sweep that removes any Moss-labelled container or volume missing from the inventory. Deeper injection is follow-up                                                                                                                                                                                                                              |
| ARM64                                                 | **No**                     | No release-1 host needs it; an unproven sandbox must not ship                                                                                                          | S4 refuses to enable on any other architecture with a named reason                                                                                                                                                                                                                                                                                                |
| Moss auth inside the lifecycle service                | **No**                     | The API authorises the user and passes only server-resolved IDs; the broker cannot check a Moss session without sharing secrets                                        | S6 proves the API never forwards a client-chosen ID. Narrowing who may call the socket is S5 (see section 5)                                                                                                                                                                                                                                                      |
| Firefox and phone                                     | **Desktop yes, phone no**  | MFA prompts and on-screen keyboards on a remote browser need their own design                                                                                          | S10 proves desktop Firefox. Phone shows a "finish on a computer" message (D2)                                                                                                                                                                                                                                                                                     |
| Empty install, update, uninstall                      | **Install and update yes** | "Any user" means a fresh install must carry nothing of Ben's                                                                                                           | S10. Uninstall is a documented script, lightly tested                                                                                                                                                                                                                                                                                                             |

## 5. Security claims this plan could not verify from code

Treat each as false until a slice proves it with a guard-removal control.

1. **Only the API and worker can reach the broker.** The broker trusts one peer UID. In prod
   the app container runs as `JARVIS_HOST_UID`, default 1000 (`scripts/start-jarv1s.ts:72-81`),
   which on a typical host is also the human login account. Every process that account runs
   could then call the broker, including the cli-runner, which shares that UID. Section 3.2a
   sets the answer (a dedicated group for API and worker, peer UID plus GID check). S4 and S5
   prove it with guard-removal controls. Decision D7 covers the fallback.
2. **The lifecycle sweep runs without bypassing RLS.** Branch policy grants
   `jarvis_migration_owner` full access to the setup and cleanup tables. S2 must show which
   role the worker uses and that no runtime role gains a bypass. This question blocks PR A,
   which does not open for review until S2 answers it.
3. **Typed passwords and frames never reach logs.** Input bodies pass through Fastify. Nobody
   has checked request logging, error reporting or tracing for body capture. S6 proves it.
4. **Revocation stops the viewer promptly.** True only per request, and only if each frame and
   input request re-resolves the session. S6 tests a revoked session mid-stream.
5. **Profiles stay out of backups.** Podman volumes sit outside Moss's own backup, but host
   backups are unknown. The installer documents the exclusion; Moss does not claim it.
6. **The browser sandbox holds on the production host.** Proven on one native host only. S4
   checks Chromium's own sandbox diagnostics at install and refuses to enable if they fail.
7. **Legacy routes resist cross-site requests.** They have no Origin check. Same-site cookies
   probably cover them, but nobody has verified it. New routes carry the explicit check.

## 6. Determinism boundary

No AI model takes part in this feature. Every status, prompt and confirmation renders from the
setup and connection records. Model jobs: none. Nothing in chat changes.

## 7. Slices

Each slice fits one agent session and ends with its own verification. Dependencies flow
downward. Database commands always go through the `verify-gate` skill. No command is piped.

### S1. Real sign-in probe (riskiest; kill gate follows)

- Goal: answer Q1 and Q2 before building the product around them.
- Throwaway: nothing from this slice merges except a findings note.
- Run the candidate image on the dev host through the branch runtime. Serve the spike's
  frame/input viewer on a `devports` port, reachable only from Ben's own devices over the
  tailnet, with a one-time token. Never LAN-wide, never prod.
- Ben signs in to his work account and completes MFA in that viewer.
- Start Chromium with `--remote-debugging-pipe` and relay the pipe as a stream to the test
  side. Prove Playwright drives the merged collector over that relayed stream (decision 3.2).
  S3 builds on this mechanism, so it must work here first.
- Record Chromium's sandbox diagnostics inside the container (section 3.1).
- A user-level systemd timer runs the collector hourly for 7 days. It records pass/fail and
  error code only, never event content.
- If headless is refused, repeat with a headed browser on a virtual display (decision 3.3).
- Afterwards remove the container, profile volume, timer and port.
- Done when: a findings note records sign-in outcome, MFA method used, scan outcome over the
  relayed pipe, sandbox result, and the hour of the first failed scan (or none in 7 days).
- Depends on: nothing.

**Kill gate (owner: Ben).** The line continues only if all of these hold:

- Ben finishes sign-in and MFA through the viewer without his organisation blocking it.
- A full scan completes inside the container, driven over the relayed pipe.
- Chromium's sandbox reports active inside the container.
- Scans run 7 days with no re-sign-in. A re-sign-in between day 1 and day 7 is Ben's call. A
  re-sign-in inside the first day fails the gate.

A device-compliance or "unusual sign-in" block, or a security-key-only MFA requirement (a
remote browser cannot reach Ben's local key), stops the build and returns to design. One
organisation cannot prove the feature works for "any user". A pass shows it works for Ben's
employer; other organisations' sign-in policies stay the main residual risk, and S9's error
states must cover a blocked sign-in.

### S2. Bring the foundation onto `main`

- Rebase #3571 onto `main`. Renumber `0346_outlook_browser_lifecycle.sql` to the next free
  connectors number at build time (main already uses up to 0356). Nothing on #3571 was ever
  applied outside scratch databases; confirm the shared dev database has no row for 0346.
- Answer Q3. If the sweep needs a privileged role, route it through narrow security-definer
  functions owned by migration, called by the worker role.
- Depends on: nothing. The only slice that runs alongside S1.
- Verify (all exit 0):
  - `pnpm test:outlook-runtime > /tmp/s2-rt.log 2>&1; echo "EXIT=$?"`
  - `pnpm test:outlook-client > /tmp/s2-cl.log 2>&1; echo "EXIT=$?"`
  - `scripts/run-gate.sh start --gate test:integration:3570` through `verify-gate`
  - `pnpm verify:static > /tmp/s2-static.log 2>&1; echo "EXIT=$?"`

### S3. Browser control channel in the host service

- Runner starts Chromium with `--remote-debugging-pipe` and bridges it to
  `<runtime-dir>/devtools.sock`, broker-owned, mode 0600.
- Broker protocol gains fixed operations. Requests carry runtime ID, generation and lease ID
  only; the API resolves all three server-side.

```text
start      {runtime, generation}                 → ok        navigates to a fixed Outlook calendar URL constant
frame      {runtime, generation, lease}          → jpeg ≤ 512 KiB, 1280×800 max
input      {runtime, generation, lease, events}  → ok        ≤ 32 events: pointer, wheel, key, text ≤ 256 chars
devtools   {runtime, generation, lease}          → stream    collector leases only; closes on lease loss
```

- Add one DNS-rebinding egress test.
- Tests, each with a guard-removal control that must fail:
  - a `frame` for runtime B under runtime A's lease is refused (fails if the lease-to-runtime check is removed);
  - `devtools` under a viewer lease is refused (fails if the lease-kind check is removed);
  - `input` with 33 events or a 257-character text is refused (fails if the bounds are removed);
  - Chromium exposes no TCP DevTools listener (fails if the runner falls back to a port).
- Native proof: extend `verify_browser.py` to drive `start`, `frame` and `input` through the
  real broker with the candidate image. Exit 0.
- App map: none yet; S3 adds no user-visible state. The broker's refusals surface through S5's
  health states.
- Depends on: S1 kill gate passed, S2.

### S4. Host install, update and hardening

- `infra/outlook-browser/install.sh` (one command, run by the operator once):
  - checks Linux x86_64, rootless Podman, iproute2, user namespaces; refuses with a named reason;
  - creates the service account and folders, writes the trusted config;
  - derives ingress denial from Moss's configured public origins and host addresses;
  - builds the image from pinned inputs, runs Chromium's sandbox diagnostic, refuses on failure;
  - installs and starts the systemd unit.
- `updateMoss` and the documented update path rerun the image build. An image older than the
  installed Moss release reports "browser image out of date"; collection pauses and stored
  sessions stay.
- Startup orphan sweep removes Moss-labelled containers and volumes absent from the inventory.
- `infra/outlook-browser/uninstall.sh` removes unit, image, volumes and account.
- Docs: `docs/operations/outlook-browser.md` (install, update, uninstall, backup exclusion,
  what the trusted service can read).
- Tests: orphan sweep removes a planted labelled volume and leaves an unlabelled one (fails if
  the label check is removed); installer refuses on a faked non-x86_64 architecture.
- Native proof: install on the dev host into a disposable store, run `verify_browser.py`,
  uninstall, confirm nothing remains. Exit 0.
- App map: the "browser image out of date" and installer refusal reasons are added as errors
  with operator remediation in the connectors manifest.
- Depends on: S1 kill gate passed, S3.

### S5. App side: mount, admin switch, health, sweep

- Compose: dev and prod mount `./outlook-runtime:/run/moss-outlook` on `jarv1s` (and on `api`
  and `worker` in `infra/docker-compose.yml`). `scripts/setup-prod.ts` creates the folder.
  Dev-from-source reads the host folder directly.
- Resolve section 5 item 1 per section 3.2a. Test: a peer with the right UID but without the
  broker group is refused (fails if the GID check is removed).
- Admin setting, stored in `app.instance_settings`:

```ts
// packages/shared/src/outlook-runtime-api.ts
export type OutlookRuntimeHealth =
  | { readonly state: "absent" } // no socket in the folder
  | { readonly state: "unsupported"; readonly reason: "architecture" | "sandbox" | "shared-uid" }
  | { readonly state: "disabled" } // socket present, admin has not enabled
  | { readonly state: "ready" }
  | { readonly state: "unreachable" } // enabled, broker not answering
  | { readonly state: "image-out-of-date" };
// GET  /api/admin/settings/outlook-runtime → OutlookRuntimeHealth
// PUT  /api/admin/settings/outlook-runtime { enabled: boolean } → OutlookRuntimeHealth
```

- Worker registers `sweepOutlookBrowserLifecycle` on `*/1 * * * *` only while enabled.
- App map: Oversight entry for the switch, its states and remediation.
- Tests: Moss boots and serves Settings with an empty folder (proves no prod break); a non-admin
  PUT is refused (fails if the admin check is removed); sweep cleans an expired setup on a real
  database.
- Depends on: S2, S4.

### S6. Session-bound viewer API

- Routes under `/api/connectors/outlook-calendar`: `POST /setup`, `GET /setup`,
  `POST /setup/cancel`, `POST /viewer`, `GET /viewer/:id/frame`, `POST /viewer/:id/input`,
  `DELETE /viewer/:id`, declared in the connectors manifest.
- Every viewer request resolves `resolveBrowser`, checks trusted Origin and
  `Sec-Fetch-Site: same-origin`, then owner, generation and lease, immediately before the
  broker call and again before returning a frame.
- Frames: `Cache-Control: no-store`, never logged, never cached by the web client.
- Generic 404 for any ID the actor does not own.
- Negative controls, each observed failing with its guard removed: another user, an admin, no
  cookie, a revoked session mid-stream, a foreign Origin, a stale generation, a stolen viewer ID.
- Prove section 5 item 3 by sending a marker string as typed text and searching every log sink.
- Verify: `scripts/run-gate.sh start --gate test:integration:3570` exits 0 with the new cases.
- App map: the viewer's errors (not found, busy, session ended) with remediation in the
  connectors manifest.
- Depends on: S3, S5.

### S7. Identity, confirmation and collection through the runtime

- Starts after the in-flight Settings-menu fix (PR #3934) merges.
- Layout-drift steps per decision 3.6. Contract additions:

```ts
// packages/connectors/src/outlook-calendar-source.ts
export type OutlookLayoutStep =
  | "open-settings"
  | "account-tab"
  | "identity"
  | "timezone"
  | "calendar-list"
  | "week-header"
  | "week-navigation";
// OutlookCalendarSourceError.code gains "layout-changed"; .step?: OutlookLayoutStep
// packages/shared/src/outlook-calendar-api.ts
// OutlookCalendarState gains "layout-changed"; OutlookCalendarStatus gains layoutStep?: OutlookLayoutStep
```

- `collectOutlookCalendar` takes a browser handle instead of an endpoint, so the same code runs
  on the legacy endpoint and the managed DevTools stream.
- `POST /setup/confirm`: take an exclusive collector lease, re-read identity, bind the owner's
  connector account in one transaction, bump generation.
- Five-minute schedule fans out one job per active managed connection; payload holds IDs and
  generation only. Re-check generation and status before committing a scan.
- Real-Outlook regression of every step against Ben's signed-in Chrome on its claimed loopback
  debugging port, read-only, recording step outcomes only.
- Tests: a `layout-changed` failure pauses at once and does not count as a transient retry
  (fails if mapped back to `partial`); a scan finishing after generation bump commits nothing
  (fails if the re-check is removed); confirm with a changed identity binds nothing.
- App map: the "layout-changed" state with its step names and remediation.
- Depends on: S6, PR #3934 merged.

### S8. Disconnect, deletion and legacy coexistence

- `POST /disconnect` (managed): mark inactive, bump generation, revoke leases, call
  `removeCalendarMirror`, queue runtime removal. Show "removing" until the broker confirms.
- Account deletion runs the same path without the user signed in
  (`scripts/delete-user-data.ts`, already touched on the branch).
- Legacy owner keeps legacy behaviour; managed setup refused while their legacy row is active.
- Tests: disconnect during a running scan leaves zero events after the scan ends (fails if the
  generation check is removed); cleanup failure shows "session removal failed" and blocks a new
  setup; legacy disconnect then managed connect reuses the row and keeps external IDs.
- App map: the "removing" and "session removal failed" states and the legacy owner's switch
  path, with remediation.
- Depends on: S7.

### S9. Settings card and sign-in window

- Use the `design-system` skill. Build the 14 approved states in `outlook-calendar-status.tsx`
  from `@moss/ui` primitives, rendered from the status record only.
- New route `/settings/outlook-sign-in`: the sign-in window from mockups approved under D3.
  Polls frames at most twice a second while visible; stops on hide, lease loss or sign-out and
  clears the image.
- App map: every new state, the sign-in window, errors and remediation, in
  `packages/connectors/src/manifest.ts` and `app-map-core.ts`.
- Release note in the PR template.
- Playwright on a real dev instance: connect → sign-in window → confirm → first sync → disconnect,
  using a fixture Outlook page served inside the managed browser through the real broker.
- Depends on: S8, Ben's approval of the D3 mockups.

### S10. Live acceptance (gate before merge)

- Two ordinary users on one dev instance connect different fixture sources at the same time.
  Data, frames and events stay with their owner.
- Ben connects his real work calendar through the product on dev, confirms, sees events, and a
  background refresh lands. Desktop Firefox and one Chromium browser.
- Fresh install from the candidate image into empty storage on a second machine or VM. No
  profile, address, event or binding from the dev host. Update, then uninstall.
- Egress denies Moss's own public origin and the host's addresses from inside the browser.
- Record each proof on the PR. Without it the status is code-complete, unverified.
- Depends on: S9.

## 8. Packaging

- PR A, dark platform: S2–S5. No user-visible change while the admin switch is off; the
  Oversight switch is the only new screen. Mergeable after its gates and review.
- PR B, the feature: S6–S10. Merges only after S10's live proof.
- S1 produces a findings note, committed with PR A.
- #3571 is superseded by PR A once S2 lands; close it with a link.
- Reviews are cross-model. Repo is public: no hostnames, addresses, account names or event
  content in commits, receipts or PR text.

## 9. Decisions for Ben

- D1 release scope: Linux x86_64 hosts with rootless Podman that run the one-time host setup.
  Docker-only installs, which is the documented install path today, and ARM64 show
  "unavailable" for now.
- D2 phone: release 1 asks phone users to finish sign-in on a computer.
- D3 missing mockups, needed before S9:
  - the sign-in window and its states (loading, in use in another tab, idle timeout, denied);
  - the phone "finish on a computer" message;
  - the Oversight switch and its six health states;
  - the legacy owner's "disconnect the old connection first" note.
- D4 your own connection: stay on legacy, or disconnect and reconnect the managed way after S10.
- D5 the S1 probe needs about ten minutes of your time to sign in, then 7 days of waiting.
  You also decide whether a re-sign-in between day 1 and day 7 is acceptable.
- D6 the triage in section 4 amends the build spec's acceptance list (ARM64, phone, published
  images, exhaustive crash testing move to follow-up).
- D7 who may call the broker (section 3.2a): the plan gives the API and worker a dedicated
  group the cli-runner and login user lack. If that cannot be made to hold, release 1 is
  limited to single-user hosts. Approve the group approach and the fallback.

## 10. Rulings ledger

| Fact or decision                                                                 | Evidence                                                              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Live run fails at the account check: Settings sits under "..." in a real tenant  | collector `outlook-calendar-browser.ts:64`; fix PR #3934              |
| A missing control surfaces as generic `partial`, retried three times             | `outlook-calendar-browser.ts:438`; `outlook-calendar-jobs.ts:111`     |
| Candidate runner launches headless with a TCP DevTools port inside the container | branch `infra/outlook-browser/image/runner.py:44-50`                  |
| Broker exposes allocate and remove only                                          | branch `infra/outlook-browser/README.md` (protocol section)           |
| Branch migration number 0346 is taken on `main`                                  | `main` connectors/core migrations reach 0356                          |
| Legacy env binding appears in no compose or env example                          | grep of `infra/`, `.env*`, `env.production.example`                   |
| Inside the app container, loopback is the container itself                       | `infra/docker-compose.prod.yml:143` (single service, no host network) |
| Revoked accounts' events may stay readable (no status filter seen)               | `packages/calendar/src/repository.ts`; not checked beyond it          |
