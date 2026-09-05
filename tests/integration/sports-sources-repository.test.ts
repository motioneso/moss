import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import {
  createDatabase,
  DataContextRunner,
  runSqlMigrations,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { Kysely } from "kysely";

import { NEWS_MAX_CUSTOM_SOURCES } from "@moss/news";
import { SportsEspnCoverageRepository } from "../../packages/sports/src/source/espn-coverage-repository.js";
import { SportsSourcesRepository } from "../../packages/sports/src/source/repository.js";
import {
  clearSportsPhotoRule,
  recordSportsPhotoOutcome,
  setSportsPhotoRule
} from "../../packages/sports/src/source/photo-storage.js";
import type { VerifiedSportsSourceCandidate } from "../../packages/sports/src/source/discovery.js";
import { sportsModuleSqlMigrationDirectory } from "../../packages/sports/src/manifest.js";
import {
  connectionStrings,
  ids,
  resetEmptyFoundationDatabase,
  resetFoundationDatabase
} from "./test-database.js";

const { Client } = pg;
const repo = new SportsSourcesRepository();
const espnRepo = new SportsEspnCoverageRepository();

const candidate = (
  index: number
): Extract<VerifiedSportsSourceCandidate, { retrievalMethod: "feed" }> => ({
  candidateId: `candidate-${index}`,
  label: `Publisher ${index}`,
  canonicalDomain: `publisher-${index}.example.com`,
  homepageUrl: `https://publisher-${index}.example.com/`,
  feedUrl: `https://publisher-${index}.example.com/feed.xml`,
  retrievalMethod: "feed",
  sampleCount: 1,
  validationFingerprint: "opaque-fingerprint",
  recipe: null,
  recipeFingerprint: null,
  confirmedFetchHosts: [`publisher-${index}.example.com`],
  targets: [],
  checkedAt: "2026-08-23T12:00:00.000Z",
  samples: []
});

describe("sports legacy feed assignment migration repair", () => {
  it("backfills target identity under FORCE RLS and restores protection", async () => {
    await resetEmptyFoundationDatabase();
    const bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
    try {
      await bootstrap.query(`DELETE FROM app.schema_migrations WHERE version = '0193'`);
      const ownerId = "60000000-0000-4000-8000-000000000003";
      await bootstrap.query(
        `INSERT INTO app.users (id, email, name, is_instance_admin)
         VALUES ($1, 'sports-feed-upgrade@example.com', 'Feed Upgrade', false)`,
        [ownerId]
      );
      const follow = await bootstrap.query<{ id: string }>(
        `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
         VALUES ($1, 'nhl', 'ana') RETURNING id`,
        [ownerId]
      );
      const source = await bootstrap.query<{ id: string }>(
        `INSERT INTO app.sports_custom_sources (
           owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method,
           validation_fingerprint, validated_at, recipe_status, confirmed_fetch_hosts,
           authorization_confirmed_at
         ) VALUES (
           $1, 'Legacy feed', 'feed.example.com', 'https://feed.example.com/',
           'https://feed.example.com/rss', 'feed', 'legacy-fingerprint', now(), 'feed',
           ARRAY['feed.example.com'], now()
         ) RETURNING id`,
        [ownerId]
      );
      await bootstrap.query(
        `INSERT INTO app.sports_source_assignments (owner_user_id, source_id, follow_id)
         VALUES ($1, $2, $3)`,
        [ownerId, source.rows[0]!.id, follow.rows[0]!.id]
      );

      const result = await runSqlMigrations({
        connectionString: connectionStrings.migration,
        migrationsDirectory: sportsModuleSqlMigrationDirectory
      });
      expect(result.applied.map((migration) => migration.version)).toEqual(["0193"]);

      await expect(
        bootstrap.query(
          `SELECT target_url, preview_status
             FROM app.sports_source_assignments
            WHERE source_id = $1`,
          [source.rows[0]!.id]
        )
      ).resolves.toMatchObject({
        rows: [{ target_url: "https://feed.example.com/rss", preview_status: "verified" }]
      });
      await expect(
        bootstrap.query(
          `SELECT relrowsecurity, relforcerowsecurity
             FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
            WHERE nspname = 'app' AND relname = 'sports_source_assignments'`
        )
      ).resolves.toMatchObject({ rows: [{ relrowsecurity: true, relforcerowsecurity: true }] });
    } finally {
      await bootstrap.end();
    }
  });
});

describe("sports sources repository", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let bootstrap: pg.Client;

  const asActor = <T>(actorUserId: string, fn: (db: DataContextDb) => Promise<T>): Promise<T> =>
    dataContext.withDataContext({ actorUserId, requestId: crypto.randomUUID() }, fn);

  beforeEach(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
    await bootstrap.connect();
  });

  afterEach(async () => {
    await Promise.allSettled([appDb.destroy(), bootstrap.end()]);
  });

  it("enables and forces RLS on every sports source preference table", async () => {
    const result = await bootstrap.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE nspname = 'app' AND relname = ANY($1) ORDER BY relname`,
      [
        [
          "sports_custom_sources",
          "sports_espn_source_assignments",
          "sports_headline_prefs",
          "sports_policy_verdicts",
          "sports_source_assignments"
        ]
      ]
    );
    expect(result.rows).toEqual([
      { relname: "sports_custom_sources", relrowsecurity: true, relforcerowsecurity: true },
      {
        relname: "sports_espn_source_assignments",
        relrowsecurity: true,
        relforcerowsecurity: true
      },
      { relname: "sports_headline_prefs", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "sports_policy_verdicts", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "sports_source_assignments", relrowsecurity: true, relforcerowsecurity: true }
    ]);
  });

  it("defaults ESPN to all sports and owner-isolates explicit coverage", async () => {
    await expect(asActor(ids.userA, (db) => espnRepo.get(db))).resolves.toEqual({
      enabled: true,
      usesDefaultCoverage: true,
      assignments: []
    });
    const follow = await bootstrap.query<{ id: string }>(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'eng.1', 'liverpool') RETURNING id`,
      [ids.userA]
    );
    const followId = follow.rows[0]!.id;

    const coverage = await asActor(ids.userA, (db) =>
      espnRepo.replace(db, [
        { kind: "sport", sportKey: "soccer" },
        { kind: "follow", followId }
      ])
    );
    expect(coverage).toMatchObject({ enabled: true, usesDefaultCoverage: false });
    expect(coverage.assignments).toEqual(
      expect.arrayContaining([
        { kind: "sport", sportKey: "soccer" },
        { kind: "follow", followId }
      ])
    );
    await expect(
      asActor(ids.userB, (db) => espnRepo.replace(db, [{ kind: "follow", followId }]))
    ).rejects.toThrow("unavailable follow");
    await expect(asActor(ids.userB, (db) => espnRepo.get(db))).resolves.toEqual({
      enabled: true,
      usesDefaultCoverage: true,
      assignments: []
    });

    await expect(asActor(ids.userA, (db) => espnRepo.replace(db, []))).resolves.toEqual({
      enabled: false,
      usesDefaultCoverage: false,
      assignments: []
    });
  });

  it("caps sources at the shared custom-source limit per owner", async () => {
    for (let index = 1; index <= NEWS_MAX_CUSTOM_SOURCES; index += 1) {
      const created = await asActor(ids.userA, (db) =>
        repo.create(db, { candidate: candidate(index) })
      );
      expect(created).toMatchObject({ canonicalDomain: `publisher-${index}.example.com` });
    }
    await expect(
      asActor(ids.userA, (db) =>
        repo.create(db, { candidate: candidate(NEWS_MAX_CUSTOM_SOURCES + 1) })
      )
    ).resolves.toEqual({ limitExceeded: true });
  });

  it("owner-isolates list, remove, and assignment writes across actors", async () => {
    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");

    await expect(asActor(ids.userB, (db) => repo.list(db))).resolves.toEqual([]);
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      { id: created.id }
    ]);

    await expect(asActor(ids.userB, (db) => repo.remove(db, created.id))).resolves.toBe(false);
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      { id: created.id }
    ]);
    await expect(
      asActor(ids.userB, (db) => repo.setAssignments(db, created.id, []))
    ).resolves.toBeNull();

    expect(await asActor(ids.userA, (db) => repo.remove(db, created.id))).toBe(true);
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toEqual([]);
  });

  it("gives up on a saved photo place after three empty refreshes, and comes back on a hit", async () => {
    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const rule = {
      version: 1,
      kind: "html",
      fetchHosts: ["publisher-1.example.com"],
      photo: { selector: "meta[property='og:image']", source: "attribute", attribute: "content" },
      fallback: "share_image"
    };
    await expect(
      asActor(ids.userA, (db) => setSportsPhotoRule(db, created.id, rule, "in_use"))
    ).resolves.toBe(true);

    const photoState = async () => {
      const row = await bootstrap.query<{
        photo_rule_state: string;
        photo_miss_streak: number;
        photo_last_outcome: string | null;
        photo_relook_at: Date | null;
      }>(
        `SELECT photo_rule_state, photo_miss_streak, photo_last_outcome, photo_relook_at
           FROM app.sports_custom_sources WHERE id = $1`,
        [created.id]
      );
      return row.rows[0]!;
    };

    for (const expected of [1, 2]) {
      await asActor(ids.userA, (db) => recordSportsPhotoOutcome(db, created.id, "none"));
      const state = await photoState();
      expect(state).toMatchObject({
        photo_rule_state: "in_use",
        photo_miss_streak: expected,
        photo_last_outcome: "none"
      });
      expect(state.photo_relook_at).toBeNull();
    }

    const at = new Date("2026-09-04T12:00:00.000Z");
    await asActor(ids.userA, (db) => recordSportsPhotoOutcome(db, created.id, "none", at));
    const gaveUp = await photoState();
    expect(gaveUp).toMatchObject({ photo_rule_state: "stale", photo_miss_streak: 3 });
    expect(gaveUp.photo_relook_at?.toISOString()).toBe("2026-09-05T12:00:00.000Z");
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      { photoStatus: "stopped_working", photosFoundByMoss: true }
    ]);

    await asActor(ids.userA, (db) => recordSportsPhotoOutcome(db, created.id, "working"));
    const recovered = await photoState();
    expect(recovered).toMatchObject({
      photo_rule_state: "in_use",
      photo_miss_streak: 0,
      photo_last_outcome: "working"
    });
    expect(recovered.photo_relook_at).toBeNull();
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      { photoStatus: "working", photosFoundByMoss: true }
    ]);

    await expect(asActor(ids.userA, (db) => clearSportsPhotoRule(db, created.id))).resolves.toBe(
      true
    );
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      { photoStatus: "working", photosFoundByMoss: false }
    ]);
  });

  it("keeps one owner's saved photo place out of another owner's reach", async () => {
    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const rule = {
      version: 1,
      kind: "html",
      fetchHosts: ["publisher-1.example.com"],
      photo: { selector: "meta[property='og:image']", source: "attribute", attribute: "content" },
      fallback: "share_image"
    };
    await asActor(ids.userA, (db) => setSportsPhotoRule(db, created.id, rule, "in_use"));

    await expect(
      asActor(ids.userB, (db) => setSportsPhotoRule(db, created.id, rule, "in_use"))
    ).resolves.toBe(false);
    await expect(asActor(ids.userB, (db) => clearSportsPhotoRule(db, created.id))).resolves.toBe(
      false
    );
    await expect(
      asActor(ids.userB, (db) => repo.listRuntimeSources(db, created.id))
    ).resolves.toEqual([]);
    await expect(
      asActor(ids.userA, (db) => repo.listRuntimeSources(db, created.id))
    ).resolves.toMatchObject([{ photoRule: { photo: { attribute: "content" } } }]);
    await asActor(ids.userA, (db) => recordSportsPhotoOutcome(db, created.id, "working"));
    await expect(asActor(ids.userB, (db) => repo.list(db))).resolves.toEqual([]);
  });

  it("persists confirmed feed authority without a scrape recipe", async () => {
    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");

    const result = await bootstrap.query(
      `SELECT recipe_json, recipe_schema_version, recipe_fingerprint, recipe_status,
              confirmed_fetch_hosts, authorization_confirmed_at, validated_at
         FROM app.sports_custom_sources WHERE id = $1`,
      [created.id]
    );
    expect(result.rows[0]).toMatchObject({
      recipe_json: null,
      recipe_schema_version: null,
      recipe_fingerprint: null,
      recipe_status: "feed",
      confirmed_fetch_hosts: ["publisher-1.example.com"]
    });
    expect(result.rows[0].authorization_confirmed_at).toEqual(result.rows[0].validated_at);
  });

  it("persists one verified sport target without inventing a follow", async () => {
    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const updated = await asActor(ids.userA, (db) =>
      repo.replaceScopeAssignments(
        db,
        created.id,
        [],
        [
          {
            target: { kind: "sport", sportKey: "soccer" },
            targetUrl: "https://publisher-1.example.com/feed.xml",
            parameters: {},
            checkedAt: "2026-08-25T12:00:00.000Z"
          }
        ]
      )
    );
    expect(updated).toMatchObject({
      assignedFollowIds: [],
      assignments: [{ followId: null, sportKey: "soccer", previewStatus: "verified" }]
    });
    const runtime = await asActor(ids.userA, (db) => repo.listRuntimeSources(db, created.id));
    expect(runtime[0]?.assignments[0]?.scope).toEqual({ kind: "sport", sportKey: "soccer" });
  });

  it("atomically persists verified target identity and preview health", async () => {
    const follow = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'eng.1', 'arsenal') RETURNING id`,
      [ids.userA]
    );
    const checkedAt = "2026-08-23T12:00:00.000Z";
    const base = candidate(1);
    const created = await asActor(ids.userA, (db) =>
      repo.create(db, {
        candidate: {
          ...base,
          checkedAt,
          targets: [
            {
              target: { kind: "follow", followId: follow.rows[0].id },
              label: "Arsenal",
              scope: "team",
              targetUrl: base.feedUrl,
              parameters: {},
              samples: [{ headline: "Arsenal story" }],
              checkedAt
            }
          ]
        }
      })
    );
    if ("limitExceeded" in created) throw new Error("unexpected limit");

    expect(created).toMatchObject({
      healthState: "healthy",
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt,
      assignedFollowIds: [follow.rows[0].id],
      assignments: [
        {
          followId: follow.rows[0].id,
          targetUrl: base.feedUrl,
          previewStatus: "verified",
          healthState: "healthy",
          lastCheckedAt: checkedAt,
          lastSuccessAt: checkedAt
        }
      ]
    });
    const runtime = await asActor(ids.userA, (db) => repo.listRuntimeSources(db, created.id));
    expect(runtime[0]?.assignments[0]?.scope).toEqual({
      kind: "team",
      sportKey: "soccer",
      competitionKey: "eng.1",
      teamKey: "arsenal"
    });
  });

  it("atomically replaces assignments while retaining unchanged target health", async () => {
    const follows = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'nfl', 'one'), ($1, 'nfl', 'two'), ($1, 'nfl', 'three') RETURNING id`,
      [ids.userA]
    );
    const checkedAt = "2026-08-23T12:00:00.000Z";
    const base = candidate(1);
    const target = (followId: string, teamKey: string) => ({
      target: { kind: "follow" as const, followId },
      label: teamKey,
      scope: "team" as const,
      targetUrl: base.feedUrl,
      parameters: {},
      samples: [],
      checkedAt
    });
    const created = await asActor(ids.userA, (db) =>
      repo.create(db, {
        candidate: {
          ...base,
          targets: [target(follows.rows[0].id, "one"), target(follows.rows[1].id, "two")]
        }
      })
    );
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const retained = created.assignments.find(
      (assignment) => assignment.followId === follows.rows[0].id
    );
    if (!retained) throw new Error("retained assignment missing");
    await bootstrap.query(
      `UPDATE app.sports_source_assignments
          SET health_state = 'unsupported', health_reason_code = 'unsupported_shape',
              health_message = 'This public source shape is unsupported.'
        WHERE id = $1`,
      [retained.id]
    );

    const result = await asActor(ids.userA, (db) =>
      repo.replaceScopeAssignments(
        db,
        created.id,
        [retained.id],
        [target(follows.rows[2].id, "three")]
      )
    );

    expect(result).toMatchObject({
      healthState: "failing",
      healthReasonCode: "partial_target_failure",
      assignedFollowIds: [follows.rows[0].id, follows.rows[2].id],
      assignments: [
        {
          id: retained.id,
          followId: follows.rows[0].id,
          healthState: "unsupported",
          lastCheckedAt: checkedAt,
          lastSuccessAt: checkedAt
        },
        {
          followId: follows.rows[2].id,
          healthState: "healthy",
          lastCheckedAt: checkedAt,
          lastSuccessAt: checkedAt
        }
      ]
    });
  });

  it("atomically replaces a recipe and all verified target identities", async () => {
    const follow = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'eng.1', 'arsenal') RETURNING id`,
      [ids.userA]
    );
    const base = candidate(1);
    const target = (targetUrl: string, targetCheckedAt: string) => ({
      target: { kind: "follow" as const, followId: follow.rows[0].id },
      label: "Arsenal",
      scope: "team" as const,
      targetUrl,
      parameters: {},
      samples: [],
      checkedAt: targetCheckedAt
    });
    const created = await asActor(ids.userA, (db) =>
      repo.create(db, { candidate: { ...base, targets: [target(base.feedUrl, base.checkedAt)] } })
    );
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const rebuiltAt = "2026-08-24T12:00:00.000Z";
    const rebuiltFeed = "https://publisher-1.example.com/rebuilt.xml";

    const rebuilt = await asActor(ids.userA, (db) =>
      repo.replaceRecipe(db, created.id, {
        ...base,
        label: "Rebuilt Publisher",
        feedUrl: rebuiltFeed,
        validationFingerprint: "rebuilt-fingerprint",
        checkedAt: rebuiltAt,
        targets: [target(rebuiltFeed, rebuiltAt)]
      })
    );

    expect(rebuilt).toMatchObject({
      label: "Rebuilt Publisher",
      healthState: "healthy",
      lastCheckedAt: rebuiltAt,
      lastSuccessAt: rebuiltAt,
      assignments: [
        {
          followId: follow.rows[0].id,
          targetUrl: rebuiltFeed,
          previewStatus: "verified",
          healthState: "healthy",
          lastCheckedAt: rebuiltAt,
          lastSuccessAt: rebuiltAt
        }
      ]
    });
    expect(rebuilt?.assignments[0]?.id).not.toBe(created.assignments[0]?.id);
    await expect(
      asActor(ids.userA, (db) => repo.getBaseline(db, created.id))
    ).resolves.toMatchObject({
      validationFingerprint: "rebuilt-fingerprint",
      assignments: [{ targetUrl: rebuiltFeed }]
    });
  });

  it("persists target results and transactionally derives truthful source health", async () => {
    const follows = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'nfl', 'one'), ($1, 'nfl', 'two') RETURNING id`,
      [ids.userA]
    );
    const base = candidate(1);
    const checkedAt = "2026-08-23T12:00:00.000Z";
    const target = (followId: string, teamKey: string) => ({
      target: { kind: "follow" as const, followId },
      label: teamKey,
      scope: "team" as const,
      targetUrl: base.feedUrl,
      parameters: {},
      samples: [],
      checkedAt
    });
    const created = await asActor(ids.userA, (db) =>
      repo.create(db, {
        candidate: {
          ...base,
          targets: [target(follows.rows[0].id, "one"), target(follows.rows[1].id, "two")]
        }
      })
    );
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const [first, second] = created.assignments;
    if (!first || !second) throw new Error("assignments missing");
    const runtimeResult = (
      assignment: typeof first,
      healthState: "healthy" | "failing" | "unsupported" | "auth_required",
      healthReasonCode: string | null,
      resultCheckedAt: Date | null
    ) => ({
      sourceId: created.id,
      assignmentId: assignment.id,
      runtimeFingerprint: base.validationFingerprint,
      targetUrl: assignment.targetUrl,
      targetParameters: {},
      healthState,
      healthReasonCode,
      healthMessage: healthReasonCode ? "Safe bounded failure." : null,
      checkedAt: resultCheckedAt
    });

    const failureAt = new Date("2026-08-24T10:00:00.000Z");
    await asActor(ids.userA, (db) =>
      repo.persistRuntimeResults(db, [
        runtimeResult(first, "failing", "upstream_unavailable", failureAt)
      ])
    );
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      {
        healthState: "failing",
        healthReasonCode: "partial_target_failure",
        lastCheckedAt: failureAt.toISOString(),
        lastSuccessAt: checkedAt,
        assignments: [
          {
            id: first.id,
            healthState: "failing",
            lastCheckedAt: failureAt.toISOString(),
            lastSuccessAt: checkedAt
          },
          { id: second.id, healthState: "healthy" }
        ]
      }
    ]);

    const unsupportedAt = new Date("2026-08-24T11:00:00.000Z");
    await asActor(ids.userA, (db) =>
      repo.persistRuntimeResults(db, [
        runtimeResult(first, "unsupported", "unsupported_response", unsupportedAt),
        runtimeResult(second, "unsupported", "unsupported_response", unsupportedAt)
      ])
    );
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      {
        healthState: "unsupported",
        healthReasonCode: "unsupported_response",
        lastCheckedAt: unsupportedAt.toISOString(),
        lastSuccessAt: checkedAt
      }
    ]);

    const noCheck = runtimeResult(first, "failing", "recipe_drift", null);
    await asActor(ids.userA, (db) => repo.persistRuntimeResults(db, [noCheck]));
    await expect(asActor(ids.userA, (db) => repo.list(db))).resolves.toMatchObject([
      {
        lastCheckedAt: unsupportedAt.toISOString(),
        lastSuccessAt: checkedAt,
        assignments: expect.arrayContaining([
          expect.objectContaining({
            id: first.id,
            healthReasonCode: "recipe_drift",
            lastCheckedAt: unsupportedAt.toISOString(),
            lastSuccessAt: checkedAt
          })
        ])
      }
    ]);
  });

  it("discards obsolete fingerprint and assignment identities", async () => {
    const follow = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'eng.1', 'arsenal') RETURNING id`,
      [ids.userA]
    );
    const base = candidate(1);
    const created = await asActor(ids.userA, (db) =>
      repo.create(db, {
        candidate: {
          ...base,
          targets: [
            {
              target: { kind: "follow", followId: follow.rows[0].id },
              label: "Arsenal",
              scope: "team",
              targetUrl: base.feedUrl,
              parameters: {},
              samples: [],
              checkedAt: base.checkedAt
            }
          ]
        }
      })
    );
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const assignment = created.assignments[0]!;
    const result = {
      sourceId: created.id,
      assignmentId: assignment.id,
      runtimeFingerprint: base.validationFingerprint,
      targetUrl: assignment.targetUrl,
      targetParameters: {},
      healthState: "failing" as const,
      healthReasonCode: "upstream_unavailable",
      healthMessage: "Safe bounded failure.",
      checkedAt: new Date("2026-08-24T10:00:00.000Z")
    };

    await bootstrap.query(
      `UPDATE app.sports_custom_sources SET validation_fingerprint = 'replacement' WHERE id = $1`,
      [created.id]
    );
    await expect(
      asActor(ids.userA, (db) => repo.persistRuntimeResults(db, [result]))
    ).resolves.toBe(0);
    await bootstrap.query(
      `UPDATE app.sports_custom_sources SET validation_fingerprint = $2 WHERE id = $1`,
      [created.id, base.validationFingerprint]
    );
    await bootstrap.query(
      `UPDATE app.sports_source_assignments SET target_url = target_url || '?new=1' WHERE id = $1`,
      [assignment.id]
    );
    await expect(
      asActor(ids.userA, (db) => repo.persistRuntimeResults(db, [result]))
    ).resolves.toBe(0);
  });

  it("serializes stale writes behind rebuild and assignment replacement source locks", async () => {
    const follow = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'eng.1', 'arsenal') RETURNING id`,
      [ids.userA]
    );
    const base = candidate(1);
    const created = await asActor(ids.userA, (db) =>
      repo.create(db, {
        candidate: {
          ...base,
          targets: [
            {
              target: { kind: "follow", followId: follow.rows[0].id },
              label: "Arsenal",
              scope: "team",
              targetUrl: base.feedUrl,
              parameters: {},
              samples: [],
              checkedAt: base.checkedAt
            }
          ]
        }
      })
    );
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const assignment = created.assignments[0]!;
    const result = {
      sourceId: created.id,
      assignmentId: assignment.id,
      runtimeFingerprint: base.validationFingerprint,
      targetUrl: assignment.targetUrl,
      targetParameters: {},
      healthState: "healthy" as const,
      healthReasonCode: null,
      healthMessage: null,
      checkedAt: new Date("2026-08-24T10:00:00.000Z")
    };
    const waitUntilBlocked = async (write: Promise<number>): Promise<void> => {
      await expect(
        Promise.race([
          write.then(() => "completed"),
          new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 30))
        ])
      ).resolves.toBe("blocked");
    };

    await bootstrap.query("BEGIN");
    await bootstrap.query(
      `UPDATE app.sports_custom_sources SET validation_fingerprint = 'rebuilt' WHERE id = $1`,
      [created.id]
    );
    const rebuildRace = asActor(ids.userA, (db) => repo.persistRuntimeResults(db, [result]));
    await waitUntilBlocked(rebuildRace);
    await bootstrap.query("COMMIT");
    await expect(rebuildRace).resolves.toBe(0);

    await bootstrap.query("BEGIN");
    await bootstrap.query(
      `UPDATE app.sports_custom_sources SET validation_fingerprint = $2, updated_at = now()
        WHERE id = $1`,
      [created.id, base.validationFingerprint]
    );
    await bootstrap.query(
      `UPDATE app.sports_source_assignments SET target_url = target_url || '?replacement=1'
        WHERE id = $1`,
      [assignment.id]
    );
    const assignmentRace = asActor(ids.userA, (db) => repo.persistRuntimeResults(db, [result]));
    await waitUntilBlocked(assignmentRace);
    await bootstrap.query("COMMIT");
    await expect(assignmentRace).resolves.toBe(0);
  });

  it("rejects inconsistent recipe and assignment preview shapes", async () => {
    await expect(
      bootstrap.query(
        `INSERT INTO app.sports_custom_sources (
           owner_user_id, label, canonical_domain, homepage_url, retrieval_method,
           validation_fingerprint, validated_at, recipe_status, confirmed_fetch_hosts,
           authorization_confirmed_at
         ) VALUES ($1, 'Unsafe', 'unsafe.example', 'https://unsafe.example/', 'scrape',
                   'fp', now(), 'ready', ARRAY['unsafe.example'], now())`,
        [ids.userA]
      )
    ).rejects.toMatchObject({ code: "23514" });

    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");
    const follow = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'nfl', 'chiefs') RETURNING id`,
      [ids.userA]
    );
    await expect(
      bootstrap.query(
        `INSERT INTO app.sports_source_assignments
           (owner_user_id, source_id, follow_id, preview_status)
         VALUES ($1, $2, $3, 'verified')`,
        [ids.userA, created.id, follow.rows[0].id]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces the 20-assignment owner cap across sources", async () => {
    const first = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    const second = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(2) }));
    if ("limitExceeded" in first || "limitExceeded" in second) throw new Error("unexpected limit");

    const follows = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       SELECT $1, 'nfl', 'team-' || value FROM generate_series(1, 21) AS value RETURNING id`,
      [ids.userA]
    );
    await expect(
      asActor(ids.userA, (db) =>
        repo.setAssignments(
          db,
          first.id,
          follows.rows.slice(0, 20).map((row) => row.id)
        )
      )
    ).resolves.toMatchObject({
      assignedFollowIds: expect.arrayContaining(follows.rows.slice(0, 20).map((row) => row.id))
    });
    await expect(
      asActor(ids.userA, (db) => repo.setAssignments(db, second.id, [follows.rows[20].id]))
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("gives the worker only actor-scoped export-safe columns", async () => {
    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");

    await bootstrap.query("SET ROLE jarvis_worker_runtime");
    await bootstrap.query("SELECT set_config('app.actor_user_id', $1, false)", [ids.userA]);
    await expect(
      bootstrap.query(
        `SELECT id, label, recipe_status FROM app.sports_custom_sources WHERE id = $1`,
        [created.id]
      )
    ).resolves.toMatchObject({ rowCount: 1 });
    for (const column of ["recipe_json", "recipe_fingerprint", "confirmed_fetch_hosts"]) {
      await expect(
        bootstrap.query(`SELECT ${column} FROM app.sports_custom_sources WHERE id = $1`, [
          created.id
        ])
      ).rejects.toMatchObject({ code: "42501" });
    }
    for (const column of ["target_parameters", "preview_status"]) {
      await expect(
        bootstrap.query(`SELECT ${column} FROM app.sports_source_assignments`)
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      bootstrap.query("SELECT sport_key FROM app.sports_source_assignments")
    ).resolves.toBeDefined();
    await expect(
      bootstrap.query(
        "SELECT id, owner_user_id, follow_id, sport_key, created_at FROM app.sports_espn_source_assignments"
      )
    ).resolves.toBeDefined();
    await expect(
      bootstrap.query(
        "SELECT owner_user_id, espn_headlines_enabled, updated_at FROM app.sports_headline_prefs"
      )
    ).resolves.toBeDefined();
    await expect(
      bootstrap.query("UPDATE app.sports_headline_prefs SET espn_headlines_enabled = false")
    ).rejects.toMatchObject({ code: "42501" });
  });

  // Postgres FK checks bypass RLS, so setAssignments must not rely on the FK reference to
  // app.sports_follows to reject a cross-owner id. A broken implementation that inserted
  // whatever followIds it was given would silently attach another owner's follow.
  it("drops a followId invisible under the caller's RLS scope instead of assigning it", async () => {
    const created = await asActor(ids.userA, (db) => repo.create(db, { candidate: candidate(1) }));
    if ("limitExceeded" in created) throw new Error("unexpected limit");

    const ownFollow = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'nfl', 'chiefs') RETURNING id`,
      [ids.userA]
    );
    const otherFollow = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'nfl', 'ravens') RETURNING id`,
      [ids.userB]
    );
    const ownFollowId: string = ownFollow.rows[0].id;
    const otherFollowId: string = otherFollow.rows[0].id;

    const result = await asActor(ids.userA, (db) =>
      repo.setAssignments(db, created.id, [ownFollowId, otherFollowId])
    );
    expect(result).toMatchObject({
      assignedFollowIds: [ownFollowId],
      assignments: [
        {
          followId: ownFollowId,
          targetUrl: null,
          previewStatus: "pending",
          healthState: "pending"
        }
      ]
    });
  });
});
