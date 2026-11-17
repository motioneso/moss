# Rust Phase 5: Meals, Finance, Wellness and the rest report

Part of https://github.com/motioneso/moss/issues/4027. This report follows the plan in
`2026-11-13-rust-phase5-meals-finance-wellness-and-rest-plan.md`. Each part adds its own section
here as it is built.

## Goals chat tools and Today data (part 5)

Task JS-290, Card 604. Release note Category: N/A.

### What was built

Part 4 already supplied the signed registry package, both owner-only tables, the three unchanged
legacy SQL files and the five goal routes. This part reuses those route handlers and adds:

- The five existing tools: list goals, read one goal, create a goal, change a goal and add
  evidence. Replies retain the old `data` envelope. Reading a goal returns its ten newest
  evidence summaries, with only the kind, source label and summary in each entry.
- A signed-in tool transport at `POST /api/m/goals/goals/tools/run`. It crosses the existing
  trusted host tool service before running the handler. Writes require a one-use approval for
  the same person, tool and exact inputs. Read tools follow the host's saved approval policy.
  Nothing supplied in the request can grant approval.
- A signed-in Today data call at `GET /api/m/goals/goals/today`. It filters the existing ordered
  goal list to active goals, matching the old Today section. It returns an empty list when no
  active goal belongs to the person. This part adds no screen.
- Package feature entries describing the tools, approval refusal and Today data.

The first installed tool and live-server runs refused even approved inputs. The host preserves
JSON field order when it fingerprints approval; the guest had sorted those fields. Enabling
`serde_json`'s existing `preserve_order` feature keeps the incoming order across the component
boundary. The same installed test failed before this change and passed after it. No crate or
crate version was added; the lock file only connects existing dependencies to this feature.

The evidence-on-closed-goal refusal introduced in part 4 also applies through the tools. This is
the same documented difference from the old handlers, rather than a new write path.

### Differences and limits

- Writes use the Rust host's one-use approval instead of the old automatic install grant.
  Read tools follow the host's saved policy. Legacy approval-card presentation text is not
  ported in this part.
- Extra tool input fields are refused. The old tool schemas allowed extras.
- Host failures share the fixed unavailable-or-approval reply. That keeps private host errors
  out of responses, but does not distinguish every failed write from missing approval.

### Proof

- Native guest tests exercise tool writes and reads, the ten-evidence limit, active-state
  filtering, second-person refusal, validation and fixed error wording. The WebAssembly
  component runs through the real host against fixture rows, rather than a native substitute.
- The installed component's five tool replies are compared with the existing TypeScript tool
  handlers on a disposable database. Generated ids and timestamps are masked; all other fields
  are compared. Tool writes are then read through the real routes. The earlier fourteen-step
  route replay remains in the same gate.
- Both table owner rules are checked with a second person. The same privacy assertion fails
  when each policy is replaced with an open rule, and passes after the owner rule is restored.
  A separate administrator also gets no private goal or evidence through tools or Today.
- Planted goal and evidence text is absent from stored job payloads and real host activity.
  The error-text assertion is run with its fixed-message protection removed, and the activity
  assertion with request logging deliberately added. Each fails with the protection removed;
  each passes again after restoration. The control script restores source even if a control
  fails. The manifest allows no job, model or network capability.
- The live gate installs the signed package and calls all five tools and Today through the
  real Rust HTTPS server. It uses real fixture account sign-in, verifies the certificate and
  origin, refuses an untrusted origin, checks missing sign-in and approval, reads tool-created goals through routes, checks
  consumed approval, and verifies a second account cannot read them. No response is intercepted
  or rewritten. The planted text is absent from the server log.

Commands run from `~/Jarv1s`, with task-owned `CARGO_HOME`, `RUSTUP_HOME` and
`CARGO_TARGET_DIR` in scratch storage. All commands below expect exit code **0**:

```bash
scripts/run-gate.sh start --gate test:rust-goals
scripts/run-gate.sh start --gate test:rust-goals-live
pnpm typecheck
pnpm check:file-size
```

The Goals gate includes the native tests, component build, package tests, installed tests and
source-removal privacy controls. Both builds execute tool tests: native fixture tests and real
installed-component database tests. Changed TypeScript files also pass ESLint; changed supported
files pass Prettier and changed Rust files pass rustfmt checks. The proof artifact records the
actual command output and the independent review.

### Not proven or not built

- No Today screen or chat approval screen. The Today screen is part 6; this part supplies only
  its data. A full chat conversation is not exercised; tools are called through the real host
  service and HTTPS transport using a fixture's trusted approval grant.
- No Memory sync or reconcile jobs. The task explicitly limits this part to tools and Today
  data, despite the broader plan's background-job row mentioning part 5. The package declares
  no queues. Account export and deletion remain as listed in the part 4 report.
- No physical phone, laptop or tailnet check. The live gate uses the real HTTPS server through this machine's
  non-loopback network address, with sharing enabled only on its disposable fixture. This part has no screen and does not establish second-device acceptance.
- No private user records or production database are used. No Workshop or Food work, global
  install, or new Rust crate is included.

## Goals package skeleton (part 4)

### What was built

- A new registry package in `modules/goals`, in the same shape as the finished News and
  Backtrack packages. The manifest declares the two goal tables, the three old SQL files under
  the core-legacy ledger, the five routes, and the app map entries (the settings entry and the
  two feature entries). No screen is in this part, as the plan says.
- The five routes from the old app: list goals, create a goal, read one goal, change a goal
  (marking it completed or archived closes it), and add evidence to a goal. Answers keep the
  old field names and shapes, including the old wording for refused requests.
- Evidence on a closed goal (completed or archived) is refused with a 409 answer. The plan
  asked for this refusal. The old TypeScript routes had no such check, so this is the one
  place where the Rust package is stricter than the old code, taken from the plan's wording.
- Clearing a text field on a goal stores an empty string, as the old server did. The parity
  replay below caught this, and the Rust code now matches it.
- The host's frozen list of old SQL now names the two goal tables. The old Goals manifest
  never listed its tables, so the freeze script names them directly, the same way it already
  does for Calendar.
- Chat tools, the memory sync jobs and the Today section are later parts (5 and 6) and are
  not in this package. The manifest declares no job queues, no model call and no network use.

### Proof

- Route parity: the installed-package test replays 14 steps against the old TypeScript routes
  on the same gate database and compares every answer, with ids and times masked. It passed.
- Row level security: a second person reads no goals through the routes or directly in the
  database. Replacing the owner rule with a wide-open rule in the same test let the second
  person read the goal, and putting the owner rule back shut them out again. It passed.
- Closed goal: after a goal is marked completed, adding evidence answers 409. It passed in
  the native tests, the installed-database test and the live run.
- Private text: a planted marker in a goal title, evidence and progress text appears in no
  job payload, no second person's answer, no error body and no server log. The package makes
  no job, model or network calls at all, and a test checks every host call it does make.
- Both builds: the crate's tests pass natively (5 tests), and the same code built as
  WebAssembly passes the host package tests (6 tests) through the real component host.
- Live run: the packaged module was installed through a signed test registry and served by
  the real Rust server over HTTPS. Two signed-in people created, read, changed and closed
  goals through the real route path, with nothing intercepted or rewritten.

Commands, all through `scripts/run-gate.sh` (expected exit code 0):

```bash
scripts/run-gate.sh start --gate test:rust-goals
scripts/run-gate.sh start --gate test:rust-goals-live
```

### Not proven or not built

- No screen. The Goals section on Today is part 6 and needs Ben's agreement first.
- No chat tools and no memory sync. Those are part 5.
- No account export or delete section for the goal tables. The plan gives that to no Goals
  part yet, so it is listed here as not built.
- Nothing was checked from a phone or a second device. This part has no screen, so there
  was nothing to look at from another device.
