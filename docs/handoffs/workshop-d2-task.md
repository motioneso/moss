# Workshop D2: durable ordered project feed

Part of #2023. Implements D2 of the approved Workshop projects and supervised-builds spec.
Ben's blanket authorization covers this continuation.

Persist owner-private user messages in the Workshop project feed. Stable client message IDs
make retried acceptance idempotent; changed input under the same ID conflicts. Return saved
records only, with delivery explicitly pending until a later attempt-scoped host acknowledgement.
Use bounded forward cursor pagination that cannot skip concurrent commits, actor-scoped database
transactions, forced owner RLS, and account/project cascade and user export declarations.

This persistence slice supplies the user-message kind first. Trusted question/status/revision
kinds and delivery acknowledgements belong to the tasks that own their validation and attempt
identity; do not add a generic event payload or pretend a stored message reached a builder.
No route, model invocation, queue dispatch, approval or execution is introduced here.

Prove concurrent append and replay, reconnect pagination, rollback, both-admin owner isolation,
input bounds, raw role enforcement and lifecycle through the isolated integration gate.
