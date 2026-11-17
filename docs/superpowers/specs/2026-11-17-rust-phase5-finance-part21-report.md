# Finance bank connect and sync (part 21) report

Part of the Phase 5 plan in `2026-11-13-rust-phase5-meals-finance-wellness-and-rest-plan.md`. This section is in its own file because the shared report is at the 1000 line limit.

### What was built

- Connecting a bank. Starting makes a hosted bank page address and queues a delayed check.
  Finishing the check saves the bank, keeps its sign-in token only in the host store, and pulls
  the first accounts and transactions.
- Syncing. Balances, one balance snapshot per account per day, and transactions, read page by
  page with a saved place to resume. A read that changes under the sync is restarted up to three
  times. Modified and removed transactions apply. A person's own category and note stay, and a
  changed amount puts the transaction back in front of them. Manual entries are never touched.
- The six-hour sweep, scheduled for each person when a bank connects, and a run-now tool and
  route. Each bank is handled alone, so one failing bank never stops the others.
- Reconnect state. A bank that needs a new sign-in is marked as such, keeps its data, and starting
  again reconnects that same bank with no second copy.
- Two tables (bank links, pending link sessions), two job queues, three tools and six routes
  (three plain, three chat). App Map entries for the feature are in the manifest.
- Test-only helpers. The server has a debug-only setting that sends bank calls to a stand-in on
  this machine, and refuses it in a release build. The stand-in now also fails one bank on
  request, pages its answers, restarts a read once, and delivers changes.

### Proof

| Check                                                                              | Result                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Connect, two-page sync, mid-read restart, modified and removed transactions        | passed against the stand-in                                                                                                              |
| A failed bank through the six-hour sweep, and a reconnect                          | passed: failing bank marked, other bank unaffected, data kept, one bank row after reconnect                                              |
| Stored job rows                                                                    | ids only, no token, key or bank text                                                                                                     |
| Two people plus an admin on the bank tables                                        | passed; with security removed the admin and second person saw bank rows and a sync reached another person's bank (RED), restored (GREEN) |
| Planted bank account name in the connect activity row                              | the privacy scan failed, restored                                                                                                        |
| Guest tests (6 new): reply shapes, statuses, job dispatch                          | passed native; the same code runs in the packaged WebAssembly component in the installed and live tests                                  |
| Live run: real server, real routes, HTTPS on a non-loopback address, stand-in bank | passed: connect, sync, failed bank, reconnect, second person saw nothing, no token or bank text in the log, jobs or activity             |
| Reachable from another device                                                      | passed, same live run (certificate-checked HTTPS, sign-in, trusted origin)                                                               |

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-finance
```

```
scripts/run-gate.sh start --gate test:rust-finance-live
```

### Deliberate differences from the old code

- The old first check told the person to run a sync next. The new check runs the first sync
  itself and the text says so.
- Activity rows hold ids and codes only.
- Connection sessions live in a table, not the old key-value store, and a finished or abandoned
  session is deleted.

### Not proven or not built

- **The real bank.** Only the stand-in was used. The real bank pass is part 36.
- **Update-mode sessions that finish with no public token.** Real Plaid behaviour is unchecked.
- **Categorizing new transactions, merchant rules and AI tiers** belong to part 22.
- **The sharing mirror** is part 25. **Provider handoffs** and the old admin-only environment
  override are not built.
- **The old sync lease.** Two runs at once are safe to repeat, but the later one wins the saved
  resume place.
- **Parity against the running old code.** Shapes and statuses were checked against the old
  handlers' source, not run side by side.
- **Crates.** No new crates were needed.
