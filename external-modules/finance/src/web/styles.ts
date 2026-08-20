// external-modules/finance/src/web/styles.ts
// FIN-02 (#1147): layout-only module CSS. D9 (#1388): travels on the web
// contract's `css` field (see index.ts) — the host confines and mounts it
// (packages/module-css-confine), not a self-injected <style> tag. ZERO
// color/typography declarations — visual identity comes entirely from the
// host's jds-* primitives and document styles, so the tokens.css raw-color
// rule and theme switching are untouched by this module.
export const MODULE_STYLES = `
.fnm-root { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.fnm-header { display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 1rem; }
.fnm-stack { display: flex; flex-direction: column; gap: 1rem; }
.fnm-row { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.fnm-state { display: flex; flex-direction: column; gap: 0.5rem; }
.fnm-visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.fnm-table { width: 100%; border-collapse: collapse; }
.fnm-table th, .fnm-table td { text-align: left; vertical-align: top; padding: 0.25rem 0.75rem 0.25rem 0; }
.fnm-chips { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.fnm-pill { display: inline-flex; align-items: baseline; gap: 0.5rem; padding: 0.375rem 0.75rem; }
.fnm-feed { list-style: none; margin: 0; padding: 0; }
.fnm-txrow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 0.75rem; padding: 0.5rem 0.75rem; }
.fnm-txmain { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
.fnm-txmain > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnm-txtags { display: inline-flex; align-items: center; gap: 0.5rem; }
.fnm-catpick { display: inline-flex; align-items: center; gap: 0.375rem; }
/* Amounts align on digits via numeric variants — mono is retired app-wide. */
.fnm-amount { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
/* FIN-05 (#1150) reports: bars/trend are layout-only — the bar track is a
   .jds-progress (packages/ui), .jds-progress--current making the fill inherit
   currentColor at reduced opacity so no raw color enters the module. */
.fnm-report-grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); align-items: start; }
.fnm-report-bar { flex: 1; min-width: 4rem; }
.fnm-report-bar-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.25rem 0; }
.fnm-report-bar-row > span:first-child { flex: 0 0 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fnm-report-trend { width: 100%; height: 8rem; display: block; }
`;
