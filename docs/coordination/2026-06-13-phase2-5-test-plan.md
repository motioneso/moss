# Jarv1s Acceptance Test Plan — Phases 2–5

This is your hands-on acceptance pass for everything built in the last ~24 hours (Phases 2–5). The mindset for every step below is two simple questions:

> **"Is this the assistant I intended to use?"** and **"Can I run and deploy it myself?"**

Work through it as a first-time user and deployer would: become the owner, set yourself up, then exercise the daily-driver surfaces (tasks, briefings, calendar/email, chat), the agentic write path (focus-time), the module controls, household member onboarding, and finally the production deploy path. The plan is ordered as a natural walkthrough — each section builds on the last.

Be skeptical. Where a step says "Expected," that's the pass condition. Where there's an "edge cases / poke at" note, try to break it. This run was grounded on `phase2-portable-deploy` @ `e2e0c55` (= `main`), after the 2026-06-13 branch-review triage fixes landed.

---

## Product lens — what "good" means

Don't just ask "do the features function?" Ask "is this the chief of staff I described?" The direction (from `docs/brand/product-goals-and-ideals.md`) is:

- **A preparedness-centered, single-user-at-core chief of staff** — not a wellness app, not an ADHD-recovery app, not a chatbot, not a smart calendar. Each user gets their own private assistant, context, goals, and briefing.
- **The day is the primary unit; the week is the horizon; life direction is the compass.** Jarvis should help you see what matters today and what must move this week.
- **Confidently directive, yet inspectable and overridable.** Jarvis should come with a point of view, not a neutral dashboard — but you can always see why and change it. It is not a yes-man and not paternalistic.
- **Instruments over conversation.** The Task list is the action surface; signals and views beat chat-as-UI.
- **Auto-create Tasks only for explicit/clear commitments** ("send the deck by Friday," "I'll call the mechanic"), never soft possibilities ("would be great to see the deck sometime"). Jarvis-created Tasks look identical to manual ones except for provenance.
- **Wellness is an OPTIONAL module** — first-class when enabled, completely silent when not.
- **Autonomy is granted, not assumed** — per-module read/create/update/delete data access, with a hard write→confirm floor for external actions (calendar writes, anything user-visible).

**Honest framing:** much of the product vision above is the **DIRECTION**, not what v1 ships. Evening-**interview** briefings (vs. today's read-only report), advisor personas, the "what Jarvis knows about me" user-model, usage-appetite/cost controls, granular per-module CRUD permission UIs, live surgically-patched briefings, and learned preparation checklists are **not in this build**. v1 ships the **functional spine**: tasks + recurrence + drift views, scheduled/run-now briefings with grounded synthesis, real Google calendar/email sync + triage, live CLI chat with an MCP write-confirm gateway, focus-time write-with-confirm, module enablement, and multi-user onboarding/RLS. As you test, evaluate the spine **against** that direction: does the foundation feel like it's growing toward the chief of staff, or toward a generic productivity app?

---

## Before you start

**The instance is already live and running.** You don't need to set anything up to begin.

- **Web shell:** http://192.168.x.x:5173 (Vite, started with `--host` for LAN access)
- **API:** port 3000 — the web shell proxies `/api` → :3000
- **Worker:** running, with pg-boss cron active (briefings, recurrence, and sync jobs need it)
- **DB:** `jarv1s` is freshly migrated with **0 users**, so **onboarding fires right now**. The first account you create becomes the bootstrap owner.

- [ ] Confirm the clean slate before you sign up: `curl http://192.168.x.x:5173/api/bootstrap/status` returns `{ "needsBootstrap": true }`. (Already verified green at the time this plan was written.)

**To restart the stack later** (separate processes):

```
pnpm db:up          # if Postgres isn't already up
pnpm dev:api        # Fastify API on :3000
pnpm dev:worker     # pg-boss worker (must be its own process)
pnpm dev:web        # Vite shell on :5173 (--host for LAN)
```

**To get another clean slate** (re-fire onboarding): drop+recreate the `jarv1s` database — or `pnpm db:reset` — then `pnpm db:migrate`. After that, `GET /api/bootstrap/status` returns `{ needsBootstrap: true }` again.

---

## 1. First-run, bootstrap & auth

_What it is: first-run instance bootstrap (the first user becomes owner/admin), email/password auth via Better Auth, and the registration/approval gate for everyone after._

### 1a. Bootstrap the owner

**Try this:**

- [ ] Navigate to http://192.168.x.x:5173 on the fresh DB. **Expected:** AuthScreen shows a "Create owner account" heading with **no** Sign in / Create account toggle (because no users exist).
- [ ] Submit the sign-up form (name, email, password). **Expected:** a session cookie is set — check DevTools → Application → Cookies for the `better-auth` token; confirm it is **HttpOnly** (not readable from JS).
- [ ] Call `GET /api/me` with your cookie. **Expected:** `{ user: { isBootstrapOwner: true, isInstanceAdmin: true, status: "active" } }`.
- [ ] Re-check `GET /api/bootstrap/status` (no auth). **Expected:** now `{ needsBootstrap: false }`.
- [ ] `GET /api/admin/audit-events`. **Expected:** an event with `action='bootstrap_owner_created'` where the owner's id is both actor and target.

**Edge cases / poke at:** Open a fresh tab with no cookie — you should now get the **Sign in / Create account** form, not "Create owner account." You should immediately be able to hit admin APIs (`/api/admin/users`, `/api/admin/registration`).

### 1b. Registration gate + approval workflow

**Try this:**

- [ ] As a second user, sign up (`second@example.com`). **Expected:** account created with `status='pending'` (default is approval-required).
- [ ] As that pending user, call `GET /api/me`. **Expected:** `403` with `error.code='account_pending_approval'`; the web shell shows the **PendingApprovalScreen** (no sign-out button — they must wait for admin action).
- [ ] As owner, go to Settings → Admin Users → Pending Approvals. **Expected:** the pending user appears by name + email. Click **Approve**. **Expected:** `user.status='active'`; an audit event `action='user.approve'`.
- [ ] Pending user reloads. **Expected:** they enter the app (may need a fresh tab/session refresh).
- [ ] In the Registration panel, toggle **Allow new registrations OFF**, then attempt a new sign-up. **Expected:** `403` with `code='registration_disabled'`.
- [ ] Toggle registrations **ON** and **Require admin approval OFF**; sign up a new user. **Expected:** `status='active'` immediately, no approval needed.
- [ ] Test **Reject**: a new user signs up pending; admin clicks **Reject**. **Expected:** user is deleted (gone from the list); their data cascade-deletes — re-register the same email and confirm no old tasks reappear.

**Edge cases / poke at:** Confirm only `registration.enabled` and `registration.requires_approval` are readable pre-auth — no other setting should leak before a session exists.

### 1c. Deactivate / reactivate / promote / demote / delete

**Try this:**

- [ ] Deactivate an active member (Admin Users → row → Deactivate). **Expected:** `status='deactivated'`; their session is revoked; on reload they hit the **DeactivatedScreen** ("contact your administrator"). Audit: `action='user.deactivate'`.
- [ ] Reactivate them. **Expected:** access restored; audit `action='user.reactivate'`.
- [ ] Try to deactivate the **bootstrap owner**. **Expected:** error "The bootstrap owner cannot be deactivated."
- [ ] Try to deactivate **yourself**. **Expected:** `422` "You cannot deactivate your own account."
- [ ] Promote a member to admin. **Expected:** `isInstanceAdmin=true`; they now see the Admin Users panel.
- [ ] Try to demote the **last** active admin. **Expected:** `409` last-admin error. Promote a second admin first, then the demotion succeeds.
- [ ] Delete a pending user and a non-admin active member. **Expected:** rows gone + their data gone. Deleting the bootstrap owner → `409`; deleting yourself → `422`.

**Edge cases / poke at:** As a non-admin, call `PATCH /api/admin/users/:id/promote` on your **own** id directly via API. **Expected:** blocked (`403`/`422`) — the `0053`/`0055` DB triggers prevent self-escalation, not just the route.

### 1d. Sessions, OAuth list, blocking screens

**Try this:**

- [ ] Delete your cookie in DevTools, call `GET /api/me`. **Expected:** `401` "Session is missing or expired" (NOT a pending/deactivated screen — a plain sign-in form).
- [ ] (Headless) Use a session id as `Authorization: Bearer <token>` against `/api/tasks`. **Expected:** works. Then expire it in the DB (`UPDATE better_auth_sessions SET expires_at = now() - interval '1 hour'`) → `401`.
- [ ] `GET /api/admin/auth/providers` as admin. **Expected:** lists email-password/google/github/microsoft with `displayName`, `id`, `enabled` — and **no** `clientSecret`/`access_token`/`refresh_token` anywhere. Non-admin → `403`.

---

## 2. Primary-user onboarding wizard (the founder flow)

_What it is: a skippable, resumable wizard that gates the app shell for the bootstrap owner — welcome → multiplexer → CLI auth → connectors — with an optional "Ask Jarvis" overlay._

**Product lens:** this is "can I run it myself?" made concrete. The wizard should make a non-trivial self-hosted setup (multiplexer + CLI subscription + Google) feel guided, not like reading the README.

**Try this:**

- [ ] As the freshly-bootstrapped owner, land on http://192.168.x.x:5173. **Expected:** header "Set up Jarv1s" + step counter ("Step 1 of 4"). The shell does NOT render behind it.
- [ ] **Welcome step:** confirm the intro + a top-level "Skip setup" button. (Don't skip yet.)
- [ ] **Multiplexer step:** see install instructions (apt tmux / herdr install). Click **Re-check**. **Expected:** `tmuxUsable`/`herdrUsable` booleans update within ~2s. If neither is usable, the selection buttons are disabled. Install tmux on the host, Re-check, then click **Use tmux**. **Expected:** a `PUT /api/admin/chat-multiplexer {multiplexer:'tmux'}` fires; `steps.multiplexer.done=true`, `selected:'tmux'`.
- [ ] **CLI auth step:** each provider (Claude/Codex/Gemini) shows "detected" or "not detected." Run `claude login` (or equiv) on the host, click **Re-check**. **Expected:** it flips to detected; `steps.cliAuth.done=true` once any one is present. Note: Next is **not** hard-gated even if none detected.
- [ ] **Connectors step:** ConnectGooglePanel renders; you can connect Google or **Skip this step**. **Expected:** if an account exists, `steps.connectors.done=true`.
- [ ] **Optional overlay:** the "Ask Jarvis" button is disabled until `multiplexer.done && a CLI is present`. Once both hold, click it. **Expected:** a ChatDrawer opens and streams.
- [ ] **Resumability:** complete the multiplexer step, close the tab, reopen `/`. **Expected:** the wizard resumes at **CLI auth** (the first incomplete step), not at Welcome.
- [ ] **Finish** on the last step. **Expected:** `POST /api/onboarding/complete`, shell renders. `GET /api/admin/audit-events` shows exactly one `action='onboarding.complete'` (multiplexer is audited separately as `instance_setting.upsert`, not double-counted).

**Edge cases / poke at:**

- [ ] Skip setup at any point → `POST /api/onboarding/skip`, state becomes `skipped`, shell renders.
- [ ] **Timeout safety:** if `GET /api/onboarding/status` hangs (>4s), the client times out and the **shell renders anyway** — you are never trapped on a spinner.
- [ ] **No-secret check:** inspect the `/api/onboarding/status` response — CLI detection is presence-only; assert no `token`/`secret`/`password`/`credential` fields appear.

---

## 3. Tasks — the daily-driver action surface

_What it is: personal task management with hierarchy/breakdown, tags, lists, Eisenhower + priority views, daily roll-forward recurrence, and drift-detection focus views._

**Product lens:** Tasks are the heart of the chief of staff — the single action surface. v1 has the spine (priority you own, a derived focus/drift signal, one-level breakdown). The direction adds Jarvis-created tasks with provenance and an evening rollup; not in this build, so don't expect auto-capture from chat/email yet beyond the explicit chat tool path (Section 6).

### 3a. Create, edit, complete

**Try this:**

- [ ] At `/tasks`, add "Fix bug #42." **Expected:** appears with `todo` status.
- [ ] Via API, `POST /api/tasks {title, priority:4, dueAt, effort:'quick', recurrence:{freq:'daily',interval:1}}`. **Expected:** task created with a `series_id` and `occurrence_date` in the recurrence JSONB.
- [ ] Open detail page; edit title/priority/dates/effort/list; Save. **Expected:** atomic update; moving to a new list **drops tags foreign to that list**.
- [ ] Toggle a task done via the circle icon. **Expected:** strikethrough, `completedAt` set; reopen clears it. Complete all children of a parent → parent auto-closes with an activity entry.

**Edge cases / poke at:** empty title → 400; priority out of 1..5 → 400; invalid ISO date → 400; creating a task for a list you don't own → 404.

### 3b. Recurrence roll-forward

**Try this:**

- [ ] Create a weekly task with `occurrence_date` 21 days ago; do NOT complete it. Visit `/tasks`. **Expected:** it shows with **today's** date (lazy-on-view roll-forward), and only **one** live row exists — no stacking into N rows.
- [ ] Complete an old recurring instance. **Expected:** the next instance spawns at the next occurrence ≥ today; due/do dates shift by the same delta; not double-counted.

**Edge cases / poke at:** Jan 31 monthly rolls to Feb 28/29 (end-of-month clamp), not Mar 3. A manage-shared task owned by someone else is **not** rolled by you (owner-only predicate).

### 3c. Lists, tags, breakdown

**Try this:**

- [ ] Create a list "Work"; rename it; try to delete a non-empty list → `409`; delete your only list → `409`; delete with `?reassignToListId=` → tasks move + foreign tags dropped.
- [ ] Create a tag "urgent" scoped to a list; assign it on the detail page (chip with X); rename it; delete it → chips cascade-disappear. List-view chips are read-only; detail-page chips are removable.
- [ ] `POST /api/tasks/:id/breakdown {steps:['Fix auth','Write tests','Deploy']}`. **Expected:** ordered child tasks in the parent's list; a `broken_down` activity. **Grandchild** breakdown is rejected by DB trigger (one level only).

### 3d. Views + focus

**Try this:**

- [ ] Toggle **Priority** ↔ **Matrix**; reload — the preference persists.
- [ ] Place a priority-5 / due-12h task → **Do First**; priority-5 / due-7d → **Schedule**; priority-1 / due-1d → **Delegate**; priority-1 / due-30d → **Later**.
- [ ] `GET /api/tasks/focus`. **Expected:** union of overdue + at-risk, deduped, ordered priority↓ then due↑ then quick-effort first. A low readiness signal (e.g., from wellness energy) caps the list to ≤3.
- [ ] `GET /api/tasks/at-risk` (priority≥3, imminent, no completed child) and `GET /api/tasks/overdue` (todo + past due). Complete a child of an at-risk parent → it drops out of at-risk.

**Edge cases / poke at:** `?quadrant=do` and `?tagId=X` compose with status filters (AND logic); a non-existent `tagId` returns `200` empty, not 404.

---

## 4. Briefings — scheduled cron + grounded synthesis

_What it is: a personal daily briefing that synthesizes commitments/tasks/calendar/email/vault/chat into an LLM summary, on a per-definition cron or run-now, degrading gracefully._

**Product lens:** the direction is an **interactive evening interview + a reconciling morning brief** that stays live and surgically patched all day. v1 ships the grounded **read-only report** with run-now + daily cron and graceful degradation — the synthesis engine, not the conversation. Judge the synthesis quality and the "what matters + why" framing against that direction; the interview/live-patching layers are explicitly deferred (see Deferred).

**Try this:**

- [ ] At `/briefings`, click "Create briefing": title, cadence **daily**, select read tools (e.g. `tasks.list`, `commitments.listVisible`). **Expected:** `201`; definition appears in the sidebar.
- [ ] Try to select a write-risk tool (e.g. `tasks.create`). **Expected:** `400` "can only select declared read-risk assistant tools."
- [ ] Select a definition, click **Run briefing**. **Expected:** `202` with `jobId`+`runId`, "Queued <runId>." Within a few seconds a run appears with `status='succeeded'`, `runKind='manual'`, and a synthesized `summaryText`.
- [ ] Inspect a run's `sourceMetadata`. **Expected:** counts per source, `aiModel`, `gaps[]`, and `degraded` flag.
- [ ] **Degraded path:** remove the AI provider, run again. **Expected:** still `status='succeeded'` but `degraded=true`, `degradedReason='no_model'`, and `summaryText` is a plain enumeration (section label + count + items), not prose.
- [ ] Edit a definition's cadence daily→manual and back. **Expected:** the pg-boss schedule row (keyed on definition id) is removed then re-created; the mutation always succeeds even if reconcile fails (failure-isolated).

**Edge cases / poke at:** double-click Run with the web idempotency key → second is `409` (already queued/running). A blocked run (non-read tool) is `status='blocked'`, `blockedReason='non_read_tool'`, no synthesis. Scheduled runs are idempotent per local calendar day (same-day re-fire returns the existing run, fires only one "Your morning briefing is ready" notification).

---

## 5. Connectors + Calendar + Email (Google sync & triage)

_What it is: on-demand/on-connect Google Calendar + Gmail sync, cached with LLM summaries and structured signals — and notably, raw email bodies are never persisted._

**Post-review note:** the sync-isolation defect (one big transaction silently rolling back the whole sync on one bad event) and the email-summary body-leak gap flagged in the branch review were **fixed** — the steps below now say "verify it behaves correctly," not "watch it break."

**Try this:**

- [ ] Settings → Connectors: enter a Google OAuth client id/secret, click "Start authorization," approve scopes, paste the redirect URL back, "Finish connecting." **Expected:** `201`, account `status='active'`, scopes include gmail.modify + calendar; sync-on-connect auto-enqueues.
- [ ] Create a Google Calendar event tomorrow; click **Sync now** on the Email page (or wait for on-connect). Visit `/calendar`. **Expected:** the event appears grouped by day with time + location. Rename it in Google, re-sync → updates in place, **no duplicate** (idempotent on externalId).
- [ ] Send yourself an email "Bill reminder: $50 due June 20" with a clear body. Sync. Visit `/email`. **Expected:** sender + subject + an LLM summary + a "Bills due" signal; importance badge; confidence percent.
- [ ] **Dedup of sync:** click Sync now twice rapidly. **Expected:** first `{enqueued:true, deduped:false, jobId}`, second `{enqueued:false, deduped:true, jobId:null}` — both HTTP `202`.

**Edge cases / poke at:**

- [ ] **Sync isolation (fixed — verify):** put a "messy" event in Google (e.g. an all-day event, or one with an odd/absent time) alongside several normal events and a couple of emails, then sync. **Expected:** the normal events and emails **all persist**; one bad item does NOT discard the whole sync, and the reported `calendarUpserted`/`emailUpserted` counts match what actually landed (no fabricated success).
- [ ] **Email body privacy (critical):** query the DB for the synced message — `SELECT body, body_full FROM app.email_messages ...`. **Expected:** no raw body column exists / all null. Inspect both `/api/email/messages` JSON **and the stored `summary`/`signals`** for your secret payload string — it must not appear anywhere (the summary echo-guard, including wrapper-prefixed leaks, was tightened this round).
- [ ] **Scope guard:** an account with only the calendar scope cannot write email rows (INSERT policy rejects).
- [ ] **Partial failure is a win:** revoke the token, sync → `auth-error`, empty pages, no red crash. Bad LLM key → calendar/email rows still populate, summaries null.
- [ ] **Rate limit:** 7 sync requests in 60s → 7th is `429`.

---

## 6. Chat / Jarvis — live drawer, CLI engine, MCP gateway

_What it is: an SSE-streamed chat drawer driving an in-process CLI engine (Claude/Codex/Gemini) over tmux/herdr, with an MCP gateway that gates tool calls behind human approval for writes._

**Product lens:** chat is a surface, not the product. The default persona is your chief of staff; the MCP gateway enforces "autonomy is granted, not assumed" by making every write tool stop for your approval. Judge whether reads flow freely and writes always pause.

**Try this:**

- [ ] Open the chat drawer, send "Hello, what is 2+2?" **Expected:** your message + a streamed, context-aware reply (watch `/api/chat/stream` SSE in the Network tab).
- [ ] Open a second tab as the same user. **Expected:** both tabs show the transcript in sync, in real time.
- [ ] Click **New chat** → transcript clears, prior conversation saved to `/api/chat/threads`. Click **Temporary** (incognito), send a message, start a normal chat and ask "do you remember the incognito message?" **Expected:** it does not.
- [ ] **Recall:** in chat 1 say "I'm learning Welsh." New chat, ask "what language am I learning?" **Expected:** it recalls Welsh. Open the Memory panel, turn **Recall** off, new chat, ask again → no context.
- [ ] **Provider switch:** send a turn, change the active provider in Settings, return to the drawer. **Expected:** transcript preserved, prior turns replayed as seed; new turns processed by the new provider.
- [ ] **Tool approval:** ask it to "create a task: Buy milk." **Expected:** an ActionRequestCard with the tool name + summary and Approve/Deny. Approve → executes + `action_result`. Repeat and Deny → rejected, assistant notified.

**Edge cases / poke at:**

- [ ] Empty message → form error. Concurrent turn → `409` "turn in progress." No model configured → `400` sanitized "No active chat-capable model." Multiplexer missing → `503` "Live chat is currently unavailable."
- [ ] Inspect the tmux session on host: `tmux list-sessions | grep jarv1s` — **one** session per user; messages paste into the same session; killed after ~30 min idle.
- [ ] MCP allowlist: capture the Bearer token from `/api/mcp`, try a `tools/call` for a tool you lack permission for → "Tool not in session allowlist." Rate limit: 121 `tools/list` calls → 121st rejected.
- [ ] Error sanitization: trigger a failure → user sees a generic message; full detail only in server logs (no stack traces/secrets to the client).

---

## 7. Focus-time agency — calendar write-with-confirm

_What it is: the assistant proposes and inserts focus blocks on your Google Calendar, conflict-checked live via freeBusy, gated by the mandatory write→confirm floor._

**Product lens:** this is the cleanest example of the autonomy model — an externally-visible write that **must** stop for confirm, conflict-checked against your real calendar (which is a hard constraint), idempotent on retry. It is the template every future external action should follow.

**Post-review note:** the freeBusy double-booking defect (a per-calendar Google error being treated as "fully free") was **fixed** to fail closed — the conflict steps below now verify correct behavior.

**Try this:**

- [ ] In chat, ask "Schedule 2 hours of focus time tomorrow morning." **Expected:** within ~2s an ActionRequestCard with a clear summary ("Block 'Focus time' Wed, 09:00–11:00") + Approve/Deny.
- [ ] **Deny it.** **Expected:** no Google event created. **Let one time out (>150s).** **Expected:** cancelled, no write. **Approve one within the window.** **Expected:** `created:true`, a real Google event appears.
- [ ] Open the created event in Google. **Expected:** correct title/time, and `extendedProperties` show `jarvisCreated=true`, `jarvisTool=proposeFocusBlock`.
- [ ] **Conflict shift (fixed — verify):** put a 09:30–10:00 meeting tomorrow, request a 2h morning block, approve. **Expected:** `shifted:true`, `resolvedStart=10:00`. Fully book the morning → `conflict:'no-clear-slot'`, `created:false`, friendly message — and critically, **no block written over the real meeting**.
- [ ] **Idempotency:** approve the exact same proposal twice (no reload). **Expected:** same `googleEventId`, and Google shows exactly **one** event.

**Edge cases / poke at:** an account lacking the calendar scope → `created:false` with a reconnect message (Google's 403 is the second-line defense). Google API / freeBusy failures now **fail closed** — you get "Couldn't check your calendar availability — try again." with **no** event written and **no** status codes/bodies leaked to the client. Cross-user: User A and User B each get events only on their own calendars.

---

## 8. Module enablement — admin + per-user disable

_What it is: a deny-list mechanism letting admins disable modules instance-wide and users self-disable optional modules, with nav + routes + tools all respecting the state._

**Post-review note:** the OPTIONS/CORS preflight gap (the route guard 404ing OPTIONS, which would bite the moment cross-origin/containerized topology lands) was **fixed** — preflight short-circuits the guard.

**Try this:**

- [ ] As admin, `GET /api/admin/modules`. **Expected:** ≥11 modules, each with `required`/`supportsUserDisable`/`instanceDisabled`; tasks shows `required:true`. Non-admin → `403`.
- [ ] `PATCH /api/admin/modules/wellness {disabled:true}`. **Expected:** `200`, `instanceDisabled:true`; audit `module.instance_disable`. Disabling a required module (tasks/settings/chat/connectors) → `409`; unknown module → `404`.
- [ ] With wellness instance-disabled, refresh the shell. **Expected:** the Wellness nav entry is gone; deep-linking `/wellness` shows a **denied** gate (not the UI), and `GET /api/wellness/*` returns `404` (generic, no leak).
- [ ] Re-enable wellness. As a non-admin user, Settings → My Modules → disable wellness for yourself (`PATCH /api/me/modules/wellness {disabled:true}`). **Expected:** `userDisabled:true`, `active:false`; it's hidden **only for you** — another user still sees it (RLS isolation).
- [ ] `GET /api/me/modules`. **Expected:** per-module `{ active, instanceDisabled, userDisabled }` reflecting the combined rule (required→always active; instance-disabled→false; user-disabled→false if supported).

**Edge cases / poke at:** the gate **fails closed** — if `/api/me/modules` errors, a module route renders "denied," not the UI. Platform routes (`/api/me`, `/api/modules`, `/health`) are never 404'd by the guard. OPTIONS preflight to any route is no longer 404'd by the guard. Non-admin `PATCH /api/admin/modules/*` → `403` (existence not leaked as 404/409).

---

## 9. Wellness module — check-ins & medications

_What it is: an optional, user-toggleable module for feelings check-ins, medication management (six frequency types), dose logging, and an energy-based focus signal — owner-only across the board._

**Product lens:** Wellness exemplifies "first-class when enabled, silent when not." It should feed planning **abstractly** (capacity signals, never raw feelings into the focus summary or AI prompts), and it must be invisible to everyone but the owner — including admins.

**Post-review note:** **all 6 medication frequency types now work** — the create form previously 400'd on 3 of them, and `every_n_hours` produced no schedule slots. Both fixed. Test creating each frequency type below; **none should 400.**

**Try this:**

- [ ] At `/wellness` (ensure it's enabled), Feelings tab → "Log how you feel." Pick core→secondary→tertiary, body sensations, intensity 4 / energy 5, a note, "Save & discuss." **Expected:** check-in persists; `GET /api/wellness/checkins` lists it for you only.
- [ ] Medications tab — create **one of each frequency type** and confirm **none 400**:
  - [ ] **daily** (e.g. once-daily, no time-of-day specifics).
  - [ ] **specific_times** with `times='08:00'`. **Expected:** today's schedule shows the 08:00 slot as `pending` with a "Taken" button.
  - [ ] **specific_weekdays** (e.g. Mon/Wed/Fri). **Expected:** slots appear only on the selected weekdays.
  - [ ] **every_n_hours** (e.g. every 6 hours). **Expected (now fixed):** the daily schedule **generates slots** across the civil day — these meds are now visible and loggable (previously they vanished).
  - [ ] **cyclical** (anchor date + days-on/days-off). **Expected:** slots appear only within the "on" window.
  - [ ] **as_needed / PRN.** **Expected:** no scheduled slot; logging requires a reason.
- [ ] Click "Taken" on a pending slot → `taken`. Log the same scheduled dose twice → second is `409` (idempotent per slot). PRN log requires a reason.
- [ ] **Focus signal:** log several check-ins with energy 1–2, then `GET /api/tasks/focus`. **Expected:** a `wellness` signal with low readiness and the focus list capped to ≤3. Log energy-5 check-ins → readiness rises, cap lifts.

**Edge cases / poke at:**

- [ ] **No data leakage:** the focus signal `summary` is abstracted ("Energy trended low") — no feeling words. The AI tools `wellness.recentCheckIns` / `wellness.medicationAdherence` return paths/counts only — no notes, sensations, or med names.
- [ ] **RLS:** User B cannot see User A's check-ins/meds; cross-user dose log against A's med → trigger rejection. Admins are subject to RLS too (no bypass).
- [ ] Disable the module mid-use → data persists; re-enable restores history.

---

## 10. Secondary-user (household member) onboarding

_What it is: after the founder approves a member, that member walks through a member-specific wizard (welcome → AI key opt-out → connectors → section tour), tracked per-user in an owner-only RLS table._

**Product lens:** "single-user at core, scoped collaboration as direction." A household member gets their OWN private assistant — a different, lighter wizard than the founder, and an onboarding/wellness/chat/task space the admin cannot read. This is where "no admin private-data bypass" gets tested for real.

**Try this:**

- [ ] As owner, approve a second user and (optionally) promote them to admin. As that user, `GET /api/onboarding/status`. **Expected:** `{ role:'member', completed:false, steps:{ apiKeyOptOut:{done}, connectors:{done} } }` — **never** the founder shape, even if promoted to admin (only the bootstrap owner is the founder).
- [ ] Navigate `/` as the member. **Expected:** the **member** wizard: Welcome → "AI assistant" (use shared or add your own key) → Connect accounts → "A quick tour." No multiplexer/CLI steps.
- [ ] Skip or finish. **Expected:** `POST /api/onboarding/complete` (or `/skip` — identical for members) stamps `app.member_onboarding.completed_at`; reload → no wizard.
- [ ] Section tour: a line per enabled section (Tasks/Calendar/Email/Briefings/Notifications/Settings, Wellness only if enabled). Disabled modules are omitted.

**Edge cases / poke at:**

- [ ] **No admin bypass (headline invariant):** as admin, you cannot read or write another member's onboarding state. `GET /api/onboarding/status` returns **your own** state; `/api/admin/users` carries **no** onboarding field. Member completion is **not** written to the admin audit log.
- [ ] Mid-wizard reload → member resumes at step 0 (member step-done is derived client-side). After completion → never re-shown.
- [ ] DB spot-check: `member_onboarding` has ENABLE+FORCE RLS, self-row-only policies (select/insert/update), and **no** admin SELECT policy. `app.users` has no `onboarding_completed_at` column.

---

## Security & privacy spot-checks

These are the cross-cutting invariants. Verify them deliberately — they're the difference between "works for me alone" and "safe to run for my household." This is the product's foundational promise: a private chief of staff where admin power is configuration power only.

**Cross-user data isolation (RLS everywhere)**

- [ ] User A's tasks, chat threads/messages, briefings, calendar/email, wellness data, connector accounts, and onboarding state are **invisible** to User B across every surface (API returns empty/404; direct DB queries under B's GUC return zero rows).
- [ ] User A's SSE chat stream never receives User B's records (subscriptions keyed by actorUserId).
- [ ] A view-shared task is read-only to the grantee; manage-share allows edits but **not** recurrence roll-forward (owner-only predicate).

**Admin is config power only — no private-data bypass**

- [ ] An instance admin (including the bootstrap owner) cannot read another user's tasks, member onboarding, wellness, chat, or connector secrets by role alone — FORCE RLS applies to admins too.
- [ ] Self-escalation is blocked at the DB trigger layer, not just the route; last-admin demotion/deletion is guarded (`409`).

**Secrets never escape**

- [ ] `/api/admin/auth/providers` and `/api/admin/connectors/accounts` expose **no** client secrets, tokens, or `JARVIS_AUTH_*`/`JARVIS_*_SECRET_KEY` values. Audit events never log session tokens or API keys.
- [ ] Connector/AI credentials are decrypted only in worker scope (never in app routes, logs, pg-boss payloads, exports, or prompts); they're AES-256-GCM at rest.
- [ ] Onboarding/focus/wellness responses contain no `token|secret|password|credential`-shaped fields (CLI detection is presence-only; connectors are existence-only booleans).

**Email body privacy**

- [ ] No raw email body column exists or is populated; the body-echo and reconstruction guards (including the wrapper-prefixed leak closed this round) prevent the LLM from leaking the body into summary/signals. The secret payload string never appears in any response.

**Auth & sessions**

- [ ] Missing/expired sessions → `401` on every protected route (and show the sign-in form, not a pending/deactivated screen). Pending/deactivated users are blocked at `resolveAccessContext`, not just the route. Deactivation revokes sessions (defense in depth).

**Metadata-only job payloads**

- [ ] pg-boss payloads (sync, briefing, recurrence, deferred-status) carry only actor/resource IDs, job kind, idempotency key — no private content, prompts, or secrets.

---

## Deploy path — can I run this in production?

_What it is: the portable, containerized stack (the Phase 2 headline) — both images build, in-image migration runs, health is green, the container-to-host CLI bridge survives a reboot._

**Try this (on the deploy host):**

- [ ] `pnpm smoke:compose:prod`. **Expected:** builds both images, the in-image migrate runs via tsx, `/health/ready` returns `{ok:true, db:ok, pgboss:ok}`.
- [ ] Inspect the prod Compose config: pinned GHCR image tags, named volumes, **no** source bind mounts; `POSTGRES_PASSWORD` is strong (not the dev default) and required (fail-fast if missing/weak).
- [ ] Install + start the systemd unit `jarv1s-stack.service`; reboot the host (or `systemctl restart`). **Expected:** the stack comes back at boot.
- [ ] `bash scripts/verify-reboot-survival.sh`. **Expected:** PASS — health green **and** the container-to-host tmux bridge works after reboot (this is the load-bearing check for live chat in a container).
- [ ] `docker stop` the API. **Expected:** clean graceful SIGTERM shutdown, exit code 0.

**Edge cases / poke at:** no secrets baked into image layers; `.dockerignore` excludes `env.production.local`. Note the LOW deploy-hardening residuals in the next section — they're operator-ergonomics nits, not corruption.

---

## Deferred — NOT testing this round

These are known, intentional gaps. Don't file them as bugs. Most of the branch-review fixes already landed this round, so the items below are genuinely out of scope (not "broken").

- **App-wide "Ritual" UI restyle.** All Phase 2–5 UI is functional/plain CSS only. The semantic-token design system, card primitives, colored Feelings Wheel, briefing reading view, and screen-by-screen restyle are a separate design session pending Ben's mockup sign-off.
- **Briefings fork #1 — wellness-section seam.** Compose uses a fixed grounding set, so `wellness.recentCheckIns` does **not** contribute a briefing section in v1 (integration test honestly skipped). Decision pending.
- **Briefings fork #2 — per-user enablement in the scheduled worker.** The briefings worker still runs the full manifest tool set; a user disabling wellness may still have wellness tools run in their scheduled briefing. Documented gap for Phase 3.
- **API-key chat adapter.** v1 is CLI-subscription only (tmux/herdr bridge). The API-key adapter is deferred per ADR 0008.
- **#19 CLI fast-fail.** Test-and-see; not part of this acceptance run.
- **Backups (#70).** `scripts/backup-database.ts` / `restore-database.ts` exist but are not wired into compose or systemd; operator runs them manually.
- **MED/LOW audit residuals (#209).** The branch-review HIGH/MED cluster was **swept this round** (sync isolation, freeBusy fail-closed, OPTIONS preflight, email summary echo-guard, all 6 medication frequency types, export-user summary/signals columns). The remaining LOW items (deploy `--env-file`/socket-dir ergonomics, a few latent recurrence/wellness edge guards, doc nits) ride to #209 and are **not** gating this round.
- Other honest limitations carried forward (all DIRECTION, not v1): the evening **interview** + live surgically-patched briefings, advisor personas, the "what Jarvis knows about me" user-model with confirmed-vs-inferred facts, usage-appetite/cost controls and budgets, granular per-module CRUD permission UIs, Jarvis-created tasks with provenance + evening rollup, news/weather in briefings, audio/visual briefing artifacts, privacy mode. Also: weekly briefing cadence (daily only), no password reset / OAuth setup UI / 2FA / invitations / rate-limited login, medication schedule editing (delete+recreate), no medication reminder worker, no email→task auto-capture, single Google account per user, naive civil-time for wellness scheduling, in-memory ConfirmationRegistry (server restart orphans a pending tool approval), shared-uid chat boundary (operator with host shell can attach to sessions), and HTTP-only nginx (add your own TLS terminator).

---

## Quick acceptance checklist

The headline things that must work for **"yes, this is the assistant I intended, and I can run and deploy it myself."**

**Use it (founder, fresh instance):**

- [ ] Fresh instance → I become bootstrap owner + admin, immediately active.
- [ ] The founder onboarding wizard fires, is resumable, and never traps me on a spinner (4s timeout falls through to the shell).
- [ ] I can create/complete/recur tasks; recurrence rolls forward without stacking; focus/at-risk/overdue views are sane.
- [ ] I can create and run a briefing; it synthesizes a "what matters + why" report, and degrades gracefully with no model.
- [ ] Google connects; calendar + email sync; one messy event does **not** discard the whole sync; email triage shows summaries/signals — and **no raw email body is stored anywhere**.
- [ ] Live chat streams; the default persona reads like a chief of staff; write tools require my Approve; denied/timed-out tools never execute.
- [ ] Focus-time proposes, conflict-checks, and only writes to Google **after I approve**; a fully-booked morning fails closed (no block over a real meeting); retries don't double-book.
- [ ] Wellness (when enabled): all 6 medication frequency types create without a 400; feeds planning abstractly; goes fully silent when disabled.

**Run a household (multi-user + security):**

- [ ] Registration gate + approve/reject works; pending/deactivated users see the right blocking screens and are blocked at the auth layer.
- [ ] A member gets the member wizard (not the founder flow); their onboarding/wellness/chat/tasks are invisible to the admin (no admin private-data bypass).
- [ ] Cross-user RLS holds on every surface; secrets are never returned to the client or logged.
- [ ] Admins can disable modules instance-wide; users can self-disable; nav + routes + the deep-link gate all respect it and fail closed.

**Deploy it:**

- [ ] `pnpm smoke:compose:prod` passes (both images build, in-image migrate runs, `/health/ready` is `{ok:true, db:ok, pgboss:ok}`).
- [ ] Prod Compose uses pinned GHCR tags + named volumes, no source bind mounts; `POSTGRES_PASSWORD` is strong and required.
- [ ] systemd `jarv1s-stack.service` starts at boot; `scripts/verify-reboot-survival.sh` PASSes (health + container-to-host tmux bridge).
- [ ] `docker stop` exits the API cleanly (graceful SIGTERM, exit 0); no secrets in image layers; `.dockerignore` excludes `env.production.local`.
