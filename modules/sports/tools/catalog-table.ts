// Prints src/catalog_table.rs from the legacy Sports catalog. Run: pnpm exec tsx tools/catalog-table.ts
import { SPORTS_CATALOG } from "../../../packages/sports/src/source/catalog.js";

const q = (v: string | null | undefined) => (v == null ? "None" : `Some(${JSON.stringify(v)})`);
const out: string[] = [
  "//! Generated from the legacy catalog by tools/catalog-table.ts. Do not edit by hand.",
  "use crate::catalog::Entry;",
  "",
  `pub static ENTRIES: [Entry; ${SPORTS_CATALOG.length}] = [`
];
for (const e of SPORTS_CATALOG) {
  out.push(
    "    Entry {",
    `        key: ${JSON.stringify(e.competitionKey)},`,
    `        label: ${JSON.stringify(e.label)},`,
    `        sport_label: ${JSON.stringify(e.sportLabel)},`,
    `        region_label: ${q(e.regionLabel)},`,
    `        kind: ${JSON.stringify(e.kind)},`,
    `        marquee: ${e.marquee},`,
    `        standings_shape: ${JSON.stringify(e.standingsShape)},`,
    `        espn_sport: ${JSON.stringify(e.espnSport)},`,
    `        espn_league: ${JSON.stringify(e.espnLeague)},`,
    `        logo_url: ${q(e.logoUrl)},`,
    `        confederation: ${JSON.stringify(e.confederation)},`,
    `        news_feed_url: ${q(e.newsFeedUrl)},`,
    `        news_feed_publisher: ${q(e.newsFeedPublisher)},`,
    "    },"
  );
}
out.push("];", "");
console.log(out.join("\n"));
