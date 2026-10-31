# Cash-backed flexible budgeting

Continuation of Finance #1148 and the authorized practical-parity roadmap. Branch pushes are
allowed; no merges, deployments, live bank actions or credentials. The existing conservation plan
identifies the accounting requirements. This spec settles the first implementation.

Use a month-effective owner policy with selected flexible categories and non-monthly categories;
other expense categories are fixed. Changes are allowed in the current owner-local month. Reject
changes while nonzero future assignments exist or an open first-budget draft remains. Membership
changes require leaving the current pool first. Existing targets on proposed flexible members must
be moved/removed explicitly; pooled money cannot count as independently saved in several goals.

Keep stored transaction categories and historical assignment rows. In flexible mode, derivation
routes selected members' activity, assigned amounts and positive incoming carry into one internal
pool. Their original assignment amounts become informational guidance; a separate pool adjustment
makes the displayed pool assignment equal the user's chosen total. Fund the pool once. Ordinary
assignment/move/undo/archive/draft paths must reject funded changes to flexible members. The pool
is never a transaction category, rule destination or independent goal.

Entering mode is a confirmed, reviewed change. Show its assigned, spent, available and ready values;
explain that pooling can cover one member's overspending with another member's money. Pool edits
use the existing monetary threshold confirmation and immutable review tokens.

Leaving mode requires a confirmed allocation of the pool's nonnegative available money to every
member. Derive an envelope preview without changing history. For each member, set its assignment
to chosen available minus incoming carry plus activity. Set the internal pool adjustment to the
negative incoming pool carry so no hidden cash remains. The sum of assignments is conserved exactly.
A negative pool must be resolved first. Past months keep their policy; later carry follows the
resulting allocation. No old category amounts are silently reinstated on top of the pool.

Implementation: optional routing in the exact envelope reducer, an additive policy table, one
revision/fingerprint-gated SQL commit for mode plus assignments/activity, guarded preview/configure
and pool-assign tools, then Budget mode controls, pooled total and informational spending detail.
Keep all integer intermediates exact. Required proofs include refunds/splits, sparse months/year
boundaries, both transitions and prior carry, SQL races/rollback/RLS negative control, guarded and
cancelled installed desktop/phone/light/dark flows. Existing reports and transaction categories
remain unchanged. Configurable rollover and recurring non-monthly target cycles remain partial.
