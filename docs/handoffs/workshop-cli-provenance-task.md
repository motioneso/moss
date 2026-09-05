# Workshop CLI credential provenance — R1b checkpoint

Open task: #2277. Worktree: `~/Jarv1s/.claude/worktrees/workshop-phase-a-0904`.
All changes remain uncommitted. Workshop CLI composition and execution remain disabled.

## Implemented

Settings validates the clicked CLI configuration before begin/poll/submit/cancel, including kind,
assistant purpose, usable status and explicit authenticated actor ownership. The server-derived
`ProviderLoginScope` reaches all four RPC verbs. Runner handle reuse/poll/submit/cancel requires
an identical actor/configuration scope. UI cancellation retains scope even when begin finishes
following unmount. Existing unbound onboarding remains supported without Workshop provenance.

Bound Claude login now bypasses global readiness and uses a unique fresh HOME and tmux socket.
A fixed per-flow tmux config excludes ambient config and retains the pane after immediate CLI
exit. The setup-token process runs through `env -i` with explicit fresh HOME/config and no
credential environment. Its successful captured token is validated by an uncached, bounded
subprocess using only that credential/context, with tools/hooks/MCP/session persistence disabled.
Validation kills its own process group on cancellation, deadline, output overflow and parent exit;
real inherited-group descendant and unrelated-peer checks pass (see the live-state continuation).
Echoed pasted credentials cannot become fresh provenance. Polling cannot extend the hard lifetime.

Only a still-current validated flow can publish the scoped credential. Actor/configuration maps
through a server-generated SHA256 path in a namespace ordinary login cannot populate. The final
renames and terminal commit are synchronous to fence cancellation. Chat's legacy token file is
updated for compatibility and restored if scoped rename fails. This is **not a crash-atomic
two-file transaction**. A failed restore retains backup data. Private flow cleanup and startup
sweeps target only service-owned fresh contexts; unresolved cleanup retains admission.

Source generation requests an owner-only provider query against `app.current_actor_user_id()`.
The verified row's actor/configuration identity reaches the CLI adapter and the required source
RPC scope. The runner derives the scoped credential path itself. Missing or foreign scoped
credentials fail without global fallback. The concrete source model remains required and its
returned identity/policy are checked by the existing source output validator.

## Evidence

- 157 tests passed across eight suites, including actual socket RPC and synthetic executables:
  `/tmp/workshop-fresh-source-unit-02.log`. Initial non-escalated run encountered only the known
  sandbox Unix-listener restriction; the authorized socket-capable run passed.
- Final 36-test subset passed after adding two further cases: cancelled late start cannot disturb
  a newer flow, and malformed/missing source scopes fail before host dispatch. This subset also
  proves polling cannot extend the hard deadline. `/tmp/workshop-fresh-source-final-races.log`.
- Actual tmux plus fake CLI proof: `tests/uat/workshop-confinement-probe/fresh-login-proof.ts`.
  `/tmp/workshop-fresh-login-source-proof.log` proves fresh login → immediate-exit capture →
  token validation → exact scoped source generation, concrete model identity, and foreign
  actor/config denial despite a valid global token. Ambient tmux config did not execute. All
  proof-owned sockets, source process/home and login home were cleaned. No vendor calls.
- Isolated DB/API gate passed **19 tests** including authenticated owner-only credential lookup.
  `/tmp/jarv1s-gate/workshop_phase_a_0904-20260905-022946.log`, sentinel `### FINAL rc=0`, and own DB
  removed. Verdict: `/tmp/workshop-fresh-source-gate-verdict.log`.
- Root TypeScript, scoped ESLint/format/whitespace pass. Logs:
  `/tmp/workshop-fresh-source-tsc-final.log`, `/tmp/workshop-fresh-source-lint-final.log`,
  `/tmp/workshop-fresh-source-races-lint.log`, `/tmp/workshop-fresh-source-format.log`.
- Both independent reviews report no remaining blockers. Review fixed ambient tmux config,
  immediate-exit pane lifetime and legacy-token rollback. File-size check still flags only the
  known unrelated sports files; runner host remains 997 lines.

## Remaining acceptance and next work

The synthetic chain is implemented and verified; **actual vendor login and deployed provider
behavior remain unproven**. Do not enable Workshop CLI composition from these fixtures or infer
production credentials from the legacy token. Codex 0.144.5's previous negative control exposed
native tools, and Gemini now has installed model-resolution/native-OAuth evidence, including refresh and
missing-selected-HOME credential denial (see live-state and probe README). Remote MCP discovery
now has a passing deny-all allowlist/exclusion candidate that preserves remote-admin fetching;
actor/config-bound Gemini login is now implemented with synthetic process proof (details below),
and actual vendor/deployed behavior remains unverified. Keep both source providers unavailable.

Do not redo the completed identity/fresh-capture/source-consumption implementation. The next
continuation should audit the approved Workshop plan against these completed R1a–R1d/M1/M2/R1b
capability results and identify the next authorized offline implementation, preserving the R1e
live authority, installation/promotion, deployment and execution-enablement gates. No human or
vendor testing was performed, no shared service was restarted, and no issue was closed.

## Gemini fresh login continuation

Bound Gemini sign-in now uses a unique fresh HOME/tmux socket, no global readiness shortcut,
explicit minimal environment and the installed source restrictions. Native OAuth/account state
is read through the bounded no-symlink reader. A 25-second, 16-KiB authenticated user-info check
requires a verified email equal to the native active account; it chooses no feature model and
exposes no raw OAuth failures. Cancellation and the existing hard login lifetime fence completion.

The shared publication helper updates ordinary native files before the scoped terminal record,
rolls earlier renames back on failure and attempts all restores, retaining failed backup data.
This is process-local rollback, not crash-atomic multi-file storage. Ordinary unbound login keeps
its original path. The app map reflects fresh Claude/Gemini Settings sign-in. Synthetic account
and actual tmux/process evidence: `/tmp/workshop-fresh-gemini-process-proof.log`, rc0; shared
regression: `/tmp/workshop-fresh-gemini-regression.log`, 76 tests. No real browser/vendor login.

The Gemini source factory now awaits a private native credential snapshot while checking output,
rejects original or refreshed token echoes, and returns that accepted snapshot for version-fenced
publication. Installed source cases pass in `/tmp/workshop-gemini-fresh-policy-proof.log`, rc0.
Next: compose the existing bounded source subprocess lifecycle with Gemini policy and scoped
refresh publication; source RPC still rejects Gemini. Preserve all execution/deployment gates.

Shared source lifecycle is now implemented and synthetic-verified in `CliSourceEngine`, with
runner-owned scoped credential selection and Gemini refresh callback. Claude's source route uses
it; Gemini RPC still rejects. See the latest live-state entry for 14 lifecycle/RPC tests, 8 routing
tests, static checks and the rerun actual fresh-login/tmux proof. Pinned installed Gemini engine
composition now passes four cases (model selection, native refresh, forced-tool rejection and
cancellation after refreshed authentication) in `/tmp/workshop-gemini-installed-engine-secret.log`.
The nine OAuth controls also pass in `/tmp/workshop-gemini-oauth-regression-0905.log`.

Independent review found one credential reconstruction bug: checking only raw JSONL missed tokens
split across assistant deltas or Unicode-escaped in source JSON. Final normalized JSON is now checked
against original and refreshed access/refresh/ID tokens before source acceptance or publication.
Eleven policy/store/engine tests pass in `/tmp/workshop-gemini-secret-regression.log`; the independent
recheck is clear. Reports: `docs/reviews/2026-09-05-workshop-r1b-standards.md` and
`docs/reviews/2026-09-05-workshop-r1b-spec.md`. Real vendor/browser login and deployed Gemini RPC remain
unverified; Codex policy remains unsupported. Preserve dispatch and execution/deployment gates.
