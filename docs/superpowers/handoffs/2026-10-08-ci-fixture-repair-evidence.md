# Connected CI fixture repair

Scope: two existing browser fixtures on scheduled/proactive integration. Runtime, APIs, migrations, app-map declarations, name assertions and provider-connect behavior are unchanged.

## Settings navigation

At verified integration `04bcabc42d0a802d2512323381ef13285c75af6f`, the original desktop Settings test failed with expected 10 navigation buttons and actual 11, matching CI run `37879232898`, job `113654846393`. The accepted Alerts & quiet hours entry accounts for the extra destination.

The fixture now expects 11 and asserts that the exact Alerts & quiet hours destination is visible. All existing navigation/group/history/admin assertions remain. The full `settings-shell.spec.ts` suite passes 10/10. A temporary added-label probe used an abbreviated label and failed; it was corrected to the shipped label before the successful full run.

Local browser execution uses a private Playwright configuration equivalent to the repository configuration with one worker, claimed port 5182 and captures disabled. This suite intentionally uses its existing API mocks; it is fixture regression evidence, not installed runtime proof.

## Assistant name

The unseeded `solo-admin` fixture could pass its original assertions before the capability query settled. In the first installed run the assertions completed, then an after-test diagnostic incorrectly queried after logout and received 401; that diagnostic failure is excluded from original-red evidence.

A temporary passive `page.waitForResponse` listener was registered before the existing chat-button click and awaited the real `/api/ai/capability-route/chat` response before the unchanged composer assertions. Response: HTTP 200, `route.available: false`, `route.reason: "needs-config"`. The original `Message Alfred` visibility assertion then failed with no matching element after its existing 10-second expectation window. The bounded DOM showed `Chat with Alfred`, `Alfred Not connected`, and `Connect a provider` links to the assistant Settings pane. No response was intercepted or rewritten.

The committed fixture opts into the existing `chatScript: "phase1-smoke"` seed path. It registers a passive capability-response wait before the chat click, requires HTTP 200 and `route.available: true`, then verifies the drawer's public `Here when you need me` status before all existing assistant-name, aria-label, placeholder, sidebar, title, persistence, sign-out and fresh-context assertions. The stale comment claiming no UAT level can seed a chat model is replaced with the actual fixture and proof boundary. There is no model turn.

The existing no-model UI behavior is retained; the `chat-ready-state.spec.ts` regression suite checks that no model means no textbox and a keyboard-accessible provider Settings link at desktop and phone sizes. Existing seed tests cover both unseeded `solo-admin` selecting no chat model and scripted `solo-admin` selecting a chat-capable model, with provider cleanup.

## Verification and boundaries

Source freeze: `6ef69faa0e2605f891a9de4cdade26b1d583da0d`, based on verified integration `04bcabc42d0a802d2512323381ef13285c75af6f`. The final documentation commit does not change these tested source bytes.

The formerly retained `uat-3129-fa397bcb5` image was absent from the Docker daemon. A uniquely tagged image was rebuilt from the current integration runtime using existing dependencies: `uat-ci-fixtures-04bcabc42`, image `sha256:c0dc56134fb99eaa418496a4e009669c801f8b62e1c37493ad6f3821da08d8a2`. The two changed host-side spec paths are excluded from the image build by `.dockerignore`; runtime and seed input bytes remain the integration bytes. A task-owned stopped reservation retains the new image for integration verification. No shared image or service was modified.

Independent Standards and Spec reviews both cleared the final source pin `6ef69faa0e2605f891a9de4cdade26b1d583da0d`; review reports are retained privately under `ci-fix/standards-review.md` and `ci-fix/spec-review.md`. The final scoped gate exited 0, including the actual installed assistant-name path. Private temporary runner bytes are separately hashed because ignored node_modules executables are outside the gate's Git input fingerprint.

No chat reply, held-calendar copy or branch-wide CI readiness is claimed.

Full static verification completed via `pnpm verify:static` at the clean final source pin in the earlier combined gate. Its original sequential runner used `set -euo pipefail` and advanced to the subsequent unit command, establishing static stage exit 0; that overall gate later exited 1 from the inherited-port unit harness error. Its overall receipt is not called green.

The final private `ci-fixture-suites` executable supplied to `scripts/run-gate.sh start --gate ci-fixture-suites` runs, in order:

```bash
env -u JARVIS_UAT_CLAIMED_WEB_PORT pnpm exec vitest run tests/uat/run-uat.test.ts tests/uat/provisioner.test.ts
pnpm test:uat-seed
pnpm exec playwright test --config /tmp/moss-scheduled-implementation/ci-fix/settings.config.mjs settings-shell.spec.ts chat-ready-state.spec.ts
pnpm ci-assistant-name
```

The private `ci-assistant-name` executable delegates to the existing `withMeetingUatEnvironment` wrapper, which launches `node --import tsx tests/uat/run-uat.ts moss-assistant-name.uat.spec.ts` with the existing wrapper's test environment. It uses `JARVIS_UAT_BUILD=0`, the image tag above, `JARVIS_UAT_CLAIMED_WEB_PORT=5182`, and `MOSS_UAT_CAPTURE_OFF=1`. Database checks run only through `run-gate.sh`; each gate and installed UAT provisions its own disposable database/runtime.

Private input SHA-256 values are retained with the exact delegate and config contents under `/tmp/moss-scheduled-implementation/ci-fix/`. The Git fingerprint covers the clean source commit; the private input digests separately cover the executable and config files it does not include.

The first frozen source candidate `f575226f6` received a green Standards review, but Spec review found that the ready-status text alone can appear while capability lookup is pending. The final six-line correction requires the actual capability response before checking the original UI assertions. The earlier candidate is not presented as fully cleared.

The initial combined gate at `f575226f6` exited 1 at `check:migration-numbers`: it counted the unchanged local Main-chat migration against the identical migration in open integration PR #3154. Earlier checks had passed; type and suite checks had not run. The completed static stage uses the migration checker's existing `GITHUB_HEAD_REF=integration/scheduled-proactive` destination identity so it excludes that PR's own migration while retaining checks against other open PRs. No migration or checker source was changed.

Private input digests for this final run:

| Input                                      | SHA-256                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Final scoped suites runner                 | `28e7dc65094c2041784a5fbde69ba6e681a0378fe7dd672e07606fd16942c974` |
| Historical full-static stage runner        | `71aa5525f40271f4d9cde311aa37b34c449982546ebd9be48ac8eb786b66e915` |
| `ci-assistant-name` launcher               | `043c047b4eecebaf098571c614cc438b54c31634b3193f0632d82ff0f026acc5` |
| Existing-wrapper delegate                  | `029238be6eb3c645099a15197573bf87cdcf57db039bda821cbda55d8d71c308` |
| Claimed-port capture-off Playwright config | `d33c686f155e1e431b52cc7474c48c330c6d22a625a467b701c98c0652b6b4ed` |

No branch-wide CI, full unit/integration gate, real-provider reply, or held-calendar copy is certified by this fixture repair. The existing calendar test records a note when no held block is seeded; no new skip was added.

A subsequent combined run at the final source pin passed full static verification but four UAT-runner unit tests received the installed proof's inherited claimed-port variable. The private runner now unsets that variable only for those unit tests, preserving their default-option assertions and the later installed proof's claimed port. This is a private harness correction; no public test assertion or runtime source was changed. Earlier combined runs ending with exit 1 are not certified as green.

Final receipts, all at clean source `6ef69faa0e2605f891a9de4cdade26b1d583da0d`, Git fingerprint `e92da49741bd3d3ccd4850a7858ef01d8e4b939067f3020403192f697ba35565`:

| Check                                               | Private receipt below `/tmp/moss-scheduled-implementation/ci-fix/` | Result                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Full `pnpm verify:static`                           | `gate-final/jarv1s_scheduled_ci_fixtures-20261008-205918.log`      | Static stage exit 0; overall historical bundle exit 1 at later unit harness error                              |
| Corrected scoped unit/seed/browser/installed bundle | `gate-suites/jarv1s_scheduled_ci_fixtures-20261008-210546.log`     | Terminal exit 0: 31/31 units, 29/29 seed tests, 16/16 mocked browser tests, 4/4 installed assistant-name tests |

Toolchain: Node `v22.22.2`, pnpm `10.6.2`, disposable pgvector/Postgres `17.11`. Static includes root and test TypeScript checks, web/external module type checks, formatting/lint, size/design/UI checks, package/migration checks and app-map generation. The merger will run fresh full static verification on its assembled commit; this repair does not reuse a whole failed gate as green.

Installed project `uat-3260677_264e8e0d` exercised the real Settings persona save, fresh sign-in, actual chat capability lookup (HTTP 200, available), named drawer/composer/placeholder/sidebar/tab, sign-out with cached identity, reload, and fresh signed-out default identity. All four tests passed in 10.1 seconds, and the gate terminated with exit 0. This is actual UI/API proof of the identity fixture; no model turn, response interception, screenshot, or rewritten result was used.

Cleanup: disposable UAT containers/volumes/networks and all task gate containers were removed. Playwright closed its browser/server; claimed port 5182 was released. Task-local temporary executables and browser output were removed from the worktree using recoverable trash; their exact contents/digests remain in private evidence for reproduction. The coordinator retains the stopped `ci-fixtures-image-reservation-04bc` container and its image for assembled integration verification. The source worktree is clean; only this evidence document is added afterward.
