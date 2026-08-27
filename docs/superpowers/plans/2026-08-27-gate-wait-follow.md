# Plan — issue #2020: non-blocking gate wait

Spec: SPEC comment on issue #2020 (posted by motioneso). Task issue: #2020, parent #1424.

## Seams check (file:line, verified on this branch)

- `scripts/run-gate.sh:385-413` — `cmd_wait` loops with `sleep 15` inside a `timeout` deadline
  (default 540s) and returns exit 3 once the deadline passes, printing "call wait again". No
  `--follow` flag exists yet.
- `scripts/run-gate.sh:52-56` — header comment for `wait` tells the agent to "pass an explicit
  tool timeout of 600000 ms" — the exact wording the spec says must go.
- `.claude/skills/verify-gate/SKILL.md:21-24` — step 2 block says "Pass an explicit Bash tool
  timeout of 600000 ms" then calls `scripts/run-gate.sh wait` in the foreground.
- `.claude/skills/wrap-up/SKILL.md:77` — inlines `scripts/run-gate.sh wait  # Bash tool timeout: 600000 ms`.
- `.claude/skills/coordinated-wrap-up/SKILL.md:47-48` — same foreground `wait` with the 600000 ms
  instruction.
- `.claude/skills/coordinated-qa/SKILL.md:70` — same foreground `wait` with the 600000 ms
  instruction.
- `.claude/skills/start/SKILL.md:110` — only names `start` -> `wait` -> `status` by reference to
  verify-gate, no inlined blocking wording of its own. Per spec, leave unless it also inlines the
  600000 ms line — confirmed it does not, so no edit needed there.
- `.claude/skills/coordinate/SKILL.md` — already says waits are event-driven; spec says leave as
  is.
- `tests/scripts/test-coordinator-watchdog.sh` — existing pattern for a standalone bash test: no
  test framework, fakes external commands via a `PATH`-shadowed fake binary, asserts on output/
  exit code. Not wired into `package.json` or CI — these `tests/scripts/*.sh` files are run by
  hand, matching how `test-coordinator-watchdog.sh` and `test-backup-retention.sh` already work
  (confirmed: no reference to either file in `package.json`, `scripts/test-unit.ts`, or any
  workflow file).
- `tests/unit/install-herdr-script.test.ts` — existing pattern for a content-check test: reads a
  script/doc file as text with `readFile`, asserts with `toContain`/`not.toMatch`. Runs under
  `pnpm test:unit` (`scripts/test-unit.ts` discovers `tests/unit/**/*.test.ts` via vitest).

No spec premise has drifted; all cited files match the spec's description.

## Task 1 — `scripts/run-gate.sh`: `--follow` mode for `wait`

- Add `--follow` boolean flag to `cmd_wait` (function at line 385). When set, the loop never
  returns 3 for timeout — it keeps looping (same sentinel check, same `sleep 15`) until `verdict`
  returns 0, 1, or 2. The existing bounded `--timeout` (default 540s) behavior is unchanged when
  `--follow` is not passed.
- Update the header comment block (lines ~52-56) to document `--follow` and to change the
  agent-facing instruction from "pass an explicit tool timeout of 600000 ms" to: launch
  `scripts/run-gate.sh wait --follow` as a single Bash call with `run_in_background: true`, no
  foreground timeout needed.
- No signature/CLI changes to `start`, `status`, `stop`.

Test cases (behavior + why they'd fail against a broken implementation):

- Fake gate finishes after ~2s; `wait --follow` run with a 1s poll interval override returns 0
  without ever hitting a timeout path. Fails against current code because current code has no
  `--follow` flag (usage error) and, if the flag were silently ignored, would still time out and
  return 3 on a slow-enough fake gate.
- Plain `wait` (no `--follow`) against a fake gate still running after its timeout still returns 3
  with the existing "call wait again" text. Fails if `--follow` changes are implemented by
  deleting the bounded path instead of adding a new one.

## Task 2 — skill docs

Edit each file below to replace the two-step "start, then foreground `wait` with a 600000 ms tool
timeout" recipe with: launch `scripts/run-gate.sh wait --follow` as one Bash call with
`run_in_background: true`, keep working, then read the exit code (0/1/2) from the background
call's result instead of a separate `status` call.

- `.claude/skills/verify-gate/SKILL.md` (canonical — do this one first, precisely)
- `.claude/skills/wrap-up/SKILL.md`
- `.claude/skills/coordinated-wrap-up/SKILL.md`
- `.claude/skills/coordinated-qa/SKILL.md`

No changes to `.claude/skills/start/SKILL.md`, `.claude/skills/coordinate/SKILL.md`, or
`.claude/hooks/check-gate-pipe.sh` (out of scope per spec).

## Task 3 — shell test

New file `tests/scripts/test-run-gate-wait-follow.sh`, following the
`test-coordinator-watchdog.sh` pattern (plain bash, `set -euo pipefail`, fakes commands via a
`PATH`-shadowed dir, `mktemp -d` + `trap ... EXIT`).

- Fake `docker` (only needs to answer `inspect` truthily and swallow `exec ... psql`) so `start`
  does not need a real Postgres.
- `--gate` pointed at a fast fake pnpm script (e.g. a `pnpm` shim on the fake `PATH` that just
  `exit 0`s quickly) so no real 15-25 minute gate runs.
- Runs `scripts/run-gate.sh start --gate <fake>`, then runs
  `scripts/run-gate.sh wait --follow` in the background (`... &`) and asserts (via `wait "$pid"`
  in the test, not the tool) it returns exit 0 once the fake gate finishes, with a single call —
  no loop in the test that re-invokes `wait`.
- Asserts plain `wait` (no `--follow`) with a short `--timeout` against a fake gate that sleeps
  longer than the timeout still returns exit 3.
- Ends with `echo "run-gate wait --follow tests passed"` matching the existing file's convention.

## Task 4 — content-check test

New file `tests/unit/verify-gate-skill-doc.test.ts`, following `install-herdr-script.test.ts`'s
pattern (`readFile` + `describe`/`it` + `toContain`/`not.toMatch`).

- Reads `.claude/skills/verify-gate/SKILL.md`.
- Asserts it contains `--follow`.
- Asserts it contains `run_in_background`.
- Asserts it does **not** match `/600000\s*ms/`.

## Verification

```bash
bash tests/scripts/test-run-gate-wait-follow.sh > /tmp/rg-wait-follow.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

```bash
pnpm test:unit -- tests/unit/verify-gate-skill-doc.test.ts > /tmp/rg-wait-follow-unit.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

Pre-push trio + full gate (via the `verify-gate` skill, backgrounded) before wrap-up:

```bash
pnpm format:check && pnpm lint && pnpm typecheck > /tmp/rg-wait-follow-pretrio.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

## Manual real-run proof (spec's "what done looks like", item 3)

After the code lands: start an actual gate in this worktree with
`scripts/run-gate.sh start --gate test:unit` (a real but short pnpm script, not the full
15-25 minute `verify:foundation`, to keep the proof itself fast), then launch
`scripts/run-gate.sh wait --follow` as one backgrounded Bash call. Confirm exactly one completion
notification arrives with the correct exit code, and that other tool calls were made in between
(proving the turn was not blocked). Record the command, exit code, and the interleaved work in the
PR's live-path evidence.

## Kill gate

None needed — this is a single-phase, additive, non-UI change (new flag plus docs plus tests). If
the seams check above turns up a drifted premise before Task 1 starts, stop and re-plan; otherwise
proceed straight through.

## Determinism boundary

N/A — no model-facing or user-facing UI surface is touched. This is agent-tooling documentation
and a shell script flag.
