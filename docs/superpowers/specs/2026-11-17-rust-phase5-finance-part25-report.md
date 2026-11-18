# Finance reports, sharing, activity and undo (part 25) report

Part of the Phase 5 plan in `2026-11-13-rust-phase5-meals-finance-wellness-and-rest-plan.md`. This section is in its own file because the shared report is at the 1000 line limit.

### What was built

- Sharing a bank account with the household. A person flags an account and the package keeps a
  copy of an allowed set of fields in two new tables. Other people read only that copy. Notes,
  review state, the Moss guess and its confidence, balance history and bank link details are never
  copied. Unflagging, or removing the account or a transaction, removes it from the copy.
- A new table rule in the host, "household read". Any signed-in person can read the two copy
  tables, and only the owner can write them. The old finance tables stay owner-only.
- Shared accounts and their transactions appear, marked with the owner, in the account list and
  the monthly transaction list of the other people. They are left out of duplicate and
  needs-a-look checks.
- Reports. Monthly spending (the person's own, with each other person's shared accounts listed
  apart), net worth over time (never shared), and the transactions behind one report figure.
- Export. A spreadsheet of the person's own history, for all dates, a range or one account, with
  the formula-safe quoting, a 5000 row limit and a 2 MiB limit that answer with the count.
- Activity list and undo. Undo covers a category choice, a rule, a new category and an archive.
  Each undo record holds ids only and is refused if anything moved on since.
- Archiving a category that holds no budget money. Income and transfers are protected.
- Three new tool names, eleven routes (eight plain, three chat), five App Map feature entries in
  the manifest, two SQL files (0371 and 0372) and a version bump to 0.5.0. The Finance manifest is
  now exempt from the file size check, as part 24 also does.

### Proof

| Check                                                                                                                      | Result                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two people on the copy tables, the old tables and the copy being written                                                   | passed; with row-level security removed the second person read the owner's ledger, forged a copy row and changed another person's copy (RED), restored (GREEN)                                  |
| What the other person sees of a shared account                                                                             | name, balance, category and amount only; notes, official name and review state absent in routes and in the copy (the real-database test caught the copy keeping the official name, now removed) |
| Export checked for another person's rows                                                                                   | passed: with both people sharing, each export holds only that person's rows                                                                                                                     |
| Private text (account name, merchant, note, official name, amount) in stored job rows, activity rows and the activity feed | none found, with the markers confirmed present in the ledger                                                                                                                                    |
| Guest tests (16 new): sharing, reports, export, undo, archive                                                              | passed native; the same code runs in the packaged WebAssembly component in the installed and live tests                                                                                         |
| Live run: real server, real routes, HTTPS on a non-loopback address, stand-in bank                                         | passed: sign-in, a shared account seen by the second person only as allowed, export of own rows only, unshare, over HTTPS with certificate checks                                               |
| Reachable from another device                                                                                              | passed in the same run: a non-loopback HTTPS address with certificate checks, sign-in, and an untrusted origin refused                                                                          |

From the repo root, through the gate script:

```
scripts/run-gate.sh start --gate test:rust-finance
```

```
scripts/run-gate.sh start --gate test:rust-finance-live
```

### Builds

Native tests and the packaged WebAssembly component both ran: the guest tests native, and the installed and live suites load the component.

### Deliberate differences from the old code

- The old module had no HTTP routes for these. The route paths are new, so route parity means the
  tools and their behaviour match the old handlers, read from their source.
- The copy is refreshed in the same request that changed the data, and after sync jobs. The old
  code queued a separate job.
- Undo of a new category is stricter. Any budget amount, transaction or split that uses it blocks
  the undo.
- Activity rows hold ids only. Summaries are built when read, from current names and amounts.

### Not proven or not built

- **Hiding shared rows from people whose account is switched off.** A database policy cannot test
  that, so it is not built. Any signed-in person can read the copy tables.
- **Undoing a budget change.** The new budget rows hold no amounts, so there is nothing to put back.
- **The Moss guess step for categories** is not built. Category choices by rule and by hand are.
- **Undo of a rule** restores the category only, not the rule's other settings.
- **Transfer correction behaviour** beyond what parts 20 to 23 built.
- **Parity against the running old code.** Shapes and statuses were checked against the old
  handlers' source, not run side by side.
- **Install-time SQL check.** The two new SQL files follow the allowed shape, and the gate installed
  them, but no separate run of the strict validator was made.
- **Cost of the copy refresh** on accounts with very many transactions. Each refresh compares every
  row of a flagged account. It was not measured on large data.
- **Manual accounts** cannot be shared.
- **A failed copy refresh** is dropped without a log or retry, so after a failed refresh other people can keep seeing removed rows until a later change succeeds. Not built: a retry job.
- **Category names in the shared copy.** The copy holds the owner's category id, so another person's report shows the id or nothing rather than a name.
- **Undo of a categorize** does not check whether the transaction was split afterwards.
- **Archiving a category** leaves merchant rules that point at it untouched.
- **Two undos of the same row at once** can both report success, though only one change is applied.
- **Transfer link.** The copy keeps the transfer id, so a transfer to a private account shows as a transfer.
- **Crates.** No new crates were needed.
