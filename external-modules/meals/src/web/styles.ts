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
