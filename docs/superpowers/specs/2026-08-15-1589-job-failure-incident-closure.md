# #1589 — worker→Postgres connection-acquire failures: incident closure and the detection gap

**Status:** Draft for Ben's approval. Authored 2026-08-15.

**Read this section before anything else.** The issue title and body describe a live production
incident with an unknown cause. That framing is **out of date**. The cause was found and the fix
has already shipped. What remains under #1589 is smaller and different from what the issue says,
and this spec exists to scope that remainder honestly rather than re-specify work that is already
merged.

## What already happened (do not re-build any of this)

The incident was root-caused on 2026-08-12 and is recorded in the third comment on #1589. The
headline of the issue — "connectivity/pool config between the app container and Postgres" — is
**wrong**, and was disproven with a control experiment: a separate process inside the same
container, on the same network, with the same credentials, connected to Postgres in 33–68 ms at
the exact moment the worker's own connects were timing out at 5000 ms.

The real cause: `notes.sync` embedded Obsidian-vault markdown on the worker's **main thread**.
ONNX inference saturated the CPU and blocked the event loop for tens of seconds. The pg pool's
`connectionTimeoutMillis` is a `setTimeout` **in that same blocked loop**, so the timer fired
before the already-completed TCP+auth callback could be processed, and pg-pool destroyed its own
socket. Postgres never failed anything. Every job unlucky enough to overlap a `notes.sync` run
died before reaching its own logic — which is why the failures looked indiscriminate.

The root fix was tracked as **#1590** and merged as **PR #1609** (merge commit
`e546bd7d85a88018b4682b6505f5988ee530841e`, 2026-08-14). #1590 is closed. It delivered:

- embedding moved off the worker's main thread (`packages/memory/src/local-embedding-worker.ts`,
  `packages/memory/src/local-embedding-provider.ts`),
- a chunk cap on `notes.sync` (`tests/unit/notes-sync-chunk-cap.test.ts`),
- the `news_refresh_state` stuck-at-`queued` guard, which was recommendation 5 in the root-cause
  comment (`packages/news/src/personalization-repository.ts`,
  `tests/unit/news-refresh-failure-context.test.ts`).

Recommendation 3 from that comment — raise `JARVIS_DB_CONNECT_TIMEOUT_MS` from 5 s — was
**explicitly declined by Ben on 2026-08-12** as symptom-masking. That decision stands; see the
decision on it below.

So: recommendations 1, 2, 4 and 5 shipped, and 3 was declined. #1589 is still open because
nobody closed the loop on it, not because work is outstanding on the cause.

## Goal

Close #1589 truthfully. That means three things, in priority order:

1. **Prove the fix actually worked in production.** Nobody has checked. The fix merged on
   2026-08-14; prod pulls `:edge` automatically. "CI green and merged" is not evidence that a
   production incident ended.
2. **Fix the one confirmed residual** the root-cause comment recorded and no issue tracks: NUL
   bytes in note text crash `INSERT INTO app.memory_chunks`.
3. **Close the detection gap that let this run for days.** This is the durable value of the
   incident and the only part with meaningful design content.

## Non-goals

- Re-doing any part of #1590 / PR #1609.
- Changing `JARVIS_DB_CONNECT_TIMEOUT_MS`, the pg pool size, container networking, or the compose
  topology. All four were investigated and cleared with evidence; reopening them re-litigates a
  settled diagnosis.
- Building a general metrics/telemetry stack, a time-series database, or a dashboard. The bar here
  is "a human learns the queue is broken within hours", not observability as a product.
- Notifying through any new external service, secret, or vendor.

## Confirmed state of the tree (seams check)

Every claim below is cited against the current `origin/main` and must be re-verified by the build
agent before it plans against them.

| Assumption                                             | Evidence                                                                                                                                                                           | Status                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| No sanitization at the `memory_chunks` insert          | `packages/memory/src/repository.ts:74` — `chunk.text` is bound directly                                                                                                            | confirmed absent                                            |
| Pool connect timeout default is 5 s                    | `packages/db/src/database.ts:20-23` — `max: 4`, `JARVIS_DB_CONNECT_TIMEOUT_MS ?? 5000`                                                                                             | confirmed                                                   |
| Nothing reads `pgboss.job` for failures                | `packages/jobs/src/pg-boss.ts:152-192` — only `hasInFlightJob` / `hasRecentJob`, both filter `created\|retry\|active`; no `state='failed'` read anywhere in `packages/` or `apps/` | confirmed absent                                            |
| `/health/ready` does not see job state                 | `apps/api/src/server.ts:347-368` — `SELECT 1` plus `boss.isInstalled()`, which only checks the schema exists                                                                       | confirmed                                                   |
| Admin diagnostics does not see job state               | `packages/settings/src/host-diagnostics.ts:66-85` — the `pgboss` check is two booleans, `detail: "Installed and reachable"`                                                        | confirmed                                                   |
| A worker that is up but failing every job is invisible | `scripts/start-jarv1s.ts:131,207-210` — the container dies if a child exits, so a _crashed_ worker is visible; a _failing_ worker is not                                           | confirmed                                                   |
| There is one central handler seam                      | `packages/jobs/src/pg-boss.ts:327-341` — `registerDataContextWorker`, no try/catch around the handler call                                                                         | confirmed, **but not universal**                            |
| That seam is bypassed by three call sites              | `apps/worker/src/worker.ts:178`, `apps/worker/src/worker.ts:349`, `packages/jobs/src/upgrade-notify.ts` use raw `boss.work(...)`                                                   | confirmed — this is a design constraint, see the fork below |
| An in-repo alarm pattern exists                        | `.github/workflows/edge-publish-alarm.yml`, spec `docs/superpowers/specs/2026-08-13-1454-image-publish-alarm.md`                                                                   | exists, **does not transfer** — see below                   |
| No event-loop lag metric exists anywhere               | no `perf_hooks` / `monitorEventLoopDelay` in `packages/` or `apps/`                                                                                                                | confirmed absent                                            |

**Open question for Ben, not an assumption to resolve in code:** the #1454 alarm works because
GitHub is an external observer watching a system it is not part of. A pg-boss failure alarm has no
free external observer — a GitHub Actions cron cannot reach a self-hosted Postgres behind Ben's
network. The "in-app" fork that #1454 deliberately rejected is therefore likely forced here. Phase
2 must not be planned as if the #1454 mechanism can be copied.

## Phases

Phase 1 ships alone and is evaluated before Phase 2 is planned in detail.

### Phase 1 — closure and the confirmed residual

**1a. Production recovery verification. Ben-only; not agent-buildable.**

No agent has prod access, and the standing rule is that Ben handles prod directly. This step is a
question put to Ben, not a task dispatched to a lane. What must be established:

- The prod container is running an image built at or after merge commit `e546bd7d85a8`.
- `pgboss.job` shows the `notes.sync`-correlated failure clustering is gone: the non-`notes.sync`
  failure rate inside a `notes.sync` window is no longer materially above the rate outside it. The
  incident measured 77% inside vs 1% outside over 6 hours; the closure bar is that those two
  numbers are within noise of each other.
- `app.news_compilation_snapshots.compiled_at` is recent, and `app.news_refresh_state` is not
  stuck at `queued` with a large `requested_generation` − `compiled_generation` gap.

If the first bullet fails, the honest status is "fixed, not yet deployed" and #1589 stays open
pending a deploy — not pending more engineering.

**1b. NUL bytes must not reach `app.memory_chunks`.**

The root-cause comment recorded repeated `invalid byte sequence for encoding "UTF8": 0x00` on
`INSERT INTO app.memory_chunks`, flagged as unrelated to the incident. No issue tracks it. It is
real and it silently loses note content: the insert throws, the chunk is never persisted, and
because `upsertFileChunks` deletes existing chunks first
(`packages/memory/src/repository.ts:66-69`), a file that gains a NUL byte can lose the chunks it
already had.

Decision: strip `U+0000` (and the rest of the C0 control range except `\t`, `\n`, `\r`) from chunk
text at the **repository boundary**, not at each call site. Rationale: the boundary is the one
place every write path passes through, and the repo already uses exactly this pattern at
`packages/chat/src/attachments-service.ts:92`. Sanitizing at call sites is how one path gets
missed.

Explicitly rejected: rejecting the whole file, or failing the job. A NUL byte in a transcript is
not a security event and not a user error; losing the note over it is a worse outcome than losing
the byte.

The same boundary decision applies to `sourcePath` if it can carry a NUL — the build agent must
check whether the path is already validated upstream (`packages/notes/src/write-tools.ts:31`
rejects `\0` in one path) and state the answer rather than defensively sanitizing both.

Test cases, stated as behaviour:

- A chunk whose text contains ` ` persists, with the NUL absent from the stored text. Against
  a broken implementation this throws `22021` / `invalid byte sequence` and the row is missing.
- A file that previously had N chunks, re-ingested with a NUL byte introduced, still has N chunks
  afterwards. Against a broken implementation the delete-then-insert leaves zero chunks — this is
  the data-loss case and the reason the test is not just "the insert succeeds".
- Text containing `\t`, `\n`, `\r` round-trips unchanged. Against an over-broad strip these are
  silently removed and chunk boundaries shift.

**Risk tier for Phase 1: `sensitive`.** Trigger: it changes what is persisted on a sync/import
path into a shared table carrying private note content. It is not `security` — no auth, RLS,
secret, token, or network-exposed surface is touched. Per the tiering rule this gets standard QA
plus an explicit invariant check (`DataContextDb` is still asserted, no widening of the write path)
plus a matched e2e-UAT; no Ben merge sign-off required.

**Kill gate after Phase 1. Owner: Ben.** If 1a shows prod did _not_ recover — the failure
clustering is still present on a post-`e546bd7d85a8` image — then the diagnosis in #1590 was
incomplete, Phase 2 is cancelled, and #1589 reverts to an open investigation rather than a
detection-gap feature. Do not plan Phase 2 in detail until 1a returns.

### Phase 2 — box-wide job-failure detection (plan only after the Phase 1 gate)

Not specified in implementation detail here, deliberately. What is fixed now is the shape of the
problem and the forks that must be settled, so that whoever plans it does not re-derive them.

**The gap, precisely.** pg-boss writes failures to `pgboss.job.state='failed'` and nothing reads
them. There is no counter, no query, no route, no UI, no alarm. The news module has a staleness
indicator, which is the only reason this incident was noticed at all — every other affected job
type (`job-search.crawl-sweep`, `connectors.google-sync`, `connectors.email-monitor`,
`chat.embed-turn`) failed silently for days.

**Fork A — where the counter lives.** Wrapping the handler call at
`packages/jobs/src/pg-boss.ts:339` is the obvious hook, but it is **not universal**: three call
sites use raw `boss.work(...)`, and an in-process wrapper cannot see supervisor-expired jobs at
all. Reading `pgboss.job WHERE state='failed'` catches every path including expiry. The in-process
wrapper should be ranked as the option to reject, and rejected on coverage, not on effort.

**Fork B — how a human finds out.** The #1454 pattern (GitHub issue + red Actions run) is not
available, per the open question above. The realistic candidates are the existing admin diagnostics
pane (`packages/settings/src/host-diagnostics.ts`, already rendered with red/amber/forest severity
by `apps/web/src/settings/host-health-summary.ts:31`) and the `needs-ben` Telegram notifier. The
diagnostics pane is pull-based — it only helps someone who already suspects a problem, which is
exactly what was missing here. Whichever is chosen, the plan must say which failure mode it does
_not_ cover.

**Hard constraint on any surface that exposes failures.** `pgboss.job` failure output contains
error text, and error text can contain file paths, note content, prompts, and credentials from
whatever threw. Rendering raw job error output into an API response or a notification would breach
the "secrets never escape" invariant. Any surface must expose **classified, bounded** fields —
queue name, job kind, count, first/last timestamp, error _class_ — never raw `output`. This is the
reason Phase 2's tier is higher than Phase 1's.

**Risk tier for Phase 2: `security`.** Triggers: it adds a network-exposed surface, and it moves
data that can contain secrets across a trust boundary. Per the "in doubt, take the higher tier"
rule this is not negotiable down to `sensitive`. It therefore gets Opus adversarial QA, a mandatory
`gh pr comment` verdict, and Ben's explicit merge sign-off. If Phase 2 is instead scoped to a
worker-internal log line with no new surface, re-tier it at planning time.

**Recommendation:** Phase 2 is arguably its own feature rather than incident closure. If Ben agrees,
split it to a new `task` issue at the Phase 1 gate and close #1589 on Phase 1 alone. That keeps the
incident issue honest and stops a closed incident from carrying an open feature.

## Decisions recorded (so they are not re-litigated)

- **`JARVIS_DB_CONNECT_TIMEOUT_MS` stays at 5000 ms.** Ben declined the raise on 2026-08-12 as
  symptom-masking, and it also required a prod container recreate outside the normal deploy path.
  A 5 s connect timeout is correct against a healthy event loop; it only misfired because the loop
  was blocked, and the loop is no longer blocked. Raising it would trade fast, honest failure for
  slow, hidden failure. Revisit only if Phase 2 shows connect timeouts recurring with the loop
  demonstrably idle.
- **Container networking, DNS, pool exhaustion, OOM, and the 2026-08-11 deploy are all cleared**
  with evidence in the #1589 root-cause comment. Do not re-investigate them without new evidence
  that contradicts that comment.

## Exit criteria

#1589 may be closed when all of the following hold:

1. Ben has confirmed the prod image is at or after `e546bd7d85a8` **and** that the
   `notes.sync`-correlated failure clustering is gone, with the two failure rates recorded on the
   issue. (Phase 1a.)
2. NUL-byte-bearing note text persists to `app.memory_chunks` without loss, proven by the three
   test cases above, executed and observed to pass — not merely written. (Phase 1b.)
3. The full gate is green, run through the `verify-gate` skill on a fresh exported gate database:

   ```bash
   pnpm verify:foundation > /tmp/vf-1589.log 2>&1; echo "EXIT=$?"
   ```

   Expected `EXIT=0`. Never piped — a pipeline reports the last command's status and the gate
   reads green even when it failed.

4. A live-path proof is posted on the PR: a real note containing a NUL byte ingested through the
   running dev instance, with the resulting `app.memory_chunks` row count and stored text recorded.
   Per the live-path gate, CI-green plus code review is not sufficient for this to be Done.
5. Phase 2 is either delivered, or split to its own `task` issue with a link recorded on #1589 —
   stated explicitly either way, never left implied.

## Labels and process gates

#1589 carries only the `bug` label. It needs a `task` label before any build lane starts, per
CLAUDE.md's "spec before build" gate, which requires a task issue and not merely any issue.
