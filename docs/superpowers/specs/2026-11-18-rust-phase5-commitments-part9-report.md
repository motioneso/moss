# Commitments part 9 — package screen report

## Scope and design

JS-356 / Card 611 implements the November 18 approved option A: the Commitments section on Today, using the shipped Park Press brief, task-row, button and menu styles. Phone actions wrap beneath the text. There is no option B drawer or separate Commitments navigation/settings page.

The coordinator resolved the original scope question: general Rust chat runner tools and approval cards belong to a separate task. This part supplies the reusable review card and proves that its content comes from a saved record. Live chat proof **waits on the Rust chat tools and approval cards task**. The resolved AWAITING-BEN entry was removed.

## Implementation

- The verified Commitments package owns `/today`, including loading, retry, failed-write and empty states. Suggestions disappear only after a successful status write. Snooze supports tomorrow, next week and a chosen local calendar date.
- Today hosts a generic package section with the existing transferred-port module bridge. The shared bridge allows an explicit zero-height minimum for optional sections; other module frames retain their existing minimum.
- The reusable card renders the stored target, version and fields from `prepareCommitmentAction`; execution and one-use approval remain the future chat host's responsibility. Package app-map declarations describe the available Today review and the pending chat prerequisite.

## Live proof

The first completed live pass ran the signed packages from code commit `bb70cb6df` over non-loopback HTTPS on a reserved devports port. Four fictional email threads entered through the installed Email API, passed the unchanged debounce and production judgement worker, and became four saved pending suggestions using the local Codex sign-in proxy (`gpt-6.1-sol`). No intercepted or substituted network responses were used.

At 1440 × 1000, Today displayed all four rows, metadata and actions using the shipped styles. At 390 × 844, actions wrapped below each title without horizontal overflow; measured Accept, Snooze and Reject buttons were each 44px tall. Real browser captures are in the accompanying proof artifact.

Browser actions saved and survived reloads: Dana snoozed to December 1 (`2026-12-01T08:00:00.000Z`), Priya snoozed until tomorrow (`2026-11-20T08:00:00.000Z`), Kim accepted, Alex rejected. Pending counts fell from four to three to two to one to zero. After the final write and reload, the optional section was hidden with height zero and no horizontal overflow; desktop and phone Today captures were taken. No empty placeholder was added.

The real shared menu passed ArrowDown/Up, Home/End, Escape with focus restored to Snooze, Tab dismissal, outside-click dismissal and parent-frame blur dismissal. The phone last-row menu showed all three choices without clipping; the custom-date form was filled using its native calendar segments and submitted. Next week has unit coverage; its live write was not exercised.

Two real failures were reproduced and fixed during proof:

- Default five-second module calls timed out during real model judgement and produced no suggestions. Commitments now requests a bounded thirty-second call limit, following existing modules; the repeat produced all four suggestions.
- Before the menu packaging fix, the API held four pending records but the screen remained blank (`pending: 4`, `frameHeight: 0`). The package CSP blocked a script import outside its signed UI directory. The canonical shared menu is now bundled inside the package; CSP is unchanged. The repeat displayed the four rows (`frameHeight: 399` on desktop). Earlier blank captures were discarded as empty-state evidence.

Live gate receipt: `task_356_rust_port_phase_5_commitments_p-20261118-234827-RrIhMc.log`, one passed, final `rc=0`; the follow waiter returned exit `0`. The initial waiter process had ended with `143`; a fresh wrapper wait read the completed gate sentinel and returned `0`. Browser closed, fixture stopped and its port released.

## Corrected live repeat

The final code `fcc917e37` passed a fresh installed-server run (`task_356_rust_port_phase_5_commitments_p-20261119-001822-6AEMQw.log`, one passed, final `rc=0`, wrapper waiter exit `0`). It again produced four suggestions through the installed Email API and real Codex proxy worker. Fresh desktop and phone captures show the Email source on every row and no horizontal overflow. The empty state was measured before demo processing (`pending: 0`, hidden section, height zero) and captured at both sizes.

To exercise the exact expired-snooze bug without changing time or intercepting responses, a model-created Priya record was set through the real status API to `snoozed` until `2026-01-01T00:00:00.000Z`. The saved detail retained `snoozed`, while the pending list returned `pending_review`. After reload, Today rendered all four rows including Priya; the phone capture and actual rendered text verify that the saved expired snooze returned. The API write returned `200`. Priya was then accepted through the real button; rejecting the remaining rows brought the pending count down to zero.

A final reload's empty capture was attempted before loading finished; those captures are excluded from proof. The valid empty captures for this repeat are the initial zero-record state; the earlier complete pass separately verified the final empty state after saved actions and reload. No screenshot is claimed as evidence of keyboard handling or write persistence; the actual browser observations and API reads establish those behaviors.

## Checks

All checks below passed; actual exit codes were read, with no command piped through a filter.

- Commitments package gate at `fcc917e37`, clean tree: **47 passed** — nine UI, twenty-eight native Rust, six package and four installed tests. Includes separately preparing and rendering Accept, Reject and Snooze from a saved record. Receipt: `task_356_rust_port_phase_5_commitments_p-20261119-001902-g8rUxl.log`, final `rc=0` and waiter exit `0`.
- `node --test modules/commitments/ui/screen.test.mjs rust-spike/module-ui/web/bridge.test.mjs`: **30 passed** (nine screen plus twenty-one bridge), exit `0`, after the snooze and Email-label fixes; `/tmp/js356-node-corrected.log`.
- Focused ESLint: `today.mjs` passed after the menu fix; `api.mjs`, `view.mjs` and `screen.test.mjs` passed after the final review corrections (`/tmp/js356-lint-corrected.log`).
- Full un-piped `pnpm verify:static` on corrected code `fcc917e37`: **exit `0`**, `/tmp/js356-static-durable.log`, with the command's own exit receipt `/tmp/js356-static-durable.exit`. The receipt was read by a command that returned the same exit code. Includes lint, format, file sizes, design-system catalogue/classes/tokens, dependencies, migration checks, TypeScript and app-map generation. The preceding integrated static command reached the last step but its tool session returned `143`, so it is not counted as a pass; the durable rerun is the final verification. Earlier complete static runs also returned `0`.
- Real server screen gate: **one passed**, exit `0`, as detailed above. CI remains separate from these local results.

Repeat locally from `~/Jarv1s`: set `CARGO_HOME`, `RUSTUP_HOME` and an external `CARGO_TARGET_DIR`; launch the package or screen gate through `scripts/run-gate.sh start --gate test:rust-commitments` or `--gate test:rust-commitments-screen`, then use its printed log with `scripts/run-gate.sh wait --follow --log`. For browser proof only, set `COMMITMENTS_SCREEN_HOLD` to an outside-repository directory before starting the screen gate. The fixture writes `url.txt` there after real suggestions exist; finish the browser check, then create `finished` in that directory. The hold is bounded and opt-in; unattended checks finish themselves.

## Not proven

- Loading, failed loads and failed writes have unit coverage; they were not induced in the live browser.
- Next-week snooze has unit coverage; no live next-week write was performed.
- Live chat review waits on the Rust chat tools and approval cards task.
- A physical phone or a second physical device; the live browser uses a phone-size viewport over the non-loopback HTTPS origin.
- Real mailbox sync/OAuth; the demonstration uses fictional email content inserted through the installed Email package API.

## Independent review

Claude Sonnet, high effort, read-only round one reviewed the integrated commit `bf122b270`.

| Finding                                                     | Disposition                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Major: package version/changelog stale                      | Fixed in `3d1f931fa`: version `0.1.1` and a current entry.                                                                                                             |
| Minor: menu/focus lifecycle lacks automated coverage        | Keyboard, outside-click and blur checks passed in the real browser. Automated DOM lifecycle coverage remains a minor limitation.                                       |
| Minor: failed snooze focus / final empty-state confirmation | Failed snooze focus returns to its trigger. The final section still disappears, as approved; no extra empty placeholder or success panel was added.                    |
| Minor: viewport-relative resize                             | Added the document scroll offset.                                                                                                                                      |
| Minor: sandbox form/date retention                          | Forms allowed without same-origin permission; failed saves retain the date and the input has a future-date minimum.                                                    |
| Minor: missing layout styles / token                        | Replaced the unshipped `loose` hook with module layout CSS and removed the undefined z-index override. The future chat host supplies its shipped approval-card styles. |
| Minor: stored-card proof overstated                         | Each accept, reject and snooze card is now prepared separately from the actual saved record; the snooze field is asserted.                                             |
| Minor: app-map error never emitted                          | The declared error identifier is emitted on the actual UI error elements.                                                                                              |
| Minor: one removed detail breaks the list                   | A missing or already-reviewed suggestion is skipped; other failures still show retry.                                                                                  |
| Minor: failed-write retry label                             | The list reload is labelled “Reload suggestions”; the error says to repeat the action.                                                                                 |
| Minor: unattended proof hold                                | Browser hold is opt-in through `COMMITMENTS_SCREEN_HOLD`; unattended real-model checks can finish.                                                                     |
| Minor: Rust formatting noise                                | Removed the unrelated package-constructor formatting.                                                                                                                  |

Claude Sonnet, high effort, read-only round two reviewed `82cac75ed`, after main was integrated. It found one major and two minors:

| Finding                                                                                                     | Disposition                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Major: expired snoozes disappear because list normalizes status but detail retains `snoozed`                | Fixed in `fcc917e37`. Detail reads retain already-due snoozes and still skip a newly moved future snooze. A regression reproduces the real list/detail contract.                                                                     |
| Minor: Email source missing for judged threads without evidence rows                                        | Fixed in `fcc917e37`. A stored `threadRef` supplies the Email label without duplicating an existing evidence label.                                                                                                                  |
| Minor: generic Today host uses a Commitments-specific error identifier and lacks its own automated DOM test | Accepted below the must-fix bar: Commitments is the only section mounted by this host in this part. Generalizing another module's integration is outside this part; the real installed-package browser flow covers the current path. |

The same two regression checks fail against the original `82cac75ed` code and pass against `fcc917e37` (actual exits `1` then `0`). These isolated API/render tests do not replace the real browser proof. The interrupted earlier attempt produced no verdict and is not counted as a completed round.

The coordinator added a third review round. It reviews the final committed report and code. Its result is recorded on the reviewed commit with `herdr-task reviewed` and in the PR, so recording it does not modify the reviewed tree.
