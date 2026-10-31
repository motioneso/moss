// external-modules/finance/src/web/styles.ts
// FIN-02 (#1147): layout-only module CSS. D9 (#1388): travels on the web
// contract's `css` field (see index.ts) — the host confines and mounts it
// (packages/module-css-confine), not a self-injected <style> tag. ZERO
// color/typography declarations — visual identity comes entirely from the
// host's jds-* primitives and document styles, so the tokens.css raw-color
// rule and theme switching are untouched by this module.
export const MODULE_STYLES = `
.fnm-root { max-width: 76.25rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.fnm-stack { display: flex; flex-direction: column; gap: 1rem; }
.fnm-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.fnm-state { display: flex; flex-direction: column; align-items: flex-start; gap: 0.5rem; }
.fnm-state > .jds-btn { margin-top: 0.25rem; }
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
.fnm-export-ready { flex-basis: 100%; margin: 0; }
.fnm-money-wrap { min-width: 0; max-width: 100%; overflow-wrap: anywhere; white-space: normal; }
/* FIN-05 (#1150) reports: bars/trend are layout-only — the bar track is a
   .jds-progress (packages/ui), .jds-progress--current making the fill inherit
   currentColor at reduced opacity so no raw color enters the module. */
.fnm-report-grid { display: grid; gap: var(--space-6); grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); align-items: start; }
.fnm-manual-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.fnm-manual-columns > * { min-width: 0; }
.fnm-account-management p { margin: 0; }
.fnm-note-editor p { margin: 0; }
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
.fnm-account-totals { display: grid; gap: var(--space-6); margin-block-end: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(min(18rem, 100%), 1fr)); }
.fnm-account-totals > * { margin: 0; min-width: 0; }
.fnm-report-bar { grid-column: 1 / -1; grid-row: 2; min-width: 0; width: 100%; }
.fnm-report-bar-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-1) 0; }
.fnm-report-bar-row > :first-child { min-width: 0; overflow-wrap: anywhere; text-align: left; }
.fnm-report-bar-row > span:last-child { grid-column: 2; grid-row: 1; }
/* Phones show the top rows of a spending list; Show all opens the rest. */
.fnm-report-more { display: none; }
@media (max-width: 720px) {
  .fnm-report-bars:not(.is-open) > .fnm-report-bar-row--fold { display: none; }
  .fnm-report-more { display: block; margin-block-start: var(--space-3); }
}
.fnm-report-month { display: grid; gap: var(--space-2); }
.fnm-report-month dl { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); margin: 0; }
.fnm-report-month dd { margin: 0; }
.fnm-report-trend { width: 100%; height: 8rem; display: block; }
/* #3177 Accounts: a bank that cannot sync shows its status and Reconnect above the groups. */
.fnm-bank-status-row { display: inline-flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.fnm-switch-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-4); padding: var(--space-4) 0; border-bottom: var(--border-w) solid var(--border-subtle); }
.fnm-switch-text { display: flex; flex-direction: column; gap: var(--space-1); }
.fnm-limit { max-width: 14rem; }
.fnm-disclosure-head { display: inline-flex; align-items: center; gap: var(--space-2); }
.fnm-disclosure-marker { flex: 0 0 auto; width: 0.5rem; height: 0.5rem; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: translateY(-0.15rem) rotate(45deg); transition: transform 120ms ease; }
.fnm-disclosure-head[aria-expanded="true"] .fnm-disclosure-marker { transform: translateY(0.1rem) rotate(-135deg); }
/* #3173 Budget: layout only. Desktop shows the table and rail, phone the row list. */
.fnm-tabs { margin-bottom: var(--space-5); overflow-x: auto; scrollbar-width: none; }
.fnm-tabs::-webkit-scrollbar { display: none; }
.fnm-tabs .jds-segmented__opt { flex: 0 0 auto; white-space: nowrap; }
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
.fnm-fixed { table-layout: fixed; width: 100%; }
.fnm-col-name { width: 34%; }
.fnm-cell-stack { display: flex; flex-direction: column; gap: var(--space-2); min-width: 9rem; }
.fnm-cell-meter { width: 7rem; margin-left: auto; }
.fnm-assign { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-2); }
.fnm-field-error { width: 100%; max-width: 24rem; white-space: normal; text-align: start; }
.fnm-assign__input { width: 100%; max-width: 9rem; text-align: right; }
.fnm-col-assign { width: 9rem; }
.fnm-cell-end { align-items: flex-end; }
.fnm-phone-only { display: none; }
/* #3176 Transactions: layout only. */
.fnm-spread { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.fnm-col-check { width: 2.75rem; }
.fnm-col-date { width: 5.5rem; }
.fnm-col-payee { width: 26%; }
.fnm-col-category { width: 30%; }
.fnm-col-amount { width: 8rem; }
.fnm-search { width: 14rem; max-width: 100%; }
.fnm-register-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); align-items: end; gap: var(--space-4); }
.fnm-register-filters > label { min-width: 0; }
.fnm-register-filters select { width: 100%; }
.fnm-fixed td { overflow-wrap: anywhere; }
.fnm-row-badges { margin-top: var(--space-2); }
.fnm-look { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-3); }
.fnm-fixed td > .jds-check, .fnm-txline__check > .jds-check { vertical-align: top; }
/* Phone ledger row: payee and amount on the first line, the rest under the payee. */
.fnm-txline { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: var(--space-1) var(--space-3); }
.fnm-txline--check { grid-template-columns: auto minmax(0, 1fr) auto; }
.fnm-txline__check { grid-row: 1 / span 2; align-self: start; }
.fnm-txline__body { grid-column: 1 / -1; display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.fnm-txline--check .fnm-txline__body { grid-column: 2 / -1; }
.fnm-txline__body > .fnm-row-badges { margin-top: 0; }
.fnm-txline__name { min-width: 0; overflow-wrap: anywhere; }
.fnm-txline__amount { white-space: nowrap; }
.fnm-split-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; align-items: end; gap: var(--space-3); }
.fnm-split-row input, .fnm-split-row select { width: 100%; min-width: 0; }
/* Category detail panel: layout only. */
.fnm-peek { display: flex; flex-direction: column; gap: var(--space-6); margin-top: var(--space-3); }
.fnm-peek h2 { margin: 0; }
.fnm-move { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); align-items: end; gap: var(--space-3); }
.fnm-move input, .fnm-move select { width: 100%; min-width: 0; }
/* Upcoming: the month grid above the bill list, which groups by week. */
.fnm-weeks { display: flex; flex-direction: column; gap: var(--space-5); margin-top: var(--space-3); }
.fnm-week { display: flex; flex-direction: column; gap: var(--space-2); }
.fnm-week > h3 { margin: 0; }
/* Bill row meta: status and amount on one line, actions on one row at desktop width.
   Stacked phone rows hand the actions to the detail panel. */
.fnm-occ { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-3); max-width: 38rem; }
.fnm-occ .fnm-occ__actions { justify-content: flex-end; }
.fnm-occ .fnm-occ__open { display: none; }
@media (max-width: 560px) {
  .fnm-occ { flex-direction: row; flex-wrap: wrap; align-items: center; max-width: none; }
  .fnm-occ .fnm-occ__actions { display: none; }
  .fnm-occ .fnm-occ__open { display: inline-flex; }
}
@media (max-width: 720px) {
  .fnm-root { padding: 1rem 0.75rem 2rem; }
  .fnm-page { grid-template-columns: minmax(0, 1fr); gap: var(--space-7); }
  .fnm-desktop-only { display: none; }
  .fnm-phone-only { display: block; }
  .fnm-chips { max-width: 100%; }
  .fnm-search { flex: 1 1 12rem; width: auto; }
  .fnm-split-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .fnm-move { grid-template-columns: minmax(0, 1fr); }
}
`;
