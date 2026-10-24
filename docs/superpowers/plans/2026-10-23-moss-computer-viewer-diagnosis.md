# Moss Computer: bounded viewer diagnosis

Task #3578 / parent #3577; integration foundation #3605. Authority: the
[viewer-repair handoff](../handoffs/2026-10-23-moss-computer-viewer-repair.md).
Operator: Codex `/root`; independent read-only reviewer: `/root/viewer_review`.
Private live state and diagnostic receipts: `../moss-computer-viewer-repair-private/`.
Historical roots remain read-only.

## Decisions and sequence

1. Compare actual accepted r11 and rejected r12 connection, readiness, access and transport paths,
   including the retained image's noVNC implementation. Check retained receipt/source hashes.
2. Rank initialization rejection, browser WebSocket/TLS rejection, and configuration/module-state
   mismatch against the actual observations. Separate the handled package-version 404 from causal
   evidence. Check the proposed DOM/settings race using the exact vendor `prime` method in a
   bounded offline VM; a removed readiness fast path must make its oracle reject the defect.
3. Implement a connection repair only if a discriminating offline check supports it. Preserve
   all real current-UI/RFB, visible-frame, fresh-input, security, deadline and persistence assertions.
   A VM success establishes only method scheduling, never a connected desktop.
4. Before any permitted desktop attempt, commit the supported repair and exact fresh launch packet,
   obtain independent actual-artifact acceptance, and repeat admission immediately before launch.
   Inherit the complete r12 acceptance sequence and the repair handoff's limits without relaxation.
5. If evidence cannot support a repair, end diagnosis with `UNRESOLVED_NO_SUPPORTED_REPAIR` and
   persistence `NOT_RUN`. Preserve the unused attempt; do not load the image or prepare launch
   identities merely to repeat the known timeout. Independently review the exact final evidence
   and no-runtime closure, commit/push scoped documents, and open a draft stacked on the actual
   unmerged dependency. No merge, deployment or issue closure.

The kill gate belongs to Codex `/root`: no evidence-backed causal repair means no runtime launch.
There are no model calls, product UI changes, new app-map capabilities or database commands in
this diagnostic slice. Any later implementation needs its own committed bounded plan.

## Verification and limits

The offline check must exercise the extracted actual method across DOM/settings orderings and
observe the broken-method control failing. Source/receipt checks must reject changed bytes.
Expected exit 0 for the diagnostic checks, scoped formatting, relative links and `git diff --check`.
Actual desktop, sandbox, clean flush and replacement remain separate live predicates.

The [result](../../evidence/moss-computer/2026-10-23-viewer-diagnosis.md) records the stopping decision
and exact receipts. This document is a diagnostic plan, not an accepted runtime launch packet.
