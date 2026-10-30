# Finance audited transfer correction checkpoint

Authorized continuation of #1144/#1148. Design:
[transfer corrections](../specs/2026-10-30-finance-transfer-corrections.md).
The isolated branch may be committed and pushed; no PR publication, merge, deployment,
production data, bank credentials, real money movement or financial account change.

## Implemented boundary

An owned linked manual cash/card transfer can be corrected with one explicit inverse pair.
The original receipt, entries and reconciliation marks stay intact. The server derives exact
amount, currency and inverse endpoints from the owned canonical original. A new posting date
cannot precede it or either opening date, must follow both completed statements and cannot be
in the future in the actor's Moss timezone. Closed/ineligible ledgers refuse another posting.

Additive migration 0036 creates an owned correction-link table with an owner/original
primary key, unique inverse identity and both owned receipt foreign keys. There are now 36
migrations / 20 owned tables. The existing deterministic account-lock transfer mutation serves
normal and correction pairs. Corrections additionally check original/leg revision and integrity,
exact inverse facts and absence of a saved correction. Receipt, legs, balances, ledger versions,
link and activity commit together. Same-operation digest replay precedes eligibility checks;
changed payload conflicts. Digests include original identity but exclude captured versions.
A correction receipt may itself be corrected once, preserving an append-only chain. No generic
destructive activity Undo is exposed. Settings activity has clear transfer/correction wording.

Native Transactions offers Review transfer for owned linked rows; shared rows stay read only.
Named original facts and current statement boundaries precede a captured review with exact
inverse balances (cards explicitly owed). Mandatory host confirmation follows; cancel retains
review, immediate locks suppress duplicates/dismissal, and stale/uncertain outcomes require an
explicit saved-transfer check. An already committed correction appears on that read instead of
being submitted again. Original/correction links can be reviewed after reload. No financial
write retries automatically. Complete owned history CSV retains both correction identifiers;
loaded CSV behavior and private-note/shared-mirror exclusions are preserved.

Current Park Press Dialog/Note/Button/Checkbox primitives and existing paragraph/spacing layout
are used. Phone inspection led to compact paragraph spacing, a short Back action and a shared
header close control; both resulting balances and the history explanation now fit above the
footer at 320px. Account/date-based accessible action names avoid exposing UUIDs as user labels.
The nonvisual identifier attribute lets the synthetic test select the exact linked pair.

## Verification

Node 24.19.0 / pnpm 10.6.2, disposable gate databases and synthetic data only:

- Complete Finance units: 76 files / 732 tests passed. Focused native tests capture inverse
  cash/card balances, host cancellation, immediate duplicate/dismissal locks, uncertain-read
  recovery and unavailable endpoints. Handler tests derive amounts from the canonical original,
  enforce local dates and pin the native confirmation metadata. Module migration/ABI tests pass.
- First SQL `115514-kQW1Wy`, input `c71412c593a0`, passed 17 / failed two fixture assumptions.
  The canonical putTransaction correctly preserved manual financial fields, so it did not create
  the intended malformed legacy leg. That setup now uses an explicitly labeled owned SQL fixture.
  Closing also requires a completed statement through today; the fixture had not met that rule.
- SQL `115735-QjvQ10`, input `ccdba8af932c`, passed 18 / failed the remaining close fixture.
  A prior-date statement still cannot satisfy today's closure policy. The held-account test now
  performs a real zero-balance reconciliation and close while correction waits; no rule changed.
- Restored SQL `115857-8vQ43v`, input `697e902383c3`, passed all 19. It covers original/history
  preservation, cash/card inverse signs, correction chains, stale/source/amount/currency/date
  refusal, same-operation replay/conflict, distinct concurrent one-winner, statements and the
  held reconciliation/close race, owned history links and foreign/admin refusal.
- Fixture-only duplicate negative `120054-b1JCAn`, input `e5ae378a7230`, failed one / passed 18:
  suppressing the SQL duplicate guard and temporarily removing the disposable relational key
  allowed a second inverse pair. The fixture restores the key in finally; production stays intact.
- Fixture-only RLS negative `120220-qAGisv`, input `4656b9e81faa`, failed one / passed 18:
  disabling only the disposable correction table's row security exposed a foreign correction
  link. The fixture restores security in finally; no runtime/admin bypass was introduced.
- First installed correction `120336-LYRqZS`, same input, reached host cancel/confirmed save,
  exact saved balances, unchanged original legs and report totals, then failed an export assertion
  that expected unquoted cells. Export correctly quoted UUID fields. The fixture now parses CSV
  and checks actual field values instead of assuming its quoting style.
- Restored installed `120726-5kyjyc` and SQL `120728-dw4ger`, input `ef4abae66ca2`, passed one
  selected browser flow (20 unrelated skipped) and all 19 SQL cases, respectively. Actual reload,
  original/correction navigation and export links pass; no application response is intercepted.
- Native hook negative `120915-qRbUWB`, input `a1c3fba52a72`, failed the expected no-unapproved-
  correction assertion. Only the temporary installed manifest copy loses confirmWhenKeys. With
  executionPolicy alone, a synthetic correction actually committed without the host decision;
  the assertion read its saved link. Production metadata never lost its mandatory hook.
- The prior clean refresh `e0a06715`, input `03034115c2bf`, full browser `114621-eZ4fEI` passed
  20 / failed the final category-confirmation dialog wait. This was not labeled baseline. The
  fixture now records the final confirmed HTTP/body outcome instead of only waiting for closure.
  Focused `120917-gotNHR`, input `a1c3fba52a72`, passed that actual flow, including HTTP 200 with
  exactly one category confirmed. Do not infer a cause for the earlier unretained response.
- Complete Finance backend `121148-bsvbuD`, input `7ede71517338`, passed 16 suites / 150 tests,
  exit 0. The opt-in installed-browser suite is separately skipped there (21 cases), and separately
  executed by the live command. This covers actual new migration/install/backfill and prior
  Finance behavior; it is not a substitute for browser or aggregate acceptance.
- Repository-wide lint, full typecheck (root, root tests, web and three external modules),
  formatting, file-size and UI-class checks passed on the implementation. No changed checked source file crosses the
  1,000-line limit; the installed browser harness stays at 999 lines through a focused fixture helper.

Screenshots finance-transfer-correction-<theme>-<width>.png cover light/dark/Sage and
320/390/768/1440. Dark phone and light desktop were inspected, then compact phone inspected
again. Executable dialog/document/footer bounds remain unchanged and pass. Synthetic artifacts
stay outside the repository. Final complete installed acceptance follows below.

## Aggregate evidence and remaining scope

Clean refresh foundation `114623-BT0aoA`, input `03034115c2bf`, passed all static checks, then
reported 277 failed / 19,621 passed / 16 skipped tests (24 failed / 1,624 passed files). The 277
ordinary failure identities still match baseline; four extra setup failure groups came from three
parity-browser files because this launch omitted supported CHROMIUM_PATH. Restoring the existing
system Chromium path passed all three files / 13 affected tests without source or guard changes.
The aggregate itself exited 1 and later DB stages did not run. A new complete aggregate with the
browser prerequisite and final committed correction source is required; do not call this green.

Transfers remain Partial: no matching of existing imported records, provider corrections, FX,
loan/investment endpoints, automatic payment reserves or household co-editing. Broader goals,
recurring series/calendar work, provider convergence and richer reporting remain staged. Continue
with a precisely named target capability rather than claiming universal parity from test counts.

Final complete installed `121146-YK8dO1`, input `7ede71517338`, passed all 21 flows, exit 0.
It includes the compact correction review, actual host cancellation/confirmation, persisted inverse
legs, exact cash/card balances, unchanged original rows/report totals, parsed owned export links,
reload and original/correction navigation. Fresh installed startup, target funding, legacy target
repair, stale budget review, bills, flexible planning, categories, import, accounts, reports and
host platform confirmation also passed. The instrumented category-confirmation flow completed.
There is no response stub and no fabricated migration marker establishing fresh-start acceptance;
the existing separate manual-transfer actor still uses its explicitly labeled synthetic fixture.
The 21 count represents broader exercises within those flows, not universal feature parity.

Commit/push this coherent slice. Freeze the commit and run clean combined backend/browser and
aggregate checks with the supported browser path, retaining exact receipts. Continue next with
an explicitly named weekly contribution target that counts calendar occurrences; investigate its
official comparison and define carry/spending behavior before implementation. Refill targets,
account-linked goals and card reserve policy remain separate gaps, not implied by weekly wording.
