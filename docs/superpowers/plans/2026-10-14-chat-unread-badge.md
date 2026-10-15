# Chat unread badge implementation — #3520

Approved spec: `../specs/2026-10-14-chat-unread-badge.md`. Work stays in one isolated checkout
of `~/Jarv1s` on `design/chat-unread-badge`; PR #3521 includes the spec and implementation.

1. Add migration 0323 with owner-scoped unread receipts keyed by saved assistant message ID.
   An invoker trigger adds receipts when nonempty assistant messages become stored in owned,
   persistent drawer threads. Existing history has no receipts and starts read. Explicit message
   ID acknowledgements delete only matching receipts, so loading cannot clear concurrent arrivals.
2. Expose typed count and acknowledgement endpoints through a small chat repository/routes seam.
   Count independently of the selected transcript; preserve existing transcript isolation.
3. Poll counts in the shell with owner-specific query keys. Render the shared Badge on the chat
   button only while closed, and per-thread counts in the conversation picker. A drawer hook
   acknowledges only saved message IDs present in its visible, successfully loaded conversation.
4. Cover owner boundaries, initial history, worker deliveries, idempotency, concurrent arrivals,
   and visible/hidden/closed drawer behavior. Update the owning manifest's app-map declarations.
5. Run scoped checks and the isolated foundation gate through `verify-gate`, then real UI proof
   on a disposable UAT instance at desktop and phone widths. Record evidence on PR #3521.

Status: implementation starting; design approved. No deployment or merge authorized.
