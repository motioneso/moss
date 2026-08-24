import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";

import { NEWS_MAX_CUSTOM_SOURCES } from "@moss/news";
import { SportsSourcesRepository } from "../../packages/sports/src/source/repository.js";
import type { VerifiedSportsSourceCandidate } from "../../packages/sports/src/source/discovery.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;
const repo = new SportsSourcesRepository();

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

  it("enables and forces RLS on all four #1572 tables", async () => {
    const result = await bootstrap.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE nspname = 'app' AND relname = ANY($1) ORDER BY relname`,
      [
        [
          "sports_custom_sources",
          "sports_headline_prefs",
          "sports_policy_verdicts",
          "sports_source_assignments"
        ]
      ]
    );
    expect(result.rows).toEqual([
      { relname: "sports_custom_sources", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "sports_headline_prefs", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "sports_policy_verdicts", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "sports_source_assignments", relrowsecurity: true, relforcerowsecurity: true }
    ]);
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
              followId: follow.rows[0].id,
              competitionKey: "eng.1",
              competitionLabel: "Premier League",
              teamKey: "arsenal",
              teamLabel: "Arsenal",
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
      followId,
      competitionKey: "nfl",
      competitionLabel: "NFL",
      teamKey,
      teamLabel: teamKey,
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
      repo.replaceAssignments(db, created.id, [retained.id], [target(follows.rows[2].id, "three")])
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

  it("persists target results and transactionally derives truthful source health", async () => {
    const follows = await bootstrap.query(
      `INSERT INTO app.sports_follows (owner_user_id, competition_key, team_key)
       VALUES ($1, 'nfl', 'one'), ($1, 'nfl', 'two') RETURNING id`,
      [ids.userA]
    );
    const base = candidate(1);
    const checkedAt = "2026-08-23T12:00:00.000Z";
    const target = (followId: string, teamKey: string) => ({
      followId,
      competitionKey: "nfl",
      competitionLabel: "NFL",
      teamKey,
      teamLabel: teamKey,
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
              followId: follow.rows[0].id,
              competitionKey: "eng.1",
              competitionLabel: "Premier League",
              teamKey: "arsenal",
              teamLabel: "Arsenal",
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
              followId: follow.rows[0].id,
              competitionKey: "eng.1",
              competitionLabel: "Premier League",
              teamKey: "arsenal",
              teamLabel: "Arsenal",
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
