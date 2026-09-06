import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";

/**
 * #2237 Sports owns its own SQL. A file that is not declared in the module's manifest is never
 * applied, and one declared but missing stops the runner, so the two lists must match exactly.
 * The photo columns are checked here too, because the settings row and the refresh both read
 * them and neither has anywhere else to notice they are gone.
 */

const sqlDirectory = fileURLToPath(new URL("../../packages/sports/sql/", import.meta.url));

describe("sports module SQL", () => {
  it("declares every SQL file it ships, in order, and ships every file it declares", () => {
    const onDisk = readdirSync(sqlDirectory)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => `sql/${name}`);
    expect([...sportsModuleManifest.database.migrations]).toEqual(onDisk);
  });

  it("adds the per-source photo record without touching an applied file", () => {
    const migration = readFileSync(`${sqlDirectory}0222_sports_source_photos.sql`, "utf8");
    for (const column of [
      "photo_rule_json",
      "photo_rule_state",
      "photo_miss_streak",
      "photo_last_outcome",
      "photo_relook_at"
    ]) {
      expect(migration).toContain(`ADD COLUMN ${column}`);
    }
    expect(migration).toContain("ALTER TABLE app.sports_custom_sources");
    expect(migration).not.toContain("DROP COLUMN");
  });

  it("keeps the photo state to the four the settings row knows how to describe", () => {
    const migration = readFileSync(`${sqlDirectory}0222_sports_source_photos.sql`, "utf8");
    expect(migration).toContain("photo_rule_state IN ('none', 'previewing', 'in_use', 'stale')");
  });
});
