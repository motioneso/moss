# Memory screen mockups (JS-239)

Plan section 2.1. Open `screens.html`; the top bar switches screen, desktop or phone, light or dark.

## Parity with the TypeScript app

- To review, Saved memories and History tabs, with Memory and People switch.
- Filters for status, kind, source and text, counts, paging.
- Pin, forget, accept, dismiss, never suggest, edit dates.

## Changed

- Fact detail sits beside the list on desktop instead of expanding inline; phone opens it full screen.
- Confirm, Correct, Replace and Mark stale appear as direct actions (the Rust routes support them).
- Add a memory is a button on the tab row.
- Forget and remember approvals show the stored record, not model text.
- Broken state names the search index separately from the list.
