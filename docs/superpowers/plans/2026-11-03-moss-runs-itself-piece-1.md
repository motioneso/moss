# Moss Runs Itself, Piece 1: Moss Reads Its Own Logs, Jobs, Settings and Code

**Spec:** docs/superpowers/specs/2026-11-03-moss-runs-itself-design.md (section 4)
**Task issue:** #3978 (Part of #3973)
**Status:** Revised after Codex review (2026-11-03). Pre-approved by Ben.

## 1. Scope

Read-only chat tools that let Moss explain why something behaves as it does. No repair and no code
change (pieces 2 and 4). No new screens, so no mockups; the only user surface is Moss's chat answer.

The first draft assumed nothing existed. The review found a diagnostics tool and a source reader
already shipped, so this piece is smaller than the design implies: audit first, then fill the
measured gaps.

## 2. Seams check

Verified at origin/main on 2026-11-03.

| Capability                                   | Evidence                                                                                                          | Finding                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Platform diagnostics tool                    | packages/settings/src/manifest.ts:862 (`settings.platformDiagnostics`), packages/settings/src/platform-diagnostics-tool.ts:3-30 | Exists. Sections: version, runtime, modules, errors, actions, source. Permission `settings.view`, actor-scoped. |
| Source reader                                | packages/settings/src/manifest.ts:825 (`app.readSource`), tests at app-action-tools.test.ts:188                    | Exists. Relative `packages/*/src` or `apps/*/src`, max 400 lines. Not admin-gated. |
| Stored per-user Moss errors                  | packages/ai/src/repository.ts:2736 (`recordError`), table `app.moss_error_log` (packages/ai/sql/0183)             | Exists. AI errors only, not connector or job logs.         |
| Diagnostics composed and injected into chat  | packages/module-registry/src/index.ts:3927, packages/chat/src/gateway-services.ts:295                              | Exists. The public service route to reuse.                 |
| Admin lookup inside a tool                   | packages/module-registry/src/index.ts:3949 (scoped admin lookup); `ToolContext` has `actorUserId` only (packages/module-sdk/src/index.ts:119) | Exists. Live database check with `ctx.actorUserId`; no new `AccessContext` fields. |
| Instance admin flag                          | packages/settings/src/repository.ts:481                                                                           | Exists.                                                    |
| Job queue table reads                        | packages/jobs/src/module-job-sweep.ts:80 (`pgboss.queue`), :101 (`pgboss.job` via `rootDb`)                       | Reads exist but run as the root role. Whether the chat role can read them is **unproven**. |
| Raw application logs                         | apps/api/src/server.ts:268 (pino to stdout, secret protection in apps/api/src/recording-logger-options.ts:2); worker logger apps/worker/src/worker.ts:206 (no redaction) | No stored, readable log. API and worker are separate processes (scripts/start-jarv1s.ts:199). |
| Version at runtime                           | Dockerfile:112-125, infra/docker-compose.prod.yml:160, .github/workflows/ci.yml:525                                | Wired already.                                             |
| Tool shape                                   | packages/settings/src/app-map-tool.ts:85 (`ToolExecute`)                                                          | Exists.                                                    |

Open questions, owner is the builder, answered in Phase 0:

1. Which existing sections of `settings.platformDiagnostics` answer a real fault, and which come
   back empty?
2. Which database role would read `pgboss.job` for a chat tool, and does RLS or a grant block it?
3. Is an existing redaction function reusable for free-text log lines?

## 3. Decisions taken (review findings accepted)

- **Extend, do not duplicate.** New capability goes through the existing diagnostics service and
  `settings.platformDiagnostics` sections wherever it fits. A second tool is added only when a
  section cannot hold the data.
- **Privacy before visibility.** Every diagnostic record carries its owner at the point it is
  produced. Reads are actor-aware. A record from another owner, or with no known owner, returns
  only a metadata allowlist (time, level, component, connection kind, event code). Admins get no
  exception to this (hard invariant: no admin private-data bypass).
- **Admin gate is a live database check** on `ctx.actorUserId` inside the service. Never from tool
  arguments, never a new field on `AccessContext`. Settings does not import `apps/api` internals
  or query AI-owned tables; it uses a public service contract the host injects.
- **One shared, sanitized log sink for both processes.** A database table owned by the settings
  module (new migration in the module's `sql/`, never an applied one), written by the API and the
  worker through one diagnostics service. Bounded by row count, age and per-record bytes, with a
  purge job. This also keeps logs across a restart, which is when an admin asks. Log content never
  travels through pg-boss.
- **Sanitize before either destination.** The same sanitizer runs before a record is written to
  stdout and to the table, so secrets never exist in an unredacted copy. It covers nested errors,
  URL credentials, cookies, bearer tokens and oversized records, on top of the existing
  recording-secret protection.
- **Source reader stays reconciled, not duplicated.** `app.readSource` is not admin-gated today.
  The plan decides in Phase 3 whether to tighten it (admin-only) or leave it, with Ben's call
  recorded; it is not silently left inconsistent with the design.

## 4. Determinism boundary

Tool results are deterministic records: rows, counts, timestamps, bounded text. The model has two
jobs: choose which tools to call, and turn the returned facts into a plain-English cause. Guidance
for the tools stays under 150 words in total. There is no new UI, so no model-generated UI
feedback.

## 5. Phases

### Phase 0: Coverage audit (no product code)

Against a real dev instance, run `settings.platformDiagnostics` through a real chat turn for two
real faults: a connection whose helper is down (the Outlook case) and an unwanted news story. Record
in a note appended to this plan: what it answered, what it left empty, and why. Answer open
questions 1-3. This decides the size of Phases 1 and 2. If the tool already explains both faults,
the kill gate below ends the piece early.

### Phase 1: Job queue and connection state (ships alone)

Add sections to the existing diagnostics service: recent job runs, failures, stuck jobs, last
success per job kind, retries (metadata only per the job payload invariant), and connection state
(last good sync, bounded error label). Admin-only by the live check. Contracts to fix in the
detailed task list: section names, output schema bounds, and the injected job-read service
signature.

Tests (behaviour, and the reason each fails against a broken build):

- A non-admin gets a denial from the server and no diagnostic data. Spoofed admin claims in the tool
  arguments are ignored. A demoted admin is refused. A missing identity is refused.
- Two users, and two admins, cannot see each other's owned records beyond the metadata allowlist.
  Each privacy assertion must be observed failing with the check removed.
- A job row with a payload of private-looking content returns metadata only.
- Output over the cap is truncated and flagged.

E2E (real dev instance, Playwright): trigger a real failing job through a real app action, choosing
a unique marker that is not in the question. Sign in as the admin, ask Moss why it failed, and
assert both the exact safe fact in the answer and evidence that the diagnostics tool ran. Then sign
in as a non-admin and assert a server-side denial and no diagnostic data, not a model-written
refusal. No faked network responses. The test must fail if registration, injection, authorization
or privacy is broken.

### Phase 2: Raw log sink and reader (planned in detail after the kill gate)

Implements the shared sanitized sink in section 3, plus a `logs` section with filters (time, level,
component, connection), per-record and total byte caps, validated options, and a specified adapter
from pino records (level mapping, child bindings, failure of the sink never breaks the request path).
Existing custom streams, serializers and `logger: false` keep working. Tests: log storm, one huge
record, UTF-8 byte limits, sink error, a worker warning retrieved through chat (two-process test).

### Phase 3: Source access (planned in detail after the kill gate)

Reconcile `app.readSource` with the admin-only rule (Ben's call), and let diagnostics point at
source by path and line. Source stays inside the confined reader; `.env`-style and key files stay
denied.

## 6. Verification

Run from a script that keeps the real exit status (an `echo` after a command hides it):

```bash
pnpm typecheck > /mnt/unity-nvme/scratch/piece1-typecheck.log 2>&1; rc=$?; echo "EXIT=$rc"; exit $rc
```

Expect exit 0. The full gate and any database test run only through the verify-gate skill, and
CI's end-to-end step is listed separately because the local gate excludes it. Each phase also names
its focused test command and its Playwright command in the detailed task list.

## 7. App map and production

Each phase updates the app-map declarations in the same PR: the tool or section, the admin-only
rule, requirements, errors and remediations, process coverage (API and worker) and retention
limits. Anything that adds a required setting must also add it to the dev and prod deployment
config in the same PR, and Phase 2's migration must not break an existing install.

## 8. Kill gate

Owner: Ben. After Phase 0 and Phase 1, run both real faults again. Continue only if Moss names a
true cause backed by returned evidence, or names exactly which evidence is missing. Stop and
rethink if Moss still cannot explain either fault with Phase 1 in place. Judge it on
evidence-backed explanations and named gaps, not on logs alone proving the cause. If Phase 2 ships
and the sink is empty at the moment it is needed, reopen the storage design before Phase 3.

## 9. Rulings ledger

- The first plan draft claimed no diagnostics or source tools existed. Wrong: manifest.ts:825 and
  :862 ship them. Correction recorded here so it is not re-derived. (Codex review)
- A process-wide in-memory buffer was rejected: the API and worker are separate processes, an admin
  gate does not make shared logs private, and a restart loses it. (Codex review, blockers 1 and 2)
- Redacting only the buffer copy was rejected: stdout would keep the secret. Sanitize before both
  destinations. (Codex review, finding 3)
- Read container logs through the host: rejected. It needs piece 2's host helper and fails after
  the move off Docker.
- `pgboss.job` is read as the root role in module-job-sweep.ts:101, which does not prove a chat
  tool's role can. (Codex citation audit)
- Admin gating of existing routes is at routes.ts:928; tool-level gating uses the live check above.
