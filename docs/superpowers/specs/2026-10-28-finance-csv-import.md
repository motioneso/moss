# Finance CSV import into manual accounts

Date: 2026-10-28. Continuation of the authorized Finance parity brief and the
[manual ledger design](2026-10-28-finance-manual-ledger.md). Work stays local and uses synthetic
files and accounts. No real bank connection, provider credential, publication or production write.
Official comparison evidence remains in the [parity matrix](2026-10-28-finance-parity.md).

## Bounded first delivery

Import posted transactions into an existing manual account. The browser reads a CSV locally,
with a 1 MiB file limit, at most 200 data rows and 500 KiB of mapped JSON entries. The last limit keeps requests below the host body limit even after JSON escaping. Support quoted commas, escaped quotes, CRLF,
quoted newlines and a UTF-8 BOM. Reject malformed quoting or unequal field counts. Do not guess
currency, date order or whether positive amounts mean money in or money out.

The user chooses date and payee columns, either a signed amount column with an explicit sign
choice or separate inflow/outflow columns, an optional note column, and an optional currency
column. Without a currency column the review explicitly states that every row uses the account
currency. Offer ISO, month/day/year and day/month/year date formats. Preview exact money in/out
and the resulting balance before applying. No FX conversion. Invalid/sub-cent/unsafe money,
impossible/future dates and dates in a completed statement period prevent the batch from applying.
Rows start uncategorized for review; category-name inference is separate work. Cleared state is
an explicit import choice. The opening balance remains separate from the imported transactions.

## Duplicate and replay contract

Compare account, currency, civil date, exact amount and case/whitespace-normalized payee. Mark
both duplicates within the file and candidates already in the ledger. Each candidate requires
an explicit Skip or Import anyway choice. No auto-delete, merge or silent skip. Keep original
source row indices when rows are skipped so retry identities cannot shift.

A read-only preview tool validates bounded rows and returns the owner account's ledger revision,
opening/statement bounds and duplicate row indices. It never persists file contents. An apply
tool repeats validation and checks the current account revision under lock. Another posting or
reconciliation after preview invalidates the review and requires refresh.

The form retains an operation UUID. Canonical validated rows, account, currency, revision and
explicit duplicate decisions determine an operation digest. A receipt table records the owner,
operation ID, account, row count, digest and time. Identical replay returns the original result;
different input under the same identity is a conflict. Check an existing receipt before rejecting
its now-old preview revision, so a successful import remains replayable after later ledger work.

One SQL statement locks the account, validates the date/currency/revision and exact resulting
balance, inserts the receipt and all rows, updates balance/revision once, and appends metadata
activity. Transaction IDs derive from the operation UUID and original source row index. An
unexpected row collision aborts the entire statement. No conflict-do-nothing on individual rows
that could leave a partial import. No CSV text, payee, note or filename goes into queue payloads
or audit metadata. Use the guarded synchronous page-tool bridge; uncertain transport freezes the
review and offers a saved-records check rather than starting a new identity automatically.

## UX and acceptance

Accounts offers Import CSV for manual accounts. Use shared Dialog, Select, Button and Switch,
current Park Press tokens, exact tabular amounts, and layout-only module CSS. A shared opt-in Dialog body-scroll mode keeps the title and action footer visible while longer mappings and previews scroll. Keep mapping,
validation, duplicate decisions, loaded scope and confirmation clear on phone and desktop. Show
file errors before any write and preserve mapping/choices on rejected saves. Add a manual-account
route from Getting started so bank credentials are not a prerequisite for beginning.

Prove parsing and sign/date boundaries, malformed files, safe-integer limits, mixed currencies,
invalid-row atomicity, source-row identity, both duplicate kinds, revision conflicts, replay and
concurrent apply. Exercise real installed browser upload/mapping/preview/apply/reload with a
synthetic CSV and actual owner-scoped SQL; no intercepted application responses. Observe receipt
owner enforcement fail with its generated RLS removed in a disposable test, then restore it.
Run the new unique-log verify-gate procedure, relevant unit/static/type/install gates and browser
inspection at 320/390/768/1440 in light/dark. Larger files and provider-account import stay explicit
limitations; do not advertise universal import parity.

## Manifest size rationale

The installable manifest remains a single declarative wire contract and now exceeds the general
source line limit. It has a narrow file-size exemption: every tool retains a complete explicit
input schema, with bounded rows and required duplicate decisions. Removing validation or hiding
schemas to shorten the manifest would be a worse tradeoff. Implementation and UI code remain
split into focused files below the source limit.
