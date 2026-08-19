// external-modules/food/src/web/styles.ts
// Food Phase 1 (#926, #1701, plan §5 Task 6): layout-only module CSS injected
// by the host via packages/module-css-confine (contract v2 css field, D9
// #1388). ZERO color/typography declarations — jds-* primitives are not in
// scope for a module bundle (this task's contract), so visual identity comes
// entirely from the host's document styles/theme; this module only ever
// arranges boxes. Class names are prefixed `fud-` (Food) to stay clear of the
// host's own class namespace, mirroring finance's `fnm-` / job-search's `jbs-`
// convention.
export const MODULE_STYLES = `
.fud-root { max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.fud-header { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 1rem; }
.fud-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.fud-datebar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
.fud-consent { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; padding: 0.5rem 0; }
.fud-badge { display: inline-flex; align-items: center; padding: 0.125rem 0.5rem; }
.fud-stack { display: flex; flex-direction: column; gap: 1rem; }
.fud-state { display: flex; flex-direction: column; gap: 0.5rem; padding: 1.25rem; }
.fud-meals { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.fud-meal-row { display: flex; flex-direction: column; gap: 0.375rem; padding: 0.75rem; }
.fud-meal-main { display: flex; align-items: baseline; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.fud-meal-time { font-variant-numeric: tabular-nums; white-space: nowrap; }
.fud-meal-desc { flex: 1 1 auto; min-width: 0; }
.fud-meal-tags { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.fud-nutrients { display: flex; flex-wrap: wrap; gap: 0 1rem; margin: 0; padding: 0; }
.fud-nutrient { display: inline-flex; gap: 0.25rem; }
.fud-nutrient dt { font-weight: inherit; }
.fud-nutrient dd { margin: 0; font-variant-numeric: tabular-nums; }
.fud-totals { display: flex; flex-direction: column; gap: 0.5rem; padding: 1rem; margin-top: 0.5rem; }
.fud-totals-row { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.fud-disclosure { margin: 0; }
`;
