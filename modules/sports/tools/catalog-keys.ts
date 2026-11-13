// Prints the legacy Sports catalog's competition keys in catalog order, one per line.
import { SPORTS_CATALOG } from "../../../packages/sports/src/source/catalog.js";

for (const entry of SPORTS_CATALOG) console.log(entry.competitionKey);
