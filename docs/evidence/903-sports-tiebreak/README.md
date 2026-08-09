# #903 sports primary-follow tie-break — live-path evidence

Manual live-UI walk on a fresh dev instance (API :3099, web :5199), signed in as
`ben@ben.com`, verifying `selectPrimaryFollow` (packages/sports/src/followed-groups.ts,
commit 02fff920c) after forcing an exact `created_at` tie between two real follow rows.

- `01-arsenal-followed-two-competitions.png` — Arsenal followed via the real UI under two
  competitions (Premier League `eng.1`, Champions League `uefa.champions`). Ben's 7
  pre-existing follows untouched.
- `02-reload-1.png` … `06-reload-5.png` — the Arsenal card on 5 successive fresh reloads
  of `/sports`, after a scoped `psql` UPDATE forced identical `created_at` on the two new
  follow rows. Primary competition (`eng.1`) renders identically every time.

Full write-up and DB/API-layer proof: PR #1472 comment
https://github.com/motioneso/moss/pull/1472#issuecomment-5228612572
