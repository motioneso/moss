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
.fnm-money-wrap { min-width: 0; max-width: 100%; overflow-wrap: anywhere; white-space: normal; }
/* FIN-05 (#1150) reports: bars/trend are layout-only — the bar track is a
   .jds-progress (packages/ui), .jds-progress--current making the fill inherit
   currentColor at reduced opacity so no raw color enters the module. */
.fnm-report-grid { display: grid; gap: var(--space-6); grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); align-items: start; }
.fnm-manual-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.fnm-manual-columns > * { min-width: 0; }
.fnm-account-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
.fnm-import-dialog { max-width: 42rem; }
.fnm-import-dialog p { margin: 0; }
.fnm-block.fnm-budget-setup { max-width: 44rem; gap: var(--space-5); }
.fnm-budget-setup p { margin: 0; }
.fnm-import-rows { display: flex; flex-direction: column; gap: var(--space-4); }
.fnm-import-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: start; }
.fnm-import-row > * { min-width: 0; overflow-wrap: anywhere; }
.fnm-manual-form { display: flex; flex-direction: column; gap: var(--space-4); }
@media (max-width: 480px) { .fnm-manual-columns { grid-template-columns: minmax(0, 1fr); } }
.fnm-account-totals { display: grid; gap: var(--space-6); grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); }
.fnm-account-totals > * { margin: 0; min-width: 0; }
.fnm-report-bar { grid-column: 1 / -1; grid-row: 2; min-width: 0; width: 100%; }
.fnm-report-bar-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-1) 0; }
.fnm-report-bar-row > :first-child { min-width: 0; overflow-wrap: anywhere; text-align: left; }
.fnm-report-bar-row > span:last-child { grid-column: 2; grid-row: 1; }
.fnm-report-month { display: grid; gap: var(--space-2); }
.fnm-report-month dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); margin: 0; }
.fnm-report-month dd { margin: 0; }
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
.fnm-field-error { width: 100%; max-width: 24rem; white-space: normal; text-align: start; }
.fnm-assign__input { width: 100%; max-width: 9rem; text-align: right; }
.fnm-phone-only { display: none; }
/* #3176 Transactions: layout only. */
.fnm-spread { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.fnm-col-payee { width: 30%; }
.fnm-col-category { width: 34%; }
.fnm-col-amount { width: 14%; }
.fnm-search { width: 14rem; max-width: 100%; }
.fnm-register-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); align-items: end; gap: var(--space-4); }
.fnm-register-filters > label { min-width: 0; }
.fnm-register-filters select { width: 100%; }
.fnm-tabs .jds-segmented { flex-wrap: wrap; }
.fnm-fixed td { overflow-wrap: anywhere; }
.fnm-category-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.fnm-category-controls > span { flex: 1; min-width: 0; }
.fnm-category-controls > .fnm-block { width: 100%; }
.fnm-category-controls select { width: 100%; }
.fnm-split-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; align-items: end; gap: var(--space-3); }
.fnm-split-row input, .fnm-split-row select { width: 100%; min-width: 0; }
@media (max-width: 720px) {
  .fnm-root { padding: 1rem 0.75rem 2rem; }
  .fnm-page { grid-template-columns: minmax(0, 1fr); gap: var(--space-7); }
  .fnm-desktop-only { display: none; }
  .fnm-phone-only { display: block; }
  .fnm-chips { max-width: 100%; }
  .fnm-register-filters[data-expanded="false"] { display: none; }
  .fnm-split-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
`;
