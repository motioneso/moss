# Current Firefox window and replacement persistence: r7 launch packet

Task #3578 / parent #3577; dispatched by the [window handoff](../handoffs/2026-10-23-moss-computer-window-persistence.md).
Codex `/root`, session `01a169de-aa02-7990-a145-aadb18a73dbe`, is active automated finish operator.
Independent reviewer `/root/independent_review` has no authorship. One supervised real-path run only,
after this packet is committed and exact-artifact independent readiness review accepts it.

## Entry, identity and authority

Fresh read-only entry began 17:46 UTC, completed within ten minutes. Initial available RAM
18,588,028,928 bytes, root free23,544,020,992, data free1,009,882,464,256; Moss running healthy.
Required floors RAM/root8GiB and data30GiB passed. The adopted image tag was absent. Actual retained
archive size1,026,041,856 and SHA256
`48cdd56f8d026af02c873513d36c86ab48b3b9e0b169cefe7a4f2ab7a1ceb4f9`, config identity and all seven
layer digests matched; independent reviewer returned PASS_RESTORE_READY. One bounded load exited0,
and inspect matched that config/layer list. No rebuild, substitute, restart, prune or host repair.
Image disappearance and reported Herdr restart causes remain UNKNOWN; no infrastructure investigation.

Exact image `sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`, Linux/amd64,
noVNC1.3/Websockify0.13/TigerVNC1.12/Xfce4.18/Firefox ESR153.5.1. Fresh run `persistence-r7`, private
sibling `../moss-computer-persistence-r7/`, distinct initially empty home/socket and unique file/bookmark.
Fresh one-day synthetic CA/server/owner/foreign identities. `devports claim moss-computer-persistence-r7`
reserved loopback5188 anew; no previous reservation was reused. Prior r6 and other homes/scripts/
receipts/archive are untouched. Public documentation uses canonical `~/Jarv1s`; raw paths/logs/keys
remain private. Branch `fix/moss-computer-window-persistence` retains checkpoint `f59ddc98f` plus committed
handoff `89b5230b7`. Live PR checks: #3588 and #3587 remain open draft, #3579 merged. Draft child base
is `qualify/moss-computer-persistence` (#3588), preserving the pending parent chain.

## Diagnosis and bounded correction

Ranked falsifiable hypotheses, recorded before corrections:

1. Browser replaces its window during tab transition: rediscovery should find a valid new XID.
2. Focus moves to another Firefox window/dialog: title/class and actual profile-process identity
   distinguish it before input.
3. Firefox/backend exits: bounded live tree, process and browser/backend logs show absence/failure.

R6's lost-window cause remains UNKNOWN. No sandbox or persistence failure is inferred.
`node ../moss-computer-persistence-r7/window-test.mjs` reproduced the cached-ID failure at the private
transition seam (one synthetic BadWindow, before log retained), then passed rediscovery of window202,
second-identical-command-error stop at exactly2, expected not-ready separation and immediate assertion
failure. This is a focused harness regression, not a reproduction of the unknown Firefox event.

Only r7 window discovery/error handling/failure diagnostics change. Every title wait rediscovers
visible Firefox candidates, checks WM_CLASS, actual parent binary and designated --profile args;
no XID crosses a tab/title wait. Actual input still uses noVNC keyboard. Expected empty search/file
not-yet-created observations return false. Command failures are retained separately; the second
identical normalized command/error stops immediately, without timeout inflation. Other exceptions
fail immediately. A failure captures bounded current window tree/active client list/title/class/PID,
process list, last browser/terminal log lines and last80 backend lines before fallback teardown.
No screenshots, viewer upgrade, security weakening or reusable proof-tool expansion.

## One real-path acceptance sequence

1. Check every manifest hash. Independent watchdog must be alive with a healthy first sample before
   Compose launch. Inspect exact image/user/default protections/resources/mounts/network. Re-run
   current-image access controls and unchanged assertions with mTLS removed, Origin removed, and
   byte-exact restoration: expected driver cases0/1/1/0. Synthetic identities are not Moss owner auth.
2. Fresh installed Playwright/ws from `~/Jarv1s/package.json`, no broad dependency install. Actual
   current UI/RFB synchronous predicates; attached visible/intersecting canvas >=100x100 and >=10
   sampled colours. Initially absent designated file gets exact unique bytes through viewer input.
   Host only prepares/activates terminal; all commands/bookmark/browser actions traverse viewer keys.
3. Real Firefox ESR with dedicated `/home/desktop/.mozilla/firefox/moss`, initially absent database,
   packaged offline fixture and unique URL/title. Verify fixture title/address; create bookmark with
   Ctrl+D/name/Enter. Keep fixture tab alive while second tab visits about:support. Fresh clipboard
   sentinel must be replaced. Assert binary/profile, BPF/thread-sync/content sandbox true, effective6;
   preserve User Namespaces=false/EPERM limits. Parent executable/environment mandatory; capture
   actual file/web tab content processes (not RDD/socket) with extra seccomp filters beyond parent.
   Unreadable child fields explicit; absent core diagnostics reject. No disable flags/overrides,
   including zero sandbox level. Clipboard setter output remains redirected.
4. Clean Firefox close through actual viewer Alt+F4/confirmation; require real parent disappearance,
   empty/absent WAL and exact read-only SQLite bookmark/file bytes. On disposable copies only, first
   require identical pristine assertions to pass, then tamper file or delete exactly one bookmark:
   unchanged assertion must fail at intended signal. Verify original home hashes unchanged.
5. Stop/remove exact guest; capture exits/timestamps and old full-ID absence. Recreate distinct full
   ID from same exact image and resolved designated home, keeping gateway. Before reopening Firefox,
   require identical file/main-DB hashes. Reload viewer, require fresh current substantive frame/input.
6. Open actual Firefox at about:blank, reopen bookmark through `* token` browser UI, assert exact URL,
   rendered fixture title and retained file readback. Repeat active sandbox/process evidence, clean
   UI close and SQLite/file checks. Recheck replacement isolation. Every gate must pass for PASS.

## Supervision, failure and active cleanup

Unchanged guest UID1000/network none/Unix socket,2CPU/4GiB/512PIDs; separate trusted Nginx bridge
0.5CPU/128MiB/32PIDs, loopback5188, synthetic mTLS/exact Origin. Read-only roots, dropped caps,
no-new-privileges/default seccomp/docker-default AppArmor, bounded tmpfs/logs. No devices/Docker socket/
production mounts. Sampled isolation is not universal certification; browser sandbox is a distinct gate.

Exact watchdog fallback label `com.moss.proof=persistence-r7`, <=1800s deadline, heartbeat90s,
nominal5s sampling. Fail closed on measurement/log failure, RAM/root below8GiB, data below30GiB,
home/socket reaching10GiB. Monitoring is not quota; host browser/daemon outside caps. Fresh resource
floors apply before load/launch and throughout; failed gate stops with no wait/retry/reclamation.

Runner bounds launch40s/access90s/harness420s; actively finishes well before60min. Shared lifecycle
lock and stop intent reject new mutations; dead/zombie supervisor rejects starts. Emergency exact-label
kill/verify still runs if lock setup fails; no old label fallback. Capture full guest/gateway IDs,
numeric operation/watchdog exits, resource/closure receipts. On failure, live diagnostics precede
fallback browser SIGTERM; no diagnostic copy counts as clean UI flush or replacement.

Close actual Firefox/owned host browser; stop watchdog/services; remove only owned containers/network,
listener/reservation and fresh synthetic identity files. Preserve all homes/archive/receipts. Owned
host PID/start/group identities and timeout descendant cleanup retained. Cleanup or port-release
failure cannot PASS. Independently verify no owned runtime/listener/reservation, healthy Moss and exact
final evidence. Commit/push and open draft child PR; return narrow PASS or evidence-backed rejection
plus one next proposal. No automatic second run, merge, issue close, production or owner integration.
Idle sleep/wake, manual MacBook, downloads/Internet/installer/platform/release and News/Direct On gates
remain separate. No product behavior/app-map change.

## Exact launch artifacts

Private references resolve below `../moss-computer-persistence-r7/`; credentials reviewed privately.

| Artifact                        | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `compose.yaml`                  | `b4da6c4a56b57afc26efd73a2f53cc18f21cc2f86d68580dede308f9f3ba95a9` |
| `.env`                          | `4de642b7a51a1ac610f2feccd8715ecb3d774575b71ad6b9b955ac993b8c7041` |
| `gateway/nginx.conf`            | `285d0b3a705aba8dffa751614cd3a0aa7b12a34b75e71e89aaab5f0dec2ca21e` |
| `supervise.py`                  | `0ad1b7e38d61f7018632ee0cbdaba2f3094529783e67e569ad3a71d6777e4510` |
| `access-check.mjs`              | `80bbad111ec8afb93c6d71351d4c30794b758ef19329c394db77255552718d97` |
| `access-controls.py`            | `17a183950491c630eb9bb4230e448e68b4af11a6c28308573deb5224b06b9628` |
| `isolation.py`                  | `2727729f5e7827adb13dd400033871041a12d7d69d8e53f71973128c56e08d94` |
| `process.py`                    | `2ede92bae11e2fca8ccf611534d27bbfaf08311e63ed13e06732a38d92f9f5c7` |
| `check-state.py`                | `50eb76dccb2ab4af6a6998d6fe0787d4eb606eca0971d0a3dffab34b0d5ae83c` |
| `controls.py`                   | `c9e56dc2a2502a3fd5bab625e9549a42c767f3a16a91a75a8c484059c44ade18` |
| `persistence.mjs`               | `3f9aedc564fb741bdec11b308e3da4f6312db9003788ade030ac86d4f88db555` |
| `window.mjs`                    | `42699e01f2a2764c4ebd035248470c4b4780598b181aa4b8011cd3c59840897c` |
| `window-test.mjs`               | `f68328b08caed9c6d3515ee58b8fcd997e5d7e61d99ea1ea191eff2da823f2c5` |
| `diagnostics.py`                | `d78e0e28a87c383ce2c9d2a003f57ae0a4eee6e9e34607df7f6ddfa050ce0e51` |
| `run.py`                        | `b982bd3673457e3fee2783502baa7179e75e7c1671870f0144b56b19022e21ae` |
| `proof.json`                    | `471024dae85e4a749d79c5c258f3a20f8bda93267f485b1332e91c9d6d11851d` |
| `receipts/resolved-config.json` | `cf59dfb249415d9a20e763a5b5aac5e263e0228da2535871128c9f0d0bfe42f3` |
| `mutate.py`                     | `e8396dbe945be53f0563f5957d7b3354bb2b8a3b250afa9e2407e4a738d4308e` |

## Prelaunch correction

The first static candidate `071a27801` was NOT_READY: author and independent reviewer found that
`terminal(command)` shadowed the new command adapter. No runtime was launched. The actual terminal
call-site VM regression failed with TypeError, retained in `receipts/terminal-before.log`; parameter
renamed to `input`, and the full focused regression passes. Exact revised hashes above supersede
the first candidate. Reviewer acceptance must name this amended commit and manifest.
