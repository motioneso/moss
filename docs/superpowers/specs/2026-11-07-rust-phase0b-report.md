# Rust port, Phase 0b: Tasks end to end

- Task: JS-36. Part of #4027.
- Plan: `docs/superpowers/specs/2026-11-06-rust-port-plan.md`, Phase 0b, sections 2.3, 3 and 4.
- Data and install rules: `docs/superpowers/specs/2026-11-06-rust-port-data-and-install-rules.md`.
- Phase 0a: `docs/superpowers/specs/2026-11-07-rust-phase0a-report.md`.
- Code: `rust-spike/`, a throwaway cargo workspace. `rust-spike/README.md` says how to run it.
- Run on 2026-11-07 with cargo 1.95.0 and Node 22.22.2.

## Summary

Ben ruled on 2026-11-07 that the rewrite goes ahead and that this phase's stop rule is "a
measurement, not a verdict". So this report measures the cost honestly, says how to handle each
part that is hard or costly, and ends with a plan to proceed.

- **Go.** Nothing in Tasks turned out to be something Rust cannot do.
- **The Rust server gives the same answers as the TypeScript one.** All 67 side-by-side cases
  match on the final run. 19 of them send requests as user B or the admin as well as user A (28
  requests in all), and those are the cases that test whether the Rust server acts for the right
  user. Another 20 cases also query the database directly as each runtime role. Those queries
  check the database's row-security rules, not either server.
- **64 of the 146 Tasks integration tests converted, 62 in full and 2 in part**, and none of
  them found a difference. Of the 66 tests that go through HTTP and cover the ported part, 64
  converted. The other 82 test features the spike left out (46), call AI tools directly (23), test
  plain functions (10), or need a runner step that does not exist yet (3).
- **The runner catches a wrong server.** Three planted one-line bugs in the Rust server all made
  the run fail, including one that ran every request as the same user.
- **The Rust server refuses unsafe database roles.** It will not start on the migration role, on
  a superuser, or on a role that can bypass row security. With its check switched off it does
  start, so the check is what refuses.
- **Rust is about as long as the TypeScript it replaces**, at 0.85 to 0.95 lines per line.
  Porting Tasks cost about 0.31M output tokens. About 38% of that went into pieces every later
  module reuses.
- **The whole port would cost about 37M to 81M output tokens**, roughly 600 to 1,600 context
  windows. The hard parts (chat, AI, the CLI runner, connectors and the rest) cause most of the
  spread, because nothing like them was ported here. Like every cost in this report, this counts
  only the tokens agents write, not the far larger number they read.
- **The side-by-side runner is cheap.** Building it and converting every test would cost about
  1.9M to 4.1M output tokens, 2% to 11% of the port. The plan's stop line was a runner that costs
  as much as the port.
- **Pick Leptos for the screens.** Both candidates drew the Tasks screen identically and
  responded the same. Leptos sends about a third less to the browser and fits the plan's single
  served page for desktop, phone and LAN. Dioxus built faster and has fewer dependencies.

## What was built

- **A Rust Tasks server** (`rust-spike/tasks`).
  - 23 of the 27 Tasks endpoints. The four left out are the AI and agency ones (task breakdown,
    search interpretation, and reading and setting automatic execution).
  - The deferred-status background job, on its own small queue table.
  - The same database roles as the TypeScript server. It refuses to start unless the app
    connection is the app runtime role, the worker connection is the worker runtime role, and
    neither role is a superuser or can bypass row security.
  - The same data context. Every task read and write runs in a transaction that first sets the
    actor and the request id for that transaction only, as the TypeScript `DataContextRunner`
    does. That includes the job's own status update, which runs as the user who queued it.
  - Three queries run outside that transaction, and none of them touches task rows:
    - The sign-in lookup runs before the user is known, through the database's session and
      user lookup functions.
    - Queuing the job writes the user id, task id, requested status and idempotency key to the
      spike's queue table. It runs after the request's visibility check has committed, so the two
      are not one atomic step.
    - The worker claims and finishes jobs on that queue table with the worker role.
  - Answers that match the TypeScript server's status codes and bodies, including its
    request-parsing and validation errors.
- **A side-by-side test runner** (`rust-spike/parity`). It runs both servers on two copies of
  one throwaway database, sends each case to both, and compares the answers and the table rows.
- **Converted tests** (`rust-spike/parity/cases`, ledger in
  `rust-spike/parity/conversion-ledger.md`).
- **The Tasks screen twice**, in Leptos and in Dioxus (`rust-spike/ui`), against the real Rust
  server.

## How the side-by-side check works

- The database comes from the repo's own migrations, run by `scripts/run-gate.sh` in a throwaway
  Postgres. No dev or prod database and no real data were used.
- The runner copies that database twice, one copy per server.
- Before each case it empties both copies and loads the same seed: five users and three sign-in
  sessions, plus the case's own rows.
- A case is a JSON list of steps. A step is one of three kinds.
  - An HTTP request, sent as user A, B, the admin or nobody.
  - A SQL statement run as the app or worker runtime role, for a given user or for no user, then
    rolled back. The runner sends it straight to each database copy, so it checks the
    database's row-security rules, not either server.
  - A wait for a background job to finish.
- Each step's answer is checked against the case's expected values on each server separately.
  So a case cannot pass because both servers are wrong in the same way.
- Then the two servers' answers are compared in full, and after the last step the listed tables
  are compared row by row.
- Generated ids and fresh timestamps differ between the two runs, so both are replaced with
  stable labels before comparing. Ids become numbered labels in the order they first appear.
  Timestamps within ten minutes of the case start become one label.
- Cases are plain JSON, so they judge any server in any language.

## Evidence

Every run below went through `scripts/run-gate.sh`. It builds a fresh database from the repo's
migrations in its own throwaway Postgres container (Postgres 17.11 with pgvector) and removes the
container afterwards. The side-by-side, planted-bug and role-check runs all ran at commit
3721c1035 on a clean tree, and each log records that commit. Later commits change this report
and split one case file into two files that hold the same 30 cases in the same order.

### Final side-by-side run

```
scripts/run-gate.sh start --gate rust-spike/parity/run-parity.sh
```

```
scripts/run-gate.sh wait --follow
```

The run exited 0. These are its last lines, leaving out the gate's own end-time and cleanup
lines.

```
PASS suggested 242: accepting a suggestion sets todo without a completed time
PASS suggested 387: closing a parent leaves suggested children alone
PARITY 67/67 cases match
### FINAL rc=0
```

### Planted bugs: the runner catches a wrong Rust server

```
scripts/run-gate.sh start --gate rust-spike/tools/plant-parity-bugs.sh
```

A side-by-side check is only worth something if it fails when Rust is wrong. The script builds
three copies of the Rust server from git HEAD, each with one deliberate one-line bug. Each copy
then runs the three smoke cases through the same runner, with `--rs-bin` pointing at the broken
server and `--only smoke`. Every run had to fail, and every run did, with exit code 1. The gate
exited 0.

```
FAIL smoke: create, read back, other user and anonymous are refused
PARITY 2/3 cases match
wrong-actor: caught (exit 1)
FAIL smoke: create, read back, other user and anonymous are refused
FAIL smoke: deferred status job marks the task done
FAIL smoke: row security as each runtime role
PARITY 0/3 cases match
create-200: caught (exit 1)
FAIL smoke: deferred status job marks the task done
PARITY 2/3 cases match
job-wrong-status: caught (exit 1)
```

| Planted bug                     | One-line change                                                        | What the runner reported                                                                                                                                                                            | Cases matching |
| ------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Every request runs as user A    | the data context sets a fixed actor id instead of the signed-in user's | user B could read user A's task: `/status: TypeScript 404 vs Rust 200`, and only Rust returned the task                                                                                             | 2 of 3         |
| Creating a task answers 200     | `json_reply(201, …)` became `json_reply(200, …)` on create             | every case failed at its first request: `/status: TypeScript 201 vs Rust 200`                                                                                                                       | 0 of 3         |
| The job writes the wrong status | the job maps a requested `done` to `todo`                              | the job's output, the task read back afterwards and the `app.tasks` row all differed: `/output/status: TypeScript "done" vs Rust "todo"`, `/body/task/completedAt: TypeScript "<now>" vs Rust null` | 2 of 3         |

- With the wrong actor, the row-security case still matched. That is correct, because its SQL
  steps test the database's own rules under each runtime role, not the server's code.
- The job case did not notice the wrong actor, because it runs as user A, the same user the bug
  pinned. One user per case would miss this bug; the cases that switch users are what catch it.

### Role check: the server refuses roles that escape row security

```
scripts/run-gate.sh start --gate rust-spike/tools/check-role-guard.sh
```

The script starts the Rust server seven times against a copy of the gate database. It changes
roles only inside the gate's own throwaway Postgres server and resets them afterwards. Steps 5
and 7 use a copy of the server built from git HEAD with the bypass check switched off. They show
that the server's own check is what refuses, not something else in the setup. The gate exited 0.

```
1 normal roles: starts (wanted starts) | tasks spike listening on 127.0.0.1:5195
2 app connection on the migration role: refuses (wanted refuses) | Error: "connected as jarvis_migration_owner, expected jarvis_app_runtime"
3 worker connection on the app role: refuses (wanted refuses) | Error: "connected as jarvis_app_runtime, expected jarvis_worker_runtime"
4 app role can bypass row security: refuses (wanted refuses) | Error: "role jarvis_app_runtime can bypass row-level security; refusing to start"
5 same, with the check switched off: starts (wanted starts) | tasks spike listening on 127.0.0.1:5195
6 app role is a superuser: refuses (wanted refuses) | Error: "role jarvis_app_runtime can bypass row-level security; refusing to start"
7 same, with the check switched off: starts (wanted starts) | tasks spike listening on 127.0.0.1:5195
app role after reset: superuser=false bypass=false
```

### Rust unit tests

Run from `rust-spike/`, with no database. The server has 16 tests. The runner has 5, including
one that fails a step the runner could not carry out and one that rejects a case comparing
nothing.

```
cargo test -p tasks
```

```
test result: ok. 16 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

```
cargo test -p parity
```

```
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### Code counts

The size table under "Scaled to the whole codebase" comes from this read-only script. Its output
matched every number in that table.

```
rust-spike/tools/count-code.sh
```

- Production TypeScript is every tracked `.ts` and `.tsx` file except tests, type declarations
  and `rust-spike/`.
- Scripts and doc tooling are the files under `docs/`, `scripts/` and `tools/`.
- Screens are the remaining `.tsx` files and files in `web` folders.
- Server code is everything else. The hard parts are the eleven packages the plan names.
- A test is a line that starts with `it(`, `test(` or their `.each` forms.

## Measured counts

Every one of the 146 Tasks integration tests was read and sorted into one class. The per-test
list is in `rust-spike/parity/conversion-ledger.md`.

| Class                                   | Tests   | What it means                                                                                                                                            |
| --------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Converted, matching                     | 64      | Now a side-by-side case, and both servers agree. 62 in full; 2 in part (tasks 765 drops its external-key check, verticals 284 checks only its tags part) |
| Converted, not matching                 | 0       |                                                                                                                                                          |
| Calls an AI tool directly               | 23      | No HTTP request to compare. Needs a runner step that calls a tool                                                                                        |
| Tests a plain function                  | 10      | Becomes a Rust unit test beside the code                                                                                                                 |
| Outside the ported part                 | 46      | Tests a feature the spike left out, such as recurrence or email feedback                                                                                 |
| Needs a runner step that does not exist | 3       | Two read a queued job's payload (tasks 649 and 693). One filters by list and status together, which no HTTP route offers (tasks-tools 306)               |
| **Total**                               | **146** |                                                                                                                                                          |

- 64 of 146 converted, or 44% of all Tasks tests.
- 64 of the 100 tests that cover the ported part converted, or 64%.
- 64 of the 66 tests that go through HTTP and cover the ported part converted, or 97%.
- No Rust fix was needed after conversion. Every case that failed while being written failed
  because the case was wrong (a guessed order, a probe the app role cannot run, ties), and both
  servers agreed once the case was right.

| Test file                     | Tests | Converted                            |
| ----------------------------- | ----- | ------------------------------------ |
| tasks                         | 29    | 15                                   |
| tasks-verticals               | 38    | 30                                   |
| tasks-rename-recurrence       | 11    | 7                                    |
| tasks-drift                   | 4     | 4                                    |
| tasks-update-fixes            | 3     | 3                                    |
| tasks-web-contract            | 5     | 3                                    |
| tasks-suggested-status        | 9     | 2                                    |
| tasks-tools                   | 17    | 0 (16 call AI tools, 1 needs a step) |
| tasks-agency-tools            | 7     | 0 (all call AI tools)                |
| tasks-view                    | 4     | 0 (all plain functions)              |
| tasks-email-feedback          | 7     | 0 (outside)                          |
| task-summary                  | 5     | 0 (outside)                          |
| tasks-action-policy-self-heal | 5     | 0 (outside)                          |
| tasks-manage-share-regression | 2     | 0 (outside)                          |

The side-by-side suite now holds 67 cases in 8 files: the 64 converted tests and 3 smoke cases
written first.

## Cost of porting

### Rust next to the TypeScript it replaces

| Part                                            | TypeScript                           | Rust        |
| ----------------------------------------------- | ------------------------------------ | ----------- |
| Tasks logic that was ported                     | about 2,300 lines                    | 1,974 lines |
| Pieces every module will share, built once here | (in Fastify, ajv and the db package) | 1,233 lines |
| Unit tests                                      | (in the integration suite)           | 269 lines   |

- The Tasks logic counted on the TypeScript side is the ported part of `routes.ts`,
  `repository.ts`, `lists.ts`, `drift.ts`, `serialize.ts`, `preferences.ts`, the deferred-status
  part of `jobs.ts`, and the request schemas in `packages/shared/src/tasks-api.ts`. The split of
  the two partly ported files is an estimate.
- The shared pieces are sign-in lookup, the data context, error replies, Fastify-compatible body
  parsing, ajv-compatible validation, JavaScript-compatible dates, the job runner and the entry
  point.
- Rust came out at about 0.85 to 0.95 lines for each line of TypeScript.
- Matching Fastify's and ajv's error messages word for word took 564 of the shared lines.

### Effort

Measured from each agent's own session record. Output tokens are the tokens an agent wrote. A
reset is a cleared context window. The tokens an agent read are not counted, and they are far
larger. The two helpers read 7.0M and 9.6M tokens from cache while writing about 60,000 each.

| Work                                                                | Agent               | Output tokens         | Resets  |
| ------------------------------------------------------------------- | ------------------- | --------------------- | ------- |
| Rust Tasks server: 23 endpoints, shared pieces, the job, unit tests | Opus 5.5            | 307,772               | about 5 |
| Side-by-side runner and the 3 smoke cases                           | Opus 5.5            | 74,655                | 1       |
| Sorting all 146 tests and converting 64                             | Sonnet 5.5 helper   | 59,766                | 1       |
| Tasks screen in both frameworks, measurements, Herdr study          | Sonnet 5.5 helper   | 62,468                | 1       |
| Planted bugs, role check, counts and this report                    | Opus 5.5            | 194,567 before review | about 3 |
| Two review rounds                                                   | Sonnet 5.5 reviewer | 18,506                | 0       |
| **Total**                                                           |                     | **about 0.72M**       |         |

- The first row is the porting cost. It covers about 2,300 lines of TypeScript, so it is the unit
  the scaling below uses.
- About 62% of the Rust in that row is Tasks logic (1,974 of 3,207 lines, leaving out unit
  tests). The rest built pieces every later module reuses. A later module of the same size should
  cost about 0.19M output tokens, not 0.31M.
- One context window held about 50,000 to 60,000 output tokens of this work.

## Cost of the side-by-side runner

| Part                        | Size                                                                                | Output tokens                      |
| --------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| Runner                      | 1,307 lines (1,215 of Rust, a 54-line TypeScript launcher, a 38-line shell wrapper) | 74,655, with the smoke cases       |
| 64 converted cases          | 3,932 lines of JSON, about 61 per test                                              | 59,766, with sorting all 146 tests |
| Planted-bug and role checks | two shell scripts in `rust-spike/tools`                                             | in the last row of Effort          |

- The 14 TypeScript Tasks test files hold 4,787 lines for 146 tests, about 33 lines a test. A
  case runs about twice as long as the test it replaces, because JSON spells out every seed row
  and expected value.
- Converting cost about 930 output tokens for each converted test, counting the sorting.
- The runner still needs a few new step kinds before it covers everything Tasks tests.
  - A step that calls a module's AI tool on both servers (23 Tasks tests).
  - A step that queues a job and reads its payload (2 Tasks tests), once the Rust queue is
    chosen.
  - A step that runs SQL as the superuser, for tests that add a policy to prove a negative
    (task-summary 109).
  - A direct call to a module's query code on both servers, for the one test that filters in a
    way no route offers (tasks-tools 306).
  - Cookie sign-in, once the Rust server has it.
  - A tolerance check on fresh timestamps and a cross-check on ids, so the labels hide less.
- Each step kind is smaller than the runner itself, so all of them should cost about 0.1M to
  0.4M output tokens.

Scaled to the whole codebase:

| Part                   | Basis                                                                                                                                                                | Output tokens    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Runner as built        | measured                                                                                                                                                             | 0.07M            |
| New step kinds         | the list above                                                                                                                                                       | 0.1M to 0.4M     |
| Converting tests, low  | 29.3 times what converting Tasks cost (4,281 integration tests against 146), so the same 44% share converts                                                          | 1.8M             |
| Converting tests, high | about 90% of 4,281 tests convert, at 930 tokens each. In the ported part of Tasks, 89 of 100 tests go through HTTP or an AI tool, and 97% of the HTTP ones converted | 3.6M             |
| **Total**              |                                                                                                                                                                      | **1.9M to 4.1M** |

Both test counts treat a table-driven test (`it.each`) as one test. The integration suite has 175
of them. Each may become several cases, so the conversion rows may run somewhat low.

That is 2% to 11% of the port's 37M to 81M. The plan's stop line was a runner that costs as much
as the port.

## Scaled to the whole codebase

### Size of today's code

Counted at this commit with the commands under Evidence.

| What                                                                                                                                                 | Measured                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Production TypeScript                                                                                                                                | 474,668 lines in 2,485 files          |
| of which server code                                                                                                                                 | 339,867 lines                         |
| of which the plan's hard parts (chat, AI, CLI runner, module host and SDK, connectors and integrations, meetings, sign-in, agent protocol, Workshop) | 148,186 lines                         |
| of which API and worker entry points                                                                                                                 | 9,751 lines                           |
| of which other server code (modules, shared contracts, database helpers)                                                                             | 181,930 lines                         |
| of which screens (`.tsx` files and `web` folders)                                                                                                    | 109,238 lines                         |
| of which scripts and doc tooling                                                                                                                     | 25,563 lines                          |
| CSS (carries over)                                                                                                                                   | 38,432 lines                          |
| Integration tests                                                                                                                                    | 4,281 tests in 477 files              |
| of which in files that call the server in-process                                                                                                    | 1,870 tests in 176 files              |
| Browser tests                                                                                                                                        | 55 files                              |
| Tasks integration tests                                                                                                                              | 146, or 3.4% of all integration tests |

### The port, scaled

One unit is the Tasks port, about 2,300 lines of TypeScript. It cost 0.31M output tokens
including the shared pieces, and should cost about 0.19M once they exist (see Effort).

| Part                                                                             | TypeScript lines | Units          | Output tokens  |
| -------------------------------------------------------------------------------- | ---------------- | -------------- | -------------- |
| Ordinary server code (modules, shared contracts, database helpers, entry points) | 191,681          | 83             | 15.8M to 25.8M |
| Hard parts, at the Tasks rate down to half of it                                 | 148,186          | 64 to 129      | 12.2M to 40.0M |
| Screens                                                                          | 109,238          | 47.5           | 9.0M to 14.7M  |
| **Port total**                                                                   | **449,105**      | **195 to 260** | **37M to 81M** |

- Each row's low end uses 0.19M a unit and its high end 0.31M.
- The hard parts get a wider range because Tasks has none of their difficulty, such as streaming
  chat, child processes, outside services and long-lived sessions. Their high end assumes twice
  the cost per line.
- Screens use the server rate. The one screen built here came out smaller than its source (300
  lines of Leptos, from a screen spread over 1,224 lines in four TypeScript files that also hold
  parts not ported), but one screen is too few to rely on.
- At 50,000 to 60,000 output tokens a context window, the port is roughly 600 to 1,600 context
  windows.
- Tests of plain functions become Rust unit tests inside each unit's cost, as the 16 Rust unit
  tests did for Tasks.
- Scripts and doc tooling (25,563 lines) are left out because they are not the product. CSS
  carries over unchanged.
- The 55 browser tests carry over if the Rust screens keep the same page structure and class
  names.

## UI framework

Pick Leptos. The UI helper built the Tasks priority view in both frameworks against the real Rust
server: tasks grouped by priority, quick capture, a checkbox that completes a task, and due and
overdue dates drawn as the TypeScript screen draws them. Build steps and the full notes are in
`rust-spike/ui/README.md`.

| Measure                               | Leptos 0.8.23     | Dioxus 0.7.10     |
| ------------------------------------- | ----------------- | ----------------- |
| View code                             | 300 lines         | 272 lines         |
| Logic shared by both                  | 282 lines         | 282 lines         |
| CSS written                           | none              | none              |
| Dependencies                          | 228 crates        | 136 crates        |
| Clean release build                   | 80 s              | 44 s              |
| Rebuild after a one-line change       | 10.8 s            | 10.4 s            |
| Download, raw and gzipped             | 691 KB and 143 KB | 721 KB and 218 KB |
| First render, page and rows           | 40 ms and 62 ms   | 47 ms and 70 ms   |
| Enter adds a task, Space completes it | 56 ms and 28 ms   | 27 ms and 40 ms   |
| Latest release                        | 2026-10-31        | 2026-07-30        |

- Both load the same 334 KB of Moss CSS, flattened from the real token and Tasks stylesheets.
- Screenshots of the two are pixel-identical.
- Keyboard behaviour is identical. Tab reaches the capture field, Enter adds a task and keeps
  focus in the field, and Space on a checkbox completes the task and moves focus to the next row.
- Both wrote real rows. The database rows after adding and completing tasks were checked for
  each.
- The machine was at load 15 to 25 while timing, so the small differences are noise.

### Why Leptos

- Plan section 3.7 has the desktop app open the page Moss serves, and phones and LAN use the
  browser. So every user sees the web build, and on the web build the two tie on look, speed and
  keyboard.
- Leptos sends about a third less to the browser (143 KB against 218 KB gzipped). That matters
  most on phones.
- Leptos is the more mature web framework, and its server rendering with hydration is built in
  and widely used. This spike did not test it.
- Leptos updates only the parts of the page that change, which suits streaming chat. This spike
  did not measure that.
- The helper picked Dioxus because its first-party desktop mode shares view code with the web
  build. That mode runs the views as a native program inside a webview window, so desktop would
  become a second build with its own data path (the helper notes the browser fetch calls would
  have to be swapped). Under plan 3.7, desktop needs only a thin window around the served page,
  and that shell is the same small program whichever framework draws the page.
- The helper also wrote that Leptos is the better choice if phones on the browser matter more.
  In this plan they do.

### What Leptos costs

- Clean builds take about twice as long and pull in more crates. Rebuilds after a small change
  take the same time.
- Leptos components run once and update through signals, while React components re-render.
  Builders porting React screens need a short React-to-Leptos guide.
- The desktop shell is not part of Leptos. It would be a small Rust program on wry and tao, the
  same webview libraries Dioxus desktop uses. A Dioxus desktop probe built on this machine with
  them in 2 minutes 35 seconds, without libxdo, and ran for 6 seconds with an empty window.

## What Herdr teaches

The brief asked for a look at Herdr's app and core. Both are Rust.

- herdr-app is a native Rust app on GPUI with a Ghostty terminal engine, QuickJS mods and a
  staged updater.
- herdr-core is a small daemon on a Unix socket. It speaks JSON-RPC with stable error kinds and
  publishes an OpenRPC schema, with a released copy kept to guard compatibility. A separate holder
  process owns the long-lived terminals. State lives in JSON files written atomically, with no
  database.
- Worth copying into Moss:
  - a published API schema, with a released copy that changes are checked against
  - a separate holder process for long-lived work, such as agent sessions
  - atomic writes for any state kept in files
  - stable error kinds that clients can match on
  - a small core with a written rule about what belongs in it
  - staged updates
- Worth avoiding:
  - GPUI, which has no browser or phone story
  - mods without a sandbox
  - a local socket with no sign-in check
  - files instead of a database, given Moss's row security and several accounts

## Not proven

- **Linux only.** Nothing ran on macOS or Windows.
- **Features left out of the spike.** Recurrence, task breakdown, search interpretation,
  automatic execution, email feedback, suggested tasks, the task summary and the action policy
  were not ported. Their tests are counted as outside the ported part.
- **Browser sign-in.** The Rust server accepts the sign-in session as a bearer token only. The
  browser's cookie sign-in, rate limits and path-parameter checks were not ported. The 1 MiB body
  limit was ported and has a Rust unit test, but no side-by-side case.
- **The real job queue.** The Rust job runs on a small queue table made for the spike, not on
  pg-boss. The TypeScript side uses pg-boss. Plan section 3.3 still has to choose the Rust queue.
- **Load and concurrency.** Every case ran one request at a time.
- **Time zones.** Both servers ran in one time zone (America/Los_Angeles). Other zones were not
  compared.
- **What the labels hide.** Generated ids and timestamps within ten minutes of the case start
  are replaced with labels before comparing. A Rust bug that wrote a slightly wrong fresh
  timestamp would not show. Ids are labelled in the order they first appear, so a swapped id
  shows only when the order changes.
- **Server errors.** No case made either server fail with a 500, so those bodies were not
  compared.
- **Response headers.** Only status codes and bodies were compared. Content type, caching
  headers and cookies were not.
- **Tests not converted.** 23 tests that call AI tools, 10 plain-function tests, 2 tests that
  read job payloads and 1 that filters in a way no route offers have no side-by-side case yet.
  Two conversions are partial (tasks 765 and verticals 284).
- **Rows seeded by SQL.** The create route cannot set a position or the suggested status, so
  some cases insert those rows by SQL. Those rows skip the create code on both servers.
- **Job payloads.** No case reads a queued job's payload, so the rule that payloads carry only
  ids and small settings was not compared.
- **One screen.** The UI comparison used the Tasks priority view only. Streaming chat, large
  forms and drag and drop were not built in either framework.
- **Server rendering and the desktop shell.** Neither framework's server rendering with
  hydration was tried, and no desktop window opened the served page.
- **Phones.** No phone browser or slow network was tried.
- **Quiet-machine timings.** The UI timings ran at load 15 to 25.

## Side effects on the build machine

- The UI helper's toolchain install updated the user-wide rustup program to 1.29.3, because a
  fresh rustup home turns self-update on by default. `rust-spike/ui/README.md` now turns it off
  first. The newer rustup works the same. To go back, reinstall the earlier release from
  rustup.rs. The separate toolchain home sat in this task's scratch folder and goes with it.
- The browser used for screenshots ran Chrome with its sandbox off, on localhost pages only.

## How to proceed

**Go.** Tasks showed nothing Rust cannot do, so no re-plan is needed. The port is large but now
measured, and the runner that proves it is cheap next to it.

### Cost to plan for

- The port costs about 37M to 81M output tokens, roughly 600 to 1,600 context windows.
- The runner and test conversion cost about 1.9M to 4.1M output tokens on top.
- The low end assumes later modules port at the Tasks rate and reuse the shared pieces. The high
  end assumes no reuse and hard parts that cost twice as much per line.

### Risks and what each takes

| Risk                                                             | What it takes                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The hard parts port slower than Tasks                            | Port one hard part first in Phase 1, such as the CLI runner or chat, and re-scale with its measured rate      |
| 23 Tasks tests call AI tools, with no HTTP request to compare    | Add a runner step that calls a module tool on both servers and compares the results                           |
| 10 Tasks tests check plain functions                             | Port them as Rust unit tests beside the code                                                                  |
| No case reads a queued job's payload                             | Choose the Rust queue (plan 3.3) early, then add a runner step that reads job payloads on both sides          |
| Matching error text word for word took 564 lines                 | Match status codes and error codes exactly, and match message text only where a screen or API client shows it |
| The labels hide a slightly wrong fresh timestamp or a swapped id | Add a timestamp tolerance check and an id cross-check to the runner                                           |
| Cookie sign-in, rate limits and body limits are not ported       | Port them early and add cookie sign-in to the runner                                                          |
| Builders know React, and Leptos works differently                | Write a React-to-Leptos guide, and prove server rendering and the desktop shell before porting many screens   |
| The TypeScript app keeps changing                                | Freeze big features from Phase 2, as plan decision 7.1 says                                                   |
| Nothing ran on macOS or Windows                                  | Run CI on both from the first Rust commit                                                                     |

### Rules for every module port

- A module lands only with its side-by-side cases green.
- Rerun the planted-bug check whenever the runner changes.
- Report converted tests out of the total for each module.
- Keep the page structure and class names, so the 55 browser tests carry over.
