# Needs You placement proposal

This synthetic comparison presents the current Needs You / Loose ends order beside the compact
grouping option Ben selected on 2026-09-25 (“compact option”). The titles, sources, message summary
and counts are fictional. No private data, live app capture or product code is used.

The structure and visible copy are reconstructed from `BriefingActionRowsSection` in
`apps/web/src/today/briefing-action-rows.tsx` and the later Loose ends section in
`apps/web/src/today/today-page.tsx`. It reuses the repository's token, UI and Today CSS. The
current implementation counts suggested actions plus Loose ends, while Catch-up stays
summary-only and outside that count in both examples.

Open `proposal.html` directly from the checkout. The crop in `needs-you-placement.png` captures
only the comparison sheet. It is a design proposal, not evidence of live visual parity or runtime
behavior.

The selected treatment groups Loose ends inside Needs You and removes its later duplicate section.
Catch-up's approved informational summary treatment is unchanged.
