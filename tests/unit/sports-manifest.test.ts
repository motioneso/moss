import { describe, expect, it } from "vitest";

import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";

describe("sports manifest", () => {
  it("declares owner-only table + nav + settings + routes", () => {
    expect(sportsModuleManifest.database.ownedTables).toEqual([
      "app.sports_follows",
      "app.sports_custom_sources",
      "app.sports_source_assignments",
      "app.sports_policy_verdicts",
      "app.sports_headline_prefs"
    ]);
    expect(sportsModuleManifest.database.migrations).toEqual([
      "sql/0133_sports_follows.sql",
      "sql/0185_sports_whole_league_dedupe.sql",
      "sql/0186_sports_whole_league_unique.sql",
      "sql/0190_sports_custom_sources.sql",
      "sql/0191_sports_public_source_runtime.sql"
    ]);
    expect(sportsModuleManifest.navigation[0]?.path).toBe("/sports");
    expect(sportsModuleManifest.settings[0]?.path).toBe("/settings/modules/sports");
    expect(sportsModuleManifest.routes.map((r) => r.path)).toContain("/api/sports/overview");
    expect(sportsModuleManifest.routes.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "/api/sports/sources/:id/retry",
        "/api/sports/sources/:id/rebuild/preview",
        "/api/sports/sources/:id/rebuild"
      ])
    );
  });

  it("exposes follows plus bounded actor-scoped source tools", () => {
    expect(sportsModuleManifest.assistantTools).toHaveLength(12);
    const byName = Object.fromEntries(
      sportsModuleManifest.assistantTools.map((tool) => [tool.name, tool])
    );
    expect(byName["sports.followedFactsToday"]?.risk).toBe("read");
    for (const name of ["sports.followTeam", "sports.unfollowTeam"]) {
      expect(byName[name]?.risk).toBe("write");
      // #1265 binding condition (task #9): risk:"write" alone doesn't stop these from being
      // treated as destructive — policy.ts makes risk:"destructive" never auto-run regardless of
      // tier, so if either tool's risk ever silently became "destructive", granted_at_install
      // would combine with it and nothing else would catch that. Assert it explicitly here.
      expect(byName[name]?.risk).not.toBe("destructive");
      expect(byName[name]?.actionFamilyId).toBe("sports_follows");
      expect(byName[name]?.executionPolicy).toBe("auto");
      expect(byName[name]?.selfOperationGrant).toBe("granted_at_install");
    }
    for (const name of [
      "sports.listSources",
      "sports.previewSource",
      "sports.previewSourceAssignments",
      "sports.rebuildSourceRecipe"
    ]) {
      expect(byName[name]?.risk).toBe("read");
    }
    for (const name of [
      "sports.previewSource",
      "sports.previewSourceAssignments",
      "sports.rebuildSourceRecipe"
    ]) {
      expect(byName[name]?.externalContent).toBe(true);
    }
    for (const name of [
      "sports.confirmSource",
      "sports.confirmSourceAssignments",
      "sports.confirmSourceRecipe",
      "sports.retrySource",
      "sports.removeSource"
    ]) {
      expect(byName[name]?.actionFamilyId).toBe("sports.sources");
      expect(byName[name]?.selfOperationGrant).toBe("confirm_always");
    }
  });

  // #1265 security QA BLOCKING-1(b): both follow tools auto-run under a granted_at_install grant,
  // and their keys end up interpolated into an outbound ESPN URL. Bare `{ type: "string" }` puts
  // no bound at all on what the model may pass, so the schema itself is one of the three
  // independent belts (alongside the service-layer roster check and encodeURIComponent at the URL
  // site). Bounds mirror the REST schema (packages/shared/src/sports-api.ts
  // `createSportsFollowRequestSchema`), plus a character-class pattern the REST schema lacks.
  it("bounds both follow tools' key inputs with length and a catalog-shaped pattern", () => {
    const byName = Object.fromEntries(
      sportsModuleManifest.assistantTools.map((tool) => [tool.name, tool])
    );
    for (const name of ["sports.followTeam", "sports.unfollowTeam"]) {
      const properties = (
        byName[name]?.inputSchema as {
          properties?: Record<string, { maxLength?: number; minLength?: number; pattern?: string }>;
        }
      )?.properties;
      for (const field of ["competitionKey", "teamKey"]) {
        expect(properties?.[field]?.maxLength).toBe(100);
        // Catalog keys are lowercase alphanumeric with dots ("nfl", "eng.1"); ESPN team keys are a
        // lowercased abbreviation or a bare numeric id. Nothing that can traverse a URL path.
        expect(properties?.[field]?.pattern).toBe("^[a-z0-9.]{1,100}$");
      }
      expect(properties?.competitionKey?.minLength).toBe(1);
    }
  });

  it("keeps follow automation separate from confirmed source recovery", () => {
    expect(sportsModuleManifest.assistantActionFamilies).toHaveLength(2);
    const byId = Object.fromEntries(
      (sportsModuleManifest.assistantActionFamilies ?? []).map((family) => [family.id, family])
    );
    expect(byId.sports_follows?.allowedTiers).toContain("trusted_auto");
    expect(byId["sports.sources"]?.allowedTiers).not.toContain("trusted_auto");
  });

  it("declares the espn external source with credential none and pinned hosts", () => {
    const [espn] = sportsModuleManifest.externalSources ?? [];
    expect(espn?.id).toBe("espn");
    expect(espn?.credential).toBe("none");
    // content.core host is the per-article body endpoint (#857); site.api serves the list feeds.
    expect(espn?.fetchHosts).toEqual(["site.api.espn.com", "content.core.api.espn.com"]);
    // akamaized is ESPN's video-still CDN — story art for video-led pieces (most soccer analysis)
    // comes from there, and a host absent from this list is a CSP-blocked blank image.
    expect(espn?.imageHosts).toEqual([
      "a.espncdn.com",
      "s.secure.espncdn.com",
      "espnmedia-cdn.akamaized.net"
    ]);
    // articleBody (#857) MUST be listed — the service requests it, and an undeclared dataset makes
    // the real DatasetClient throw before its fallback path, 500ing the overview on every load.
    expect(espn?.datasets.map((d) => d.key).sort()).toEqual(
      ["articleBody", "headlines", "schedule", "scoreboard", "standings", "teams"].sort()
    );
    expect(espn?.datasets.every((d) => d.staleness === "degrade-empty")).toBe(true);
  });
});
