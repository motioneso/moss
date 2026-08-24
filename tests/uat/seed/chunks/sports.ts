import { createHash, randomUUID } from "node:crypto";

import type { DataContextDb, DataContextRunner } from "@moss/db";
import { SportsFollowsRepository, SportsSourcesRepository } from "@moss/sports";

// #1025 "lived-in account": whole-competition follows only. Individual team keys are
// not a static catalog in packages/sports/src (`SPORTS_CATALOG` in source/catalog.ts
// only enumerates competitions) — real team keys come from live ESPN dataset fetches,
// unavailable at seed time, so guessing one (e.g. "nfl-sf-49ers") risks seeding a row
// the real data never resolves. Following whole competitions is real, valid data.
const UAT_SPORTS_FOLLOWS: ReadonlyArray<{ competitionKey: string; teamKey: null }> = [
  { competitionKey: "nfl", teamKey: null },
  { competitionKey: "nba", teamKey: null },
  { competitionKey: "eng.1", teamKey: null }
];

export async function seedSportsChunk(
  runner: DataContextRunner,
  actorUserId: string
): Promise<void> {
  const repo = new SportsFollowsRepository();
  await runner.withDataContext({ actorUserId }, async (scopedDb) => {
    for (const follow of UAT_SPORTS_FOLLOWS) {
      await repo.create(scopedDb, follow);
    }
  });
}

const FIXTURE_DATE = "2026-08-24T12:00:00.000Z";
const RAW_FEED_URL =
  "https://raw.githubusercontent.com/motioneso/moss/build/1909-sports-public-sources/tests/fixtures/sports/1909-shared-feed.xml";
const DRIFT_FEED_URL =
  "https://raw.githack.com/motioneso/moss/build/1909-sports-public-sources/tests/fixtures/sports/1909-shared-feed.xml";

function fixtureFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createFeedSource(
  db: DataContextDb,
  input: {
    readonly label: string;
    readonly canonicalDomain: string;
    readonly feedUrl: string;
    readonly followIds: readonly string[];
  }
) {
  const created = await new SportsSourcesRepository().create(db, {
    candidate: {
      candidateId: randomUUID(),
      label: input.label,
      canonicalDomain: input.canonicalDomain,
      homepageUrl: new URL("/", input.feedUrl).toString(),
      feedUrl: input.feedUrl,
      retrievalMethod: "feed",
      sampleCount: 0,
      validationFingerprint: fixtureFingerprint(input.feedUrl),
      recipe: null,
      recipeFingerprint: null,
      confirmedFetchHosts: [new URL(input.feedUrl).hostname],
      checkedAt: FIXTURE_DATE,
      samples: [],
      targets: input.followIds.map((followId) => ({
        followId,
        competitionKey: "eng.1",
        competitionLabel: "Premier League",
        teamKey: null,
        teamLabel: null,
        scope: "competition" as const,
        targetUrl: input.feedUrl,
        parameters: {},
        samples: [],
        checkedAt: FIXTURE_DATE
      }))
    }
  });
  if ("limitExceeded" in created) throw new Error("#1909 UAT source fixture limit exceeded");
  return created;
}

/** Dedicated #1909 fixtures; absent from every other UAT seed path. */
export async function seedSportsPublicSourceFixtures(
  runner: DataContextRunner,
  actorUserId: string
): Promise<void> {
  const follows = new SportsFollowsRepository();
  await runner.withDataContext({ actorUserId }, async (db) => {
    const league = await follows.create(db, { competitionKey: "eng.1", teamKey: null });
    const team = await follows.create(db, { competitionKey: "eng.1", teamKey: "arsenal" });

    const legacyFeed = await createFeedSource(db, {
      label: "BBC legacy feed",
      canonicalDomain: "feeds.bbci.co.uk",
      feedUrl: "https://feeds.bbci.co.uk/sport/football/rss.xml",
      followIds: [league.id]
    });
    await db.db
      .updateTable("app.sports_custom_sources")
      .set({ health_state: "pending", last_checked_at: null, last_success_at: null })
      .where("id", "=", legacyFeed.id)
      .execute();
    await db.db
      .updateTable("app.sports_source_assignments")
      .set({ health_state: "pending", last_checked_at: null, last_success_at: null })
      .where("source_id", "=", legacyFeed.id)
      .execute();

    const failingFeed = await createFeedSource(db, {
      label: "Issue 1909 fixture feed",
      canonicalDomain: "raw.githubusercontent.com",
      feedUrl: RAW_FEED_URL,
      followIds: [league.id, team.id]
    });
    const failingAssignment = failingFeed.assignments.find(
      (assignment) => assignment.followId === team.id
    );
    if (!failingAssignment) throw new Error("#1909 UAT failing assignment fixture missing");
    await db.db
      .updateTable("app.sports_source_assignments")
      .set({
        health_state: "failing",
        health_reason_code: "network",
        health_message: "The publisher could not be reached."
      })
      .where("id", "=", failingAssignment.id)
      .execute();
    await db.db
      .updateTable("app.sports_custom_sources")
      .set({
        health_state: "failing",
        health_reason_code: "partial_target_failure",
        health_message: "One or more source targets are failing."
      })
      .where("id", "=", failingFeed.id)
      .execute();

    const scrapeRecipe = {
      version: 1 as const,
      kind: "html" as const,
      fetchHosts: ["www.fotmob.com"],
      request: {
        urlTemplate: "https://www.fotmob.com/",
        slots: [],
        headers: { accept: "text/html,application/xhtml+xml" as const }
      },
      scopes: ["team" as const, "competition" as const],
      itemLimit: 10,
      extraction: {
        collectionSelector: "main",
        itemSelector: "article",
        headline: { selector: "h2", source: "text" as const },
        normalize: ["trim" as const]
      }
    };
    const scrapeFingerprint = fixtureFingerprint(JSON.stringify(scrapeRecipe));
    const scrape = await new SportsSourcesRepository().create(db, {
      candidate: {
        candidateId: randomUUID(),
        label: "FotMob legacy scrape",
        canonicalDomain: "fotmob.com",
        homepageUrl: "https://www.fotmob.com/",
        feedUrl: null,
        retrievalMethod: "scrape",
        sampleCount: 0,
        validationFingerprint: scrapeFingerprint,
        recipe: scrapeRecipe,
        recipeFingerprint: scrapeFingerprint,
        confirmedFetchHosts: ["www.fotmob.com"],
        checkedAt: FIXTURE_DATE,
        samples: [],
        targets: [
          {
            followId: team.id,
            competitionKey: "eng.1",
            competitionLabel: "Premier League",
            teamKey: "arsenal",
            teamLabel: "Arsenal",
            scope: "team",
            targetUrl: "https://www.fotmob.com/",
            parameters: {},
            samples: [],
            checkedAt: FIXTURE_DATE
          }
        ]
      }
    });
    if ("limitExceeded" in scrape) throw new Error("#1909 UAT source fixture limit exceeded");
    await db.db
      .updateTable("app.sports_custom_sources")
      .set({
        recipe_json: null,
        recipe_schema_version: null,
        recipe_fingerprint: null,
        recipe_status: "missing",
        health_state: "failing",
        health_reason_code: "recipe_missing",
        health_message: "Rebuild this source recipe before refreshing.",
        last_checked_at: null,
        last_success_at: null
      })
      .where("id", "=", scrape.id)
      .execute();
    await db.db
      .updateTable("app.sports_source_assignments")
      .set({
        preview_status: "recipe_missing",
        health_state: "failing",
        health_reason_code: "recipe_missing",
        health_message: "Rebuild this source recipe before refreshing.",
        last_checked_at: null,
        last_success_at: null
      })
      .where("source_id", "=", scrape.id)
      .execute();

    const driftRecipe = {
      ...scrapeRecipe,
      fetchHosts: ["raw.githack.com"],
      request: {
        ...scrapeRecipe.request,
        urlTemplate: DRIFT_FEED_URL
      }
    };
    const driftFingerprint = fixtureFingerprint(JSON.stringify(driftRecipe));
    const drift = await new SportsSourcesRepository().create(db, {
      candidate: {
        candidateId: randomUUID(),
        label: "Issue 1909 drift fixture",
        canonicalDomain: "raw.githack.com",
        homepageUrl: DRIFT_FEED_URL,
        feedUrl: null,
        retrievalMethod: "scrape",
        sampleCount: 0,
        validationFingerprint: driftFingerprint,
        recipe: driftRecipe,
        recipeFingerprint: driftFingerprint,
        confirmedFetchHosts: ["raw.githack.com"],
        checkedAt: FIXTURE_DATE,
        samples: [],
        targets: [
          {
            followId: league.id,
            competitionKey: "eng.1",
            competitionLabel: "Premier League",
            teamKey: null,
            teamLabel: null,
            scope: "competition",
            targetUrl: DRIFT_FEED_URL,
            parameters: {},
            samples: [],
            checkedAt: FIXTURE_DATE
          }
        ]
      }
    });
    if ("limitExceeded" in drift) throw new Error("#1909 UAT source fixture limit exceeded");
    await db.db
      .updateTable("app.sports_custom_sources")
      .set({
        recipe_status: "drift",
        health_state: "failing",
        health_reason_code: "recipe_drift",
        health_message: "The publisher changed the structure used by this source."
      })
      .where("id", "=", drift.id)
      .execute();
    await db.db
      .updateTable("app.sports_source_assignments")
      .set({
        health_state: "failing",
        health_reason_code: "recipe_drift",
        health_message: "The publisher changed the structure used by this source."
      })
      .where("source_id", "=", drift.id)
      .execute();
  });
}
