# Repair legacy targets without funding a pooled category

Authorized continuation of #1144/#1148, following selected target funding. No PR publication,
merge, deployment, production data, credentials, live bank or financial action. Preserve all
ledger values and prior target versions; no new target type or budget policy is introduced.

The current target metadata handler checks category funding even when removing a target.
Consequently an old target attached to an active flexible-pool member cannot be removed,
although removal does not assign money. The reusable target section does not itself exclude
the synthetic flexible pool; the actual Budget screen already filters it before passing choices.
Existing pooled or archived targets can be mislabeled after eligible categories are filtered.
Keep that screen filter and make the section defensive as well. These are repair paths within the
existing target/flexible-budget model, not a new broader goals feature.

Allow removed targets through the metadata handler's funding guard; retain the SQL owner,
category-existence and captured revision/fingerprint checks. Active monthly/balance target
creation or edits must still reject pooled categories. The existing SQL versioned removed
record preserves earlier months and changes no assignments, transactions or account values.

Exclude the synthetic flexible pool from new target choices. Resolve existing target names
from the owned taxonomy or owned funding proposals instead of calling every missing eligible
choice archived. An existing archived or pooled target opens a named read-only metadata review
with Remove target available. Explain the repair and preserve its current values; disable
ordinary edits for an ineligible category. Retain immediate submission/dismissal guards and
the successful-read wait introduced by selected funding. Use existing app-map declarations.

Acceptance: observe a handler regression fail before repair; prove removed metadata succeeds
for a pooled target while new/edit funding remains refused. Real SQL must retain earlier
versions, assignments, account/transaction values and refusal on stale reviews. Exercise the
actual installed flexible-budget UI with synthetic data to remove an explicitly labeled legacy
fixture, then verify canonical saved state. Native tests must exclude the synthetic pool and
show correct legacy names, disabled edit controls and an actionable Remove target. Run relevant
units, lint, types, SQL and complete installed-browser regressions. Do not claim ordinary mode
switching creates these legacy states; valid new mode transitions already reject conflicting
targets. Record the synthetic legacy setup separately from the actual UI removal.
