// external-modules/finance/src/web/styles.ts
// FIN-02 (#1147): layout-only module CSS. D9 (#1388): travels on the web
// contract's `css` field (see index.ts) — the host confines and mounts it
// (packages/module-css-confine), not a self-injected <style> tag. ZERO
// color/typography declarations — visual identity comes entirely from the
// host's jds-* primitives and document styles, so the tokens.css raw-color
// rule and theme switching are untouched by this module.
export const MODULE_STYLES = `
.fnm-root { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
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
/* #3177 Accounts: status sits in the section head on wide screens and under the bank name on phone. */
.fnm-bank-status-row { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.fnm-bank-status { display: none; }
.fnm-bal { display: flex; flex-direction: column; align-items: flex-end; gap: 0.25rem; font-variant-numeric: tabular-nums; }
.fnm-switch-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-4); padding: var(--space-4) 0; border-bottom: var(--border-w) solid var(--border-subtle); }
.fnm-switch-text { display: flex; flex-direction: column; gap: var(--space-1); }
.fnm-limit { max-width: 14rem; }
.fnm-disclosure-head { display: inline-flex; align-items: center; gap: var(--space-2); }
.fnm-disclosure-marker { flex: 0 0 auto; width: 0.5rem; height: 0.5rem; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: translateY(-0.15rem) rotate(45deg); transition: transform 120ms ease; }
.fnm-disclosure-head[aria-expanded="true"] .fnm-disclosure-marker { transform: translateY(0.1rem) rotate(-135deg); }
.fnm-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
@media (max-width: 720px) {
  .fnm-bank-meta { display: none; }
  .fnm-bank-status { display: block; }
}
/* #3173 Budget: layout only. Desktop shows the table and rail, phone the row list. */
.fnm-tabs { margin-bottom: var(--space-5); overflow-x: auto; }
.fnm-hero { margin-bottom: var(--space-6); }
.fnm-pad { padding: 0; }
.fnm-page { display: grid; grid-template-columns: minmax(0, 1fr) 270px; gap: var(--space-8); }
.fnm-block { display: flex; flex-direction: column; gap: var(--space-7); }
.fnm-block--tight { gap: var(--space-3); }
.fnm-block--tiny { gap: var(--space-1); }
.fnm-end { align-items: flex-end; }
.fnm-inline { display: inline-flex; align-items: center; gap: var(--space-2); }
.fnm-rail { display: flex; flex-direction: column; gap: var(--space-6); }
.fnm-stat-pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.fnm-month-step { display: flex; align-items: center; gap: var(--space-3); }
.fnm-fixed { table-layout: fixed; width: 100%; }
.fnm-col-name { width: 34%; }
.fnm-cell-stack { display: flex; flex-direction: column; gap: var(--space-2); min-width: 9rem; }
.fnm-cell-meter { width: 7rem; margin-left: auto; }
.fnm-assign { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2); }
.fnm-assign__input { width: 100%; max-width: 9rem; text-align: right; }
.fnm-phone-only { display: none; }
/* #3176 Transactions: layout only. */
.fnm-spread { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.fnm-col-payee { width: 30%; }
.fnm-col-category { width: 34%; }
.fnm-col-amount { width: 14%; }
.fnm-search { width: 14rem; max-width: 100%; }
@media (max-width: 720px) {
  .fnm-root { padding: 1rem 0.75rem 2rem; }
  .fnm-page { grid-template-columns: minmax(0, 1fr); gap: var(--space-7); }
  .fnm-desktop-only { display: none; }
  .fnm-phone-only { display: block; }
}
`;
