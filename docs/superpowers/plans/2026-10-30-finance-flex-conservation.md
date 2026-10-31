# Flexible-budget continuation design notes

This is a design checkpoint, not implemented capability. Preserve the recurring-bill acceptance
snapshot until its checks finish. Flexible budgeting remains Missing in the parity matrix.

Monarch's official Flex article, updated October 29 and read October 30 UTC, describes one
standalone flexible pool, fixed and non-monthly categories, optional category guidance within the
pool, and different totals when switching between category and flex budgeting. Source:
https://help.monarch.com/hc/en-us/articles/32125337244052-Using-Flex-Budgeting
Moss must implement actual funding semantics rather than add a second summary over funded rows.

Implementation proposal for the next cash-backed slice (requires the acceptance proofs below):

- A month-effective routing policy selects fixed/non-monthly/flexible members, plus one internal
  pool that cannot be categorized into, targeted independently by a member, or selected in ordinary
  transaction/rule/category forms. Ledger transactions retain their original categories.
- Derive flex-member activity against the pool exactly once. Carry needs explicit routing at each
  policy boundary; simply summing displayed categories double-counts money and leaves hidden funds.
- Entering flex: preview the selected categories' assigned, carried, spent and available totals.
  Move current member assignments to the pool, retain optional former amounts as guidance, route
  their carry, and mark members read-only for funded assignments. Use one revision/fingerprint gate.
  Pooling can cover an individual member's overspending; make that effect visible before approval.
- Leaving flex: show the pool's actual available money and require an explicit destination review.
  Restore category activity routing, allocate carry and assignment amounts so chosen category
  available totals, aggregate assignments and actual funds reconcile. A zeroed pool must retain its
  historic rows. Do not silently reinstate old member amounts on top of pooled funds.
- Keep positive carry and overspending policy explicit. Initial scope can require resolving a
  negative pool before deactivation. Block changes with existing future assignments unless a full
  reviewed multi-month transition is implemented; do not rewrite future funded plans silently.
- Targets attached to flexible members need a clear distinction between informational guidance and
  funded amounts. They cannot count the same pool money as independently saved in several goals.
- Existing Budget assignment/move/apply/draft-start/category/archive/undo paths must enforce routing,
  not only the new page. Stale queued commands must fail rather than move money into hidden members.
- Tests: exact conservation through both transitions, carry from an envelope month into flex and
  flex into envelopes, negative members covered within a positive pool, refunds, sparse months,
  year boundaries, future assignments, SQL races, cancellation/stale review, installed UI.

Read and commit a final spec/implementation plan before coding the routing engine. The generic
October 28 planning spec authorizes the capability; these notes identify accounting decisions the
implementation must settle and prove. No additional live provider access is needed.
