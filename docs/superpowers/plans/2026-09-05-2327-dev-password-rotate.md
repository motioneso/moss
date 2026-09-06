# Plan: rotate the dev login password and remove it from the repository (#2327)

Spec: issue #2327 body carries Ben's ruling directly; no separate spec doc. Not a UI/module
feature, so the module mockup gate does not apply.

## Seams check

- Four live test files hardcode the owner credential the same way:
  `const OWNER = { email: "ben@ben.com", password: "jarvistest123!" };` —
  `tests/live/food-926-uat.spec.ts:29`, `tests/live/integrations-2162-uat.spec.ts:15`,
  `tests/live/workshop-1888-uat.spec.ts:10`, `tests/live/workshop-1945-uat.spec.ts:15`.
- Existing convention for live-test env vars: `process.env.LIVE_*` with a default, and
  `test.skip(!X, "needs LIVE_X")` — `tests/live/integrations-2162-uat.spec.ts:17-21,52`.
- 25 files under `docs/superpowers/handoffs/*.md` plus `STATE-1759-1762.md` contain the password
  in prose (grep list captured this session; re-verify with the same grep before editing since
  this is a live shared checkout).
- Check-script convention: standalone `scripts/check-*.ts` run via `tsx`, wired into
  `package.json` `check:*` and into `verify:static` — e.g. `scripts/check-no-ambient-dates.ts`,
  `package.json:18,28`.
- Memory: two "always loaded" memory files carry the password —
  `/home/ben/.claude/projects/-home-ben-Jarv1s/memory/MEMORY.md:12` and
  `/home/ben/.claude/projects/-home-ben-Jarv1s/memory/dev-instance-lan-spinup-trusted-origins.md:18`.
  Older dated snapshot memories (pr1494 x2, spec-1698, ui-1394, ui-1392) also contain it but are
  historical records of past sessions, not live pointers — out of scope, left as-is (same
  treatment as the repo's own historical handoff docs, which get the password replaced with a
  sentence, not deleted).
- `~/.coord-briefs/` has no existing dev-credentials file; this plan adds one.

## Task order (must run in this order — rotating first strands every other agent)

**Task 1 — test files read credentials from the environment.**
- Files: the four live spec files above.
- Change each to:
  ```ts
  const OWNER_PASSWORD = process.env.LIVE_OWNER_PASSWORD;
  if (!OWNER_PASSWORD) {
    throw new Error(
      "Set LIVE_OWNER_PASSWORD to the development instance sign-in password before running this test."
    );
  }
  const OWNER = { email: "ben@ben.com", password: OWNER_PASSWORD };
  ```
- Owner email stays a literal (not a secret); only the password moves to the environment.
- Verify: `LIVE_OWNER_PASSWORD= tsx -e "require('./tests/live/food-926-uat.spec.ts')"` is not
  meaningful for a Playwright spec, so verification is instead: `grep -c jarvistest123
  tests/live/*.ts` → expect `0` for all four, and a manual read of each diff confirming the throw
  message names `LIVE_OWNER_PASSWORD`.

**Task 2 — scrub the 26 documents.**
- Replace each occurrence of `` `ben@ben.com` / `jarvistest123!` `` (and any inline variant found
  by grep) with a short clause: "the development sign-in details are kept outside the repository."
  Keep surrounding sentence structure readable — this is prose editing, not a mechanical strip.
- Do not delete any file.
- Verify: `grep -rl jarvistest123 docs/ STATE-1759-1762.md` → expect no output (exit 1 from grep,
  captured as `EXIT=$?` not piped).

**Task 3 — add the regression guard.**
- New file `scripts/check-no-dev-password.ts`, same shape as `check-no-ambient-dates.ts`
  (walk the repo, skip `node_modules`/`.git`/`dist`, report offending `file:line`).
- Two independent checks:
  1. The literal old password string (kept in the checker only, not reachable by casual grep of
     the checker's own diff — e.g. built from a short array of characters so this file itself
     does not carry the plain string as one contiguous token) must not appear anywhere else in
     the tree.
  2. A hardcoded sign-in password pattern: an object literal containing
     `email: "ben@ben.com"` (or any literal email) with a literal `password: "..."` in the same
     object — i.e. regex across a bounded window catching
     `email:\s*["'][^"']+["'][^{}]*password:\s*["'][^"']+["']` and the reverse order — fails the
     check. `password: process.env...` (no quotes around a literal) is allowed.
- Wire into `package.json`: `"check:no-dev-password": "tsx scripts/check-no-dev-password.ts"`,
  appended into the `verify:static` chain.
- Verify: `pnpm check:no-dev-password; echo "EXIT=$?"` → expect `EXIT=0` after tasks 1-2 land,
  and `EXIT=1` when temporarily reintroducing the old string in a scratch file (delete the scratch
  file after the smoke check, never commit it).

**Task 4 — rotate the password on the dev instance.**
- Only after tasks 1-3 are committed. Use `scripts/admin-reset-password.ts` (or whatever the
  existing admin path is — confirm by reading the script before running) against the dev instance
  (`192.168.50.36:5173` / API `:3000`), never port 1533.
- Generate a new password, do not print it to any file inside the repository or to a commit
  message.

**Task 5 — record the new password outside the repository.**
- Update in place (do not add a new file) `MEMORY.md:12` and
  `dev-instance-lan-spinup-trusted-origins.md:18` with the new password.
- Write a new file under `~/.coord-briefs/` (e.g. `dev-instance-credentials.txt`) with the new
  password and the date rotated.

**Task 6 — live proof.**
- Sign in to the dev instance UI with the new password by hand (or via the admin script's own
  verification) and note what was observed.
- Run at least one of the four live tests against the dev instance with
  `LIVE_OWNER_PASSWORD=<new password>` set only in the shell environment, never written to a file
  inside the repo. Capture exit code and post the command (with the value redacted) plus output
  summary on the PR.

## Kill gate

After task 3 lands and `pnpm check:no-dev-password` passes clean on the scrubbed tree, that is the
point to stop and confirm with the coordinator before rotating (task 4) — rotating is the
irreversible step. If the guard script itself is flagging false positives across the repo (i.e.
scope crept beyond the 26+4 files), stop and escalate rather than widening the regex under time
pressure.

## Verification commands (unpiped, exit code checked)

```bash
pnpm check:no-dev-password > /tmp/check-pw.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
grep -rl jarvistest123 . --exclude-dir=node_modules --exclude-dir=.git > /tmp/grep-pw.log 2>&1; echo "EXIT=$?"
```
Expected: all `EXIT=0` except the final grep, which must be `EXIT=1` (no matches) once the old
password string itself is no longer present in plaintext anywhere the guard's own obfuscation
doesn't hide it from a plain grep — the checker's self-reference must not reintroduce a plain
`jarvistest123` token, so this grep is the real proof, not the check script's own exit code.
