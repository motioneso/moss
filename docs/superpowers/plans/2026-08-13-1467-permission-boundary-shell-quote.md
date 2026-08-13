# Plan — #1467: permission hook receives empty notes-roots on every containerized deploy

**Issue:** #1467 (task). No separate spec doc — handoff explicitly scopes this as a bug fix off the
issue text; this is not a new feature/module, so the spec-before-build gate doesn't apply.
**Risk tier:** security (permission boundary + shell-quoting on a live chat surface).
**Branch:** `1467-permission-boundary-shell-quote`, off `origin/main` @ `198928da4`.

## Root cause (verified against this branch — matches issue text, nothing drifted)

- `packages/chat/src/live/claude-permission-hook.ts:120-126` (`roots()` inside
  `CLAUDE_PERMISSION_HOOK_SOURCE`) and `:337-339` (`vaultRoots()` inside
  `CLAUDE_ONE_SHOT_PERMISSION_HOOK_SOURCE`) both read `process.env.JARVIS_NOTES_ROOTS` directly,
  with no `resolveMossEnv` fallback and no value injected on the command line.
- `packages/cli-runner/src/sanitized-env.ts:14` `ALLOWED_KEYS` — confirmed neither
  `JARVIS_NOTES_ROOTS` nor `MOSS_NOTES_ROOTS` is present. The tmux server forks with this
  sanitized env, so both spellings are stripped before the hook's child process starts.
- `packages/chat/src/live/vault-allowlist.ts:19` already does this correctly app-side —
  `resolveMossEnv(process.env, "JARVIS_NOTES_ROOTS")` plus the same filter chain — because it runs
  in the app's module graph, not the standalone `.mjs`.
- Fix shape (per issue, confirmed sound): resolve roots app-side where `resolveMossEnv` works, and
  inject them onto the hook's command line the same way `JARVIS_PERM_URL` /
  `JARVIS_PERM_TOKEN_FILE` / `JARVIS_SESSION_ROOT` already are — `shellQuote`d, so an operator-set
  root string can't smuggle shell metacharacters into the `PreToolUse` command line.
- `apps/web/src/settings/settings-vault-chooser.tsx:156` — user-visible recovery string still says
  `JARVIS_NOTES_ROOTS`; issue flags it as in-scope to update to the current (`MOSS_`) spelling.

## Task 1 — `vault-allowlist.ts`: extract and export `resolveVaultRoots()`

File: `packages/chat/src/live/vault-allowlist.ts`

```ts
export function resolveVaultRoots(): string[]
```

- Moves the existing `resolveMossEnv(...).split(",").map(trim).filter(nonEmpty).filter(isValidVaultRoot)`
  chain (currently inlined in `vaultReadOnlyToolPatterns`, lines 19-23) into this new exported
  function.
- `vaultReadOnlyToolPatterns()` keeps its exact current signature and behavior, reimplemented as
  `resolveVaultRoots().flatMap(root => [...])`.
- No change to `isValidVaultRoot` or `VAULT_ROOT_CHARSET` — reused as-is (defense-in-depth stays).

**Test (`tests/unit/vault-allowlist.test.ts`):**
- New case: `resolveVaultRoots()` returns `["/data/external-notes"]` for a clean root, and `[]` for
  each of the existing DENY fixtures (`) Bash(*` injection, `..`, relative, double-slash,
  whitespace, bare `/`) — same fixtures already in the file, called directly against the new export
  instead of only through `vaultReadOnlyToolPatterns`. Fails today because `resolveVaultRoots`
  doesn't exist.
- Existing `vaultReadOnlyToolPatterns` tests must still pass unmodified (proves the refactor didn't
  change externally-visible behavior).

## Task 2 — inject `JARVIS_NOTES_ROOTS` into both hook command lines

File: `packages/chat/src/live/claude-permission-hook.ts`

- Import `resolveVaultRoots` from `./vault-allowlist.js`.
- Add a private helper (co-located with `shellQuote`):

```ts
function vaultRootsEnvEntry(): string[]
```

  Returns `[]` when `resolveVaultRoots()` is empty; otherwise a single-element array
  `` [`JARVIS_NOTES_ROOTS=${shellQuote(resolveVaultRoots().join(","))}`] ``. Omitting the entry
  entirely when there are no configured roots keeps `roots()`/`vaultRoots()` inside the generated
  `.mjs` behaving exactly as they do today for an unconfigured vault (empty string → `[]`).
- `writeClaudePermissionHook`: splice `...vaultRootsEnvEntry()` into the `command` array between
  `JARVIS_PERM_TOKEN_FILE=...` and `"node"` (line ~49-50).
- `writeClaudeOneShotPermissionHook`: splice `...vaultRootsEnvEntry()` into its `command` array
  between `JARVIS_SESSION_ROOT=...` and `"node"` (line ~265-266).
- No change to either `ClaudePermissionHookOpts` / `ClaudeOneShotPermissionHookOpts` — roots are
  resolved from env at write-time, not passed in, matching how `JARVIS_SESSION_ROOT` already works.
- No change to the `.mjs` source templates (`roots()` / `vaultRoots()` stay reading
  `process.env.JARVIS_NOTES_ROOTS` — now populated because the parent injects it — with their
  existing `validRoot()` filtering kept as defense in depth, per the issue's explicit "keep it"
  instruction).

**Tests (`tests/unit/claude-permission-hook.test.ts`):**
1. "injects a shell-quoted JARVIS_NOTES_ROOTS into the persistent hook command when a root is
   configured" — set `process.env.JARVIS_NOTES_ROOTS = "/vault"` before calling
   `writeClaudePermissionHook`; assert the generated `command` string contains
   `JARVIS_NOTES_ROOTS='/vault'`. Fails against current code: the string is absent entirely today.
2. "omits JARVIS_NOTES_ROOTS from the persistent hook command when no root is configured" — leave
   the env unset; assert `command` does not contain `JARVIS_NOTES_ROOTS`. Guards against a
   sloppy fix that always injects (including an empty `''`), which would be harmless but noisy and
   untested-for.
3. "drops an invalid/injection root before it reaches the command line" — set
   `process.env.JARVIS_NOTES_ROOTS = "/vault) Bash(*,/ok"`; assert `command` contains
   `JARVIS_NOTES_ROOTS='/ok'` and does **not** contain `Bash(` or the raw `)` — proves filtering
   happens app-side via `resolveVaultRoots` before injection, not left to the hook alone. This is
   the test that would have caught a naive fix that interpolated the raw env value unfiltered.
4. Same three cases mirrored for `writeClaudeOneShotPermissionHook` (roots-set / roots-unset /
   invalid-filtered), asserting against its `command` string the same way.
5. End-to-end via the existing `runHook`/`runOneShotHook` harnesses: spawn the generated `.mjs`
   with `JARVIS_NOTES_ROOTS` **only reachable via a command-line assignment** (i.e. build the full
   `command` string with `writeClaudePermissionHook`/`writeClaudeOneShotPermissionHook`, run it
   through a shell rather than passing `env` directly to `spawn`) and confirm a `Read` under the
   configured root still gets `"allow"` — this is what actually proves the fix restores the
   pre-approval fast path end-to-end rather than just asserting on the string.

## Task 3 — user-visible string

File: `apps/web/src/settings/settings-vault-chooser.tsx:156`

Change `set JARVIS_NOTES_ROOTS, and recreate the container.` →
`set MOSS_NOTES_ROOTS, and recreate the container.`

No test — copy-only change; covered by existing render/snapshot tests if any touch this string
(grep confirms none do).

## Determinism boundary

N/A — no model turn, no chat UI feedback involved. This is a deterministic permission-hook /
env-plumbing fix.

## Kill gate

None needed — single-phase, mechanical fix scoped to two files plus one string. If task 2's
end-to-end test (case 5) cannot be made to pass, stop and escalate to the coordinator before
touching anything else; that would mean the root cause is wrong, not that the fix needs more code.

## Verification

```bash
pnpm --filter @moss/chat exec vitest run tests/unit/claude-permission-hook.test.ts tests/unit/vault-allowlist.test.ts > /tmp/1467-unit.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, all new + existing cases passing.

```bash
pnpm format:check > /tmp/1467-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1467-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1467-typecheck.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0` for each.

Full gate at wrap-up per `verify-gate` skill (isolated gate DB), plus the live-path proof from the
handoff's exit criteria (a real notes read through the UI on live dev, pre-approved with no
permission card, vs. today's card/deny — screenshot on the PR).

## Open questions

None — issue text, sanitized-env allowlist, and both hook templates were read directly and match
the issue's description exactly; no assumption needed an owner.
