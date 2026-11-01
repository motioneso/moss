// external-modules/meals/src/web/styles.ts
//
// Layout-only module CSS with the mls- prefix. Colour and type come from @moss/ui and tokens.
export const MODULE_STYLES = `
.mls-page { display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
.mls-tabs { overflow-x: auto; padding-bottom: var(--space-1); }
.mls-grid { display: grid; grid-template-columns: minmax(0, 1fr) 270px; gap: 34px; align-items: start; }
.mls-rail {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-5);
  padding-left: 34px; border-left: var(--border-w) solid var(--border);
}
.mls-stack { display: flex; flex-direction: column; gap: var(--space-5); min-width: 0; }
.mls-stack--tight { gap: var(--space-3); }
.mls-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); min-width: 0; }
.mls-row > h3 { margin: 0; overflow-wrap: anywhere; }
.mls-members, .mls-table { list-style: none; margin: 0; padding: 0; }
.mls-member {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: var(--space-4);
  align-items: start; padding: var(--space-5) 0; border-bottom: var(--border-w) solid var(--border);
}
.mls-facts { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: 0; }
.mls-facts dt, .mls-facts dd { margin: 0; overflow-wrap: anywhere; }
.mls-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.mls-table { display: flex; flex-direction: column; gap: var(--space-2); }
.mls-table li { display: flex; justify-content: space-between; gap: var(--space-3); overflow-wrap: anywhere; }
.mls-table li > :last-child { flex-shrink: 0; }
.mls-num { font-variant-numeric: tabular-nums; }
.mls-planbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: var(--space-3) var(--space-5); padding-bottom: var(--space-3);
  border-bottom: var(--border-w) solid var(--border);
}
.mls-progress { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); min-width: 0; }
.mls-progress .jds-progress { width: 8rem; }
.mls-block-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);
  padding-bottom: var(--space-2); border-bottom: 2px solid var(--accent-rule);
}
.mls-block-head > .jds-caption { white-space: nowrap; }
.mls-section { display: flex; flex-direction: column; }
.mls-section + .mls-section { margin-top: var(--space-6); }
.mls-list { list-style: none; margin: 0; padding: 0; }
.mls-line {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center;
  gap: var(--space-2) var(--space-4); padding: var(--space-3) 0; min-height: 52px;
  border-bottom: var(--border-w) solid var(--border-subtle);
}
.mls-line--plain { grid-template-columns: minmax(0, 1fr) auto; }
.mls-line--bought { grid-template-columns: auto minmax(0, 1fr) 7rem; }
.mls-line__body { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.mls-line__name { overflow-wrap: anywhere; font-weight: var(--weight-semibold); font-size: var(--text-md); }
.mls-line__amount {
  display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1);
  max-width: 14rem; text-align: right; overflow-wrap: anywhere;
}
.mls-line__hit { cursor: pointer; }
.mls-line--plain .mls-line__hit, .mls-line--plain .mls-line__body, .mls-line--plain .mls-line__amount { cursor: default; }
.mls-line--done .mls-line__name { text-decoration: line-through; color: var(--text-muted); }
.mls-line__tools { display: flex; gap: var(--space-2); }
.mls-line__input { min-width: 0; width: 100%; }
.mls-form { display: flex; flex-direction: column; gap: var(--space-4); }
.mls-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
.mls-sticky { display: none; }
.mls-toast {
  position: fixed; bottom: var(--space-6); left: 50%; transform: translateX(-50%);
  z-index: 30; align-items: center; justify-content: space-between;
}
.mls-week { display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
.mls-day { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.mls-day__totals { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); }
.mls-slots {
  display: grid; gap: var(--space-5);
  grid-template-columns: repeat(var(--mls-slot-count, 1), minmax(0, 1fr));
}
.mls-slot { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.mls-slot__label { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
.mls-meal { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.mls-meal + .mls-meal { padding-top: var(--space-3); border-top: var(--border-w) dashed var(--border); }
.mls-meal__title { font-weight: 600; overflow-wrap: anywhere; }
.mls-meal__text { margin: 0; overflow-wrap: anywhere; }
.mls-meal__meta { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: 0; }
.mls-safety { margin: 0; overflow-wrap: anywhere; }
.mls-fit { display: grid; grid-template-columns: auto minmax(3rem, 1fr) auto; gap: var(--space-1) var(--space-3); align-items: center; }
.mls-fit__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 8rem; }
.mls-back { align-self: flex-start; }
.mls-ingredients, .mls-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.mls-ingredient { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: var(--space-3); }
.mls-ingredient__name { display: flex; flex-direction: column; gap: var(--space-1); overflow-wrap: anywhere; }
.mls-step { display: grid; grid-template-columns: 2.5rem minmax(0, 1fr); gap: var(--space-3); overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .mls-line { column-gap: var(--space-3); align-items: start; }
  .mls-line > .jds-check { margin-top: calc((1lh - 20px) / 2); }
  .mls-line__amount { max-width: 5.5rem; }
  .mls-list--shop .mls-line { min-height: 64px; }
  .mls-list--shop .mls-line__name { font-size: var(--text-lg); }
  .mls-form-grid { grid-template-columns: minmax(0, 1fr); }
  .mls-hide-phone { display: none; }
  .mls-sticky {
    display: flex; gap: var(--space-2); position: sticky; bottom: 0; z-index: 4;
    padding: var(--space-3) 0; border-top: var(--border-w) solid var(--border); background: var(--bg);
  }
  .mls-sticky > * { flex: 1; }
  .mls-toast { bottom: 88px; width: calc(100% - 2 * var(--space-4)); }
  .mls-slots { grid-template-columns: minmax(0, 1fr); }
  .mls-ingredient { grid-template-columns: 4.5rem minmax(0, 1fr); }
}
@media (max-width: 1080px) {
  .mls-grid { grid-template-columns: minmax(0, 1fr); }
  .mls-rail { padding-left: 0; border-left: 0; padding-top: var(--space-5); border-top: var(--border-w) solid var(--border); }
}
@media (max-width: 640px) {
  .mls-member { grid-template-columns: auto minmax(0, 1fr); }
  .mls-member > :last-child { grid-column: 2; justify-self: start; }
  .mls-facts { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
  .mls-facts dd + dt { margin-top: var(--space-2); }
}
`;
