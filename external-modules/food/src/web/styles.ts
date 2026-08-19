// external-modules/food/src/web/styles.ts
// Food Phase 1 (#926, #1701, plan §5 Task 6): layout-only module CSS injected
// by the host via packages/module-css-confine (contract v2 css field, D9
// #1388). ZERO color/typography declarations — visual identity comes entirely
// from the host's authored design system, applied as jds-* classes in root.tsx
// exactly as finance does. This file only ever arranges boxes. Class names are
// prefixed `fud-` (Food) to stay clear of the host's own class namespace,
// mirroring finance's `fnm-` / job-search's `jbs-` convention.
export const MODULE_STYLES = `
.fud-root { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.fud-header { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 1rem; }
.fud-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.fud-datebar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
.fud-consent { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
.fud-stack { display: flex; flex-direction: column; gap: 1rem; }
.fud-state { display: flex; flex-direction: column; gap: 0.5rem; padding: 2.5rem 1.25rem; text-align: center; align-items: center; }
.fud-meals { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.fud-meal-row { display: flex; flex-direction: column; gap: 0.75rem; }
.fud-meal-main { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
.fud-meal-time { white-space: nowrap; }
.fud-meal-desc { flex: 1 1 12rem; min-width: 0; }
.fud-meal-tags { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-left: auto; }
/* The seven nutrients wrap into as many columns as fit rather than sitting on one
   overflowing line, which is what made the day view read as a wall of text. */
.fud-nutrients { display: grid; grid-template-columns: repeat(auto-fit, minmax(6.5rem, 1fr)); gap: 0.5rem; margin: 0; padding: 0; }
/* jds-stat-tile is authored for the Today page's clickable tiles; these figures do
   nothing when clicked, so the pointer cursor comes back off. */
.fud-nutrient { cursor: default; }
.fud-nutrient dd { margin: 0; }
.fud-totals { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem; }
.fud-totals-row { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.fud-disclosure { margin: 0; }
`;
