# Build plan — #2021 read-only command approval hook

Part of #1424. Approved spec: the `SPEC` comment on issue #2021 (mined refusal evidence, approved
command list, path rule, full accept/reject test table). This plan carries only what that spec does
not: verified seams, exact signatures, task order, and verification commands. Do not duplicate the
spec here.

## Seams check — every assumption proved against this branch

| Assumption                                                      | Evidence on this branch                                                              | Verdict                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| No approved-command list exists in shared settings              | `.claude/settings.json` has no `permissions` key at all                              | still true               |
| A `PreToolUse` hook array for `Bash` already exists to extend   | `.claude/settings.json:9-19`                                                         | still true               |
| The new script does not exist                                   | `.claude/hooks/` holds only `check-gate-pipe.sh`                                     | still true               |
| Allow-decision JSON shape to emit                               | `packages/chat/src/live/claude-permission-hook.ts:113-121`                           | confirmed                |
| Test pattern: spawn the script, feed JSON on stdin, read stdout | `tests/unit/claude-permission-hook.test.ts:50-66`                                    | confirmed                |
| eslint lints `.claude/hooks/*.mjs`                              | `eslint.config.mjs:20-21` ignores only `.claude/worktrees/` and `.claude/workflows/` | true — must lint clean   |
| prettier checks `.claude/hooks/`                                | `.prettierignore:13-15` ignores only worktrees, workflows, skills                    | true — must format clean |

### Two spec premises that drifted

1. **`pnpm check:file-size` does not apply here.** `scripts/check-file-size.ts:10` puts `.claude` in
   the ignored-directory set, so the 1000-line limit never sees the new script. Keeping the file
   small is still the right call, but it is not an enforced gate. No spec change needed.
2. **The test cannot import a plain `.mjs` directly.** `tsconfig.json` sets neither `allowJs` nor
   `checkJs`, and `tests/**/*.ts` is inside the typecheck include list, so
   `import { … } from "…/allow-read-only.mjs"` fails `pnpm typecheck` with no declaration file.
   **Decision:** ship a hand-written `.claude/hooks/allow-read-only.d.mts` beside the script.
   Node-style resolution picks up the `.d.mts` for the `.mjs` specifier without turning on `allowJs`
   repo-wide. Steelmanned alternative — move the logic into a TypeScript file under `packages/` and
   have the hook import it — rejected because a `.mjs` hook cannot import TypeScript without a build
   step or a loader, and the spec's whole point is a dependency-free script the harness can run
   directly.

## Contracts

`.claude/hooks/allow-read-only.mjs` exports one pure function plus the runner:

```
export type ReadOnlyVerdict =
  | { readonly decision: "allow"; readonly rule: "read-only" }
  | { readonly decision: "none"; readonly rule: string };

export function decideReadOnly(command: string, cwd?: string): ReadOnlyVerdict;
```

`rule` on a `"none"` verdict names which guard stopped it (for example `"find-writes"`,
`"sed-in-place"`, `"path-outside-allowed-roots"`, `"unparsable"`, `"command-substitution"`,
`"redirection"`, `"assignment-prefix"`, `"git-subcommand"`, `"not-approved"`). Tests assert on that
name, so a rejection that lands on the wrong rule fails even though the outcome looks right.

Runner behaviour: read the `PreToolUse` payload as JSON on stdin. On `decision: "allow"`, print the
allow envelope shown at `packages/chat/src/live/claude-permission-hook.ts:113-121` and exit 0. On
anything else — including malformed input, a non-Bash tool, or an internal throw — print nothing and
exit 0. **The script can never deny.** A crash must read as "no opinion", never as a block, so a bug
in it can never stop a session from working.

`.claude/hooks/allow-read-only.d.mts` declares exactly the two exports above.

## Determinism boundary

Not applicable: no user-facing surface, no model output, no product UI. This changes only which
shell commands a build session may run without stopping to ask.

## Tasks (each commits green)

1. **Tokeniser and step splitter.** Quote- and escape-aware tokeniser; split on `&&`, `;`, newline
   and pipe; refuse (`"none"`) on command substitution, process substitution, background `&`,
   subshells, grouping, a leading assignment, and any redirection other than `2>&1` / `2>/dev/null`.
   Tests first.
2. **Path rule.** Relative with no `..` segment anywhere, or absolute under the request's working
   directory, `~/Jarv1s`, `~/Jarv1s-wt`, or `/tmp`. Every non-flag argument is treated as a possible
   path. Tests first — including `cat ~/.ssh/id_rsa` and `cat ../../etc/passwd`.
3. **Approved-command table.** The exact list from the spec, with the `find`, `sed`, `git` and `cd`
   restrictions. `awk` deliberately absent. Tests first — the full accept/reject table from the
   spec, each rejection asserting its rule name.
4. **Runner wiring plus settings entry.** Subprocess tests proving stdin/stdout wiring and the
   never-deny property; add the script to `.claude/settings.json` **after** `check-gate-pipe.sh`
   with a 5 second timeout.

## Kill gate after task 1

If the quote-aware tokeniser cannot cleanly reject the composed forms in the spec's reject list
(notably `grep -rn foo . && rm -rf build` and a piped verification gate), stop and report a blocker
rather than widening the approved list to compensate. Owner of that call: this lane, reported
through the fleet record.

## Verification — exit code always survives

```
pnpm format:check > /tmp/2021-format.log 2>&1; echo "EXIT=$?"     # expect EXIT=0
pnpm lint > /tmp/2021-lint.log 2>&1; echo "EXIT=$?"               # expect EXIT=0
pnpm typecheck > /tmp/2021-typecheck.log 2>&1; echo "EXIT=$?"     # expect EXIT=0
pnpm check:file-size > /tmp/2021-size.log 2>&1; echo "EXIT=$?"    # expect EXIT=0
pnpm test:unit tests/unit/claude-read-only-allowlist.test.ts > /tmp/2021-unit.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
```

A full `pnpm test:unit` is known to fail locally on the module-sdk-worker tests for an unrelated
reason and passes in CI; do not bisect this branch over it.

## Live proof

No product surface changes, so no browser run applies. The equivalent proof is the hand-run the spec
asks for: a fresh session on this branch runs approved commands with no approval prompt and rejected
ones still prompting, pasted onto the pull request.

## Release note

`Category: N/A` — nothing a user of the product can see.
