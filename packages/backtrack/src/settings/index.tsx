import { Note, PaneHead } from "@moss/settings-ui";

/**
 * Placeholder settings pane for Backtrack (#2638 phase 2a, plan 2026-10-03-backtrack-phase2.md
 * §4.2). A later task in this build (§4.8) replaces this with the real screens: the Recording
 * switch, days/size kept, delete controls (last hour / today / choose a day / everything), and
 * the empty/instance-off states — all built from `@moss/settings-ui` and `@moss/ui` primitives,
 * per the design-system skill. This stub exists only so the manifest's `settings.entry` resolves
 * to something real while that work lands.
 */
export default function BacktrackSettings() {
  return (
    <>
      <PaneHead title="Backtrack" desc="Your day memory, captured by Trail Marker." />
      <Note>Backtrack settings are being built. Check back soon.</Note>
    </>
  );
}
