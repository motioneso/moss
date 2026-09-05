import { describe, expect, it } from "vitest";

import { validateToolInput } from "@moss/ai";
import { collectSportsSourcesExportSection } from "../../packages/sports/src/data-lifecycle.js";
import { sportsModuleManifest } from "../../packages/sports/src/manifest.js";
import { redditEntryToHeadline } from "../../packages/sports/src/source/reddit.js";

describe("sports manifest", () => {
  it("declares owner-only table + nav + settings + routes", () => {
    expect(sportsModuleManifest.database.ownedTables).toEqual([
      "app.sports_follows",
      "app.sports_custom_sources",
      "app.sports_source_assignments",
      "app.sports_espn_source_assignments",
      "app.sports_policy_verdicts",
      "app.sports_headline_prefs"
    ]);
    expect(sportsModuleManifest.database.migrations).toEqual([
      "sql/0133_sports_follows.sql",
      "sql/0185_sports_whole_league_dedupe.sql",
      "sql/0186_sports_whole_league_unique.sql",
      "sql/0190_sports_custom_sources.sql",
      "sql/0191_sports_public_source_runtime.sql",
      "sql/0192_sports_legacy_feed_assignments_verified.sql",
      "sql/0193_sports_legacy_feed_assignment_repair.sql",
      "sql/0196_sports_news_source_scopes.sql",
      "sql/0213_sports_reddit_sources.sql",
      "sql/0217_sports_follows_source_team_id.sql",
      "sql/0222_sports_source_photos.sql"
    ]);
    expect(sportsModuleManifest.navigation[0]?.path).toBe("/sports");
    expect(sportsModuleManifest.settings[0]?.path).toBe("/settings/modules/sports");
    expect(sportsModuleManifest.routes.map((r) => r.path)).toContain("/api/sports/overview");
    expect(sportsModuleManifest.routes.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "/api/sports/standings-preferences",
        "/api/sports/sources/:id/retry",
        "/api/sports/sources/:id/rebuild/preview",
        "/api/sports/sources/:id/rebuild",
        "/api/sports/sources/:id/photos"
      ])
    );
    expect(sportsModuleManifest.dataLifecycle?.exportSections).toEqual([
      {
        key: "sportsSources",
        displayName: "Sports sources",
        collect: collectSportsSourcesExportSection
      }
    ]);
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

  it("accepts a complete HTTPS target through the Moss confirmation boundary", async () => {
    const tool = sportsModuleManifest.assistantTools.find(
      ({ name }) => name === "sports.confirmSourceRecipe"
    );
    const input = {
      sourceId: "22222222-2222-4222-8222-222222222222",
      confirmationId: "confirmation-1",
      authorizationAcknowledgement: "I am authorized.",
      canonicalDomain: "www.publisher.example",
      confirmedFetchHosts: ["www.publisher.example"],
      targets: [
        {
          target: {
            kind: "follow",
            followId: "11111111-1111-4111-8111-111111111111"
          },
          targetUrl: "https://www.publisher.example/feed?format=atom"
        }
      ]
    };

    await expect(
      validateToolInput(tool?.inputSchema, input, {
        external: false,
        toolName: "sports.confirmSourceRecipe"
      })
    ).resolves.toEqual(input);
    await expect(
      validateToolInput(
        tool?.inputSchema,
        {
          ...input,
          targets: [{ ...input.targets[0], targetUrl: "http://www.publisher.example/feed" }]
        },
        { external: false, toolName: "sports.confirmSourceRecipe" }
      )
    ).rejects.toThrow("targets[0].targetUrl has an invalid format");
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
      "s.espncdn.com",
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
  // #2253: an over-long description is not a style nit — the module registry throws while
  // loading the built-in module list, so the API and the worker both refuse to start.
  it("keeps every app-map description inside the length the registry enforces", () => {
    const LIMIT = 240;
    const entries = [
      ...sportsModuleManifest.navigation.map((s) => [`navigation ${s.id}`, s.description] as const),
      ...sportsModuleManifest.settings.map((s) => [`settings ${s.id}`, s.description] as const),
      ...(sportsModuleManifest.features ?? []).map(
        (f) => [`feature ${f.id}`, f.description] as const
      )
    ];
    const tooLong = entries
      .filter(([, description]) => description.trim().length > LIMIT)
      .map(([label, description]) => `${label}: ${description.trim().length}`);
    expect(tooLong).toEqual([]);
    expect(entries.every(([, description]) => description.trim().length > 0)).toBe(true);
  });

  // The registry validates every built-in module the moment it is loaded, which is what the API
  // and the worker do on boot — so a successful import here is a real start-up check, not a proxy.
  it("loads the built-in module list the API and worker boot from", async () => {
    await expect(import("../../packages/module-registry/src/index.js")).resolves.toBeDefined();
  });
});

describe("sports manifest keeps its subreddit-source promise truthful (review #2210, 2026-09-04)", () => {
  it("does not claim to filter out pinned posts, since Reddit's feed carries no pinned flag to filter on", () => {
    const entry = sportsModuleManifest.features.find((f) => f.id === "sports.subreddit_sources");
    expect(entry?.description).not.toMatch(
      /stick(y|ied)|pinned posts.*(skipped|filtered|removed)/i
    );
  });

  it("actually includes a pinned-looking post when it links out, matching the corrected promise", () => {
    // Reddit's Atom feed has no field marking a post as pinned/stickied at all — a `category`
    // some subreddits use for an "Announcement" flair is the closest thing, and it is not a
    // pinned signal. redditEntryToHeadline() only ever looks at the outbound [link] anchor, so a
    // would-be-pinned post that links to an article comes through like any other post does.
    const html =
      `<!-- SC_OFF --><div class="md"><p>Body</p></div><!-- SC_ON --> submitted by ` +
      `<a href="https://www.reddit.com/user/mods"> /u/mods </a> <br/> ` +
      `<span><a href="https://www.espn.com/nfl/story/_/id/1/season-preview">[link]</a></span> ` +
      `<span><a href="https://www.reddit.com/r/nfl/comments/pin1/thread/">[comments]</a></span>`;
    const escaped = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const entryXml =
      `<entry><author><name>/u/mods</name></author><category term="nfl" label="r/nfl"/>` +
      `<content type="html">${escaped}</content><id>t3_pin1</id>` +
      `<link href="https://www.reddit.com/r/nfl/comments/pin1/thread/" />` +
      `<updated>2025-09-04T14:13:20+00:00</updated><published>2025-09-04T14:13:20+00:00</published>` +
      `<title>Season preview megathread</title></entry>`;
    expect(redditEntryToHeadline(entryXml)).not.toBeNull();
  });
});
