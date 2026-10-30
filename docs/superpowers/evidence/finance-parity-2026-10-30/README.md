# Finance review evidence

Original installed-app screenshots from passing serialized receipt 144932-1D2ZVh.
All identities, notes and financial records are synthetic. Tested commit
4992a91cc77f130ea0e6d11bfae7a14f63b4e77e, clean input 102955f9ba38, Node 24.19.0 /
pnpm 10.6.2 / PostgreSQL 17.11. Intervening changes since implementation 682a8162
are documentation and screenshots only.

[Desktop transaction details](finance-transaction-details-light-1440.png)

[Phone transaction details](finance-transaction-details-dark-320.png)

[Desktop reconciled filter](finance-ledger-reconciled-light-1440.png)

[Phone reconciled filter](finance-ledger-reconciled-dark-320.png)

Full Finance acceptance passed all 190 tests in 17 files: 169 backend and all
21 installed browser flows. The actual host, authenticated API, module worker and
SQL/RLS paths are exercised. Provider/credential ports are disclosed mocks, not
real bank HTTP acceptance. Desktop/phone details, complete private notes, shared
read-only details without notes, captured values, modal bounds/focus return and
cleared/reconciled filters passed. Light/dark/Sage and 320/390/768/1440 widths are
checked. Selected representative frames above were inspected directly.

Earlier full 142921-Z9rN0U failed a register read with the fixed pattern-worker
validation rejection while the broad unit suite competed for resources. The same
code passed serialized acceptance without relaxing guards or timeouts. That supports
resource pressure as a possible cause; the generic rejection does not prove its
underlying worker failure. A real HTTP 429/Retry-After 5 was recovered through one
explicit read retry in the passing run. No financial write is automatically retried.

Broad aggregate 143017-SaB79F passed every static check but failed the same 277
earlier environment-baseline identities: zero added/removed, 19,720 tests passed,
three skipped. Later aggregate-chain DB/UAT/integration stages and CI e2e are not
claimed passed. See the [register checkpoint](../../plans/2026-10-30-finance-register-details-checkpoint.md)
and [parity matrix](../../specs/2026-10-28-finance-parity.md) for exact limits and
remaining capabilities. No merge, deployment, PR publication or real bank action.
