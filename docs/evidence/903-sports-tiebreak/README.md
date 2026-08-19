# #903 sports primary-follow tie-break — live-path evidence

Manual live-UI walk on a fresh dev instance (API :3099, web :5199), signed in as
`ben@ben.com`, verifying `selectPrimaryFollow` (packages/sports/src/followed-groups.ts,
commit 02fff920c) after forcing an exact `created_at` tie between two real follow rows.

- Arsenal was followed via the real UI under two competitions (Premier League `eng.1`, Champions
  League `uefa.champions`). Ben's 7 pre-existing follows were untouched.
- On 5 successive fresh reloads of `/sports`, after a scoped `psql` UPDATE forced identical
  `created_at` values on the two new follow rows, the primary competition (`eng.1`) rendered
  identically every time.

Full write-up and DB/API-layer proof: PR #1472 comment
https://github.com/motioneso/moss/pull/1472#issuecomment-5228612572
