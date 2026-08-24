// external-modules/food/src/web/styles.ts
// Food phase 2 (#1737): layout-only module CSS injected by the host via
// packages/module-css-confine (contract v2 css field, D9 #1388). ZERO
// color/typography declarations — visual identity comes entirely from the
// host's authored design system, applied as jds-* classes in root.tsx exactly
// as finance does. This file only ever arranges boxes. Class names are
// prefixed `fud-` (Food) to stay clear of the host's own class namespace,
// mirroring finance's `fnm-` / job-search's `jbs-` convention.
//
// Every rule below is position, size, spacing or flow. The one judgement call
// worth naming: a rail is `align-self: stretch` by design, which collapses to
// zero height inside the section head's `align-items: center` flex row, so the
// occasion rail gets an explicit height here. That is a layout fact about this
// page's arrangement, not a look.
export const MODULE_STYLES = `
/* 72rem to match finance (.fnm-root) and job-search (.jsm-root). Food was the only module page at
   48rem, which put visibly wider gutters either side of it than the other two and made the set
   look inconsistent as you moved between them. The page frame is a host-level fact, not a
   per-module choice.
   Only the width is shared: job-search carries 6rem of bottom padding to clear the floating
   assistant button, which is a fact about its long board, not about the page frame. */
.fud-root { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.fud-header { display: flex; align-items: center; justify-content: flex-end; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.75rem; }
/* #1787: the header's controls travel as one group at the right edge. Wraps as a unit on a narrow
   screen rather than letting the date picker and the buttons separate onto different rows. */
.fud-header-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.fud-date { flex: none; }
.fud-log-btn { flex: none; }
.fud-settings-link { flex: none; text-decoration: none; }
.fud-notice { margin: 0 0 1.25rem; }

/* Day headline: calories alone on their line, then the macro fields. */
.fud-day { margin-bottom: 2.25rem; }
.fud-day-label { margin-bottom: 0.35rem; }
.fud-day-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: 1rem 1.25rem; margin-top: 1.5rem; }
/* Desktop: all six macros on one line. Still needed after the page widened to 72rem — this
   breakpoint fires from 46rem up, and between 46rem and roughly 48rem the page is narrower than
   its cap, so six 7rem tracks plus gaps do not fit and auto-fit silently wraps the last one or
   two onto a second row, at which point the day's figures stop reading as a single instrument
   cluster. minmax(0, 1fr) lets the tracks shrink to share the width evenly instead. */
@media (min-width: 46rem) {
  .fud-day-fields { grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 1rem 0.75rem; }
}
.fud-day-field { min-width: 0; }
/* #1737: the target line under a figure. Spacing only — jds-caption carries the type, and colour
   belongs to tokens.css, never to a module stylesheet. */
.fud-day-target { margin-top: 0.2rem; }
.fud-disclosure { margin: 1rem 0 0; }

/* Occasion group. */
.fud-occasion { margin-bottom: 2rem; }
.fud-occasion-rail { height: 14px; align-self: center; }
.fud-meals { list-style: none; margin: 0; padding: 0; }
.fud-meal { display: block; }

/* Meal row: the 3px rail track comes from jds-rail-row; this adds the row's own
   padding and the trailing figure column. */
.fud-meal-row { align-items: start; padding: 0.85rem 0; text-align: left; }
.fud-meal-row--inert { cursor: default; }
.fud-meal-body { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
.fud-meal-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.fud-meal-desc { min-width: 0; overflow-wrap: anywhere; }
.fud-meal-kcal { flex: none; white-space: nowrap; }
.fud-meal-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

/* Expanded breakdown: indented to the row's text column so the foods read as
   belonging to the meal above them rather than as siblings of it. */
.fud-items { list-style: none; margin: 0 0 0.5rem; padding: 0 0 0 calc(3px + 1rem); display: flex; flex-direction: column; gap: 0.4rem; }
.fud-item { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
.fud-item-label { min-width: 0; overflow-wrap: anywhere; }
.fud-item-portion { margin-left: 0.4rem; }
.fud-item-figures { display: flex; align-items: center; gap: 0.5rem; flex: none; white-space: nowrap; }
.fud-item-kcal { min-width: 4.5rem; text-align: right; }

.fud-state { display: flex; flex-direction: column; gap: 0.5rem; padding: 2.5rem 1.25rem; text-align: center; align-items: center; }
`;
