import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Job } from "@moss/jobs";
import type { Kysely } from "kysely";
import { VaultContextRunner, readVaultFile, writeVaultFile } from "@moss/vault";

import { fastify, type FastifyInstance } from "fastify";
import { getBuiltInModuleManifests, getModuleDeletionTables } from "@moss/module-registry";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import type { ExportBuildJobPayload } from "../../packages/settings/src/data-export-jobs.js";
import { registerSettingsRoutes } from "../../packages/settings/src/routes.js";
import pg from "pg";

import { HttpError } from "@moss/module-sdk";

const { Client } = pg;

describe("Data export", () => {
  let appDb: Kysely<MossDatabase>;
  let authDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let server: FastifyInstance;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    authDb = createDatabase({ connectionString: connectionStrings.auth, maxConnections: 1 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
    server = fastify();

    registerSettingsRoutes(server, {
      rootDb: appDb,
      dataContext: new DataContextRunner(appDb),
      resolveAccessContext: async (request) => {
        const auth = request.headers.authorization;
        if (!auth || !auth.startsWith("Bearer ")) {
          throw new HttpError(401, "Unauthorized");
        }
        const token = auth.substring(7);
        if (token !== ids.sessionA) {
          throw new HttpError(401, "Unauthorized");
        }
        return { actorUserId: ids.userA, requestId: "req:test" };
      },
      listModuleManifests: () => getBuiltInModuleManifests(),
      moduleDeletionTables: getModuleDeletionTables()
    });

    await server.ready();
  });

  afterAll(async () => {
    await server?.close();
    await appDb?.destroy();
    await authDb?.destroy();
    await workerDb?.destroy();
  });

  it("exports data successfully for the authenticated user and omits sensitive secrets", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/settings/me/data-export",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    if (res.statusCode !== 200) {
      console.error(res.payload);
    }
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="jarv1s-archive-[a-f0-9-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json"$/
    );

    const body = res.json() as { userId: string; tables: { users: { id: string }[] } };
    expect(body.userId).toBe(ids.userA);
    expect(body.tables).toBeDefined();

    // Ensure the users table has the user
    expect(body.tables.users.find((u) => u.id === ids.userA)).toBeDefined();

    // Ensure no secrets are leaked
    expect(res.payload).not.toContain("SECRET"); // None of the secrets from auth settings etc should leak
  });

  it("exports wellness tables (deletion-parity guard: #361)", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/settings/me/data-export",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { tables: Record<string, unknown> };
    // These four tables are purged on account deletion (#361 fix) — confirm they are also exported.
    expect(Array.isArray(body.tables.wellnessCheckins)).toBe(true);
    expect(Array.isArray(body.tables.medications)).toBe(true);
    expect(Array.isArray(body.tables.medicationLogs)).toBe(true);
    expect(Array.isArray(body.tables.wellnessTherapyNotes)).toBe(true);
    expect(Array.isArray(body.tables.jarvisGoals)).toBe(true);
    expect(Array.isArray(body.tables.jarvisGoalEvidence)).toBe(true);
    expect(Array.isArray(body.tables.jarvisActionAuditLog)).toBe(true);
  });

  // #801 Phase A golden test: wellness's dataLifecycle.exportSections collector (in
  // @moss/wellness) now produces the `wellness` archive section instead of settings reading
  // app.wellness_checkins / app.wellness_therapy_notes directly. Byte-compat is the acceptance
  // bar — this pins the exact shape (column names, ordering, null handling) both the sync flat
  // `tables.*` surface and the async nested `sections.wellness` surface must still produce.
  describe("wellness export byte-compat golden test (#801 Phase A)", () => {
    const checkinId = "99999999-0000-4000-8000-000000000001";
    const therapyNoteId = "99999999-0000-4000-8000-000000000002";
    const checkedInAt = "2026-01-15T09:30:00.000Z";
    const checkinCreatedAt = "2026-01-15T09:30:01.000Z";
    const checkinUpdatedAt = "2026-01-15T09:30:02.000Z";
    const noteCreatedAt = "2026-01-16T10:00:00.000Z";
    const noteUpdatedAt = "2026-01-16T10:00:01.000Z";

    const expectedCheckin = {
      id: checkinId,
      ownerUserId: ids.userA,
      checkedInAt,
      feelingCore: "happy",
      feelingSecondary: "calm",
      feelingTertiary: "settled",
      wheelVersion: "jarvis-emotion-v1",
      sensations: ["warmth", "ease"],
      intensity: 3,
      energy: 4,
      note: "Golden fixture note (#801 Phase A byte-compat).",
      identifiedVia: "wheel",
      createdAt: checkinCreatedAt,
      updatedAt: checkinUpdatedAt
    };

    const expectedTherapyNote = {
      id: therapyNoteId,
      ownerUserId: ids.userA,
      body: "Golden fixture therapy note (#801 Phase A byte-compat).",
      linkedCheckinId: null,
      linkedEmotion: null,
      createdAt: noteCreatedAt,
      updatedAt: noteUpdatedAt
    };

    beforeAll(async () => {
      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO app.wellness_checkins
            (id, owner_user_id, checked_in_at, feeling_core, feeling_secondary, feeling_tertiary,
             wheel_version, sensations, intensity, energy, note, identified_via, created_at, updated_at)
           VALUES ($1, $2, $3, 'happy', 'calm', 'settled', 'jarvis-emotion-v1', ARRAY['warmth','ease'],
             3, 4, $4, 'wheel', $5, $6)`,
          [
            checkinId,
            ids.userA,
            checkedInAt,
            expectedCheckin.note,
            checkinCreatedAt,
            checkinUpdatedAt
          ]
        );
        await client.query(
          `INSERT INTO app.wellness_therapy_notes
            (id, owner_user_id, body, linked_checkin_id, linked_emotion, created_at, updated_at)
           VALUES ($1, $2, $3, NULL, NULL, $4, $5)`,
          [therapyNoteId, ids.userA, expectedTherapyNote.body, noteCreatedAt, noteUpdatedAt]
        );
      } finally {
        await client.end();
      }
    });

    afterAll(async () => {
      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query("DELETE FROM app.wellness_therapy_notes WHERE id = $1", [therapyNoteId]);
        await client.query("DELETE FROM app.wellness_checkins WHERE id = $1", [checkinId]);
      } finally {
        await client.end();
      }
    });

    it("sync flat-tables export surface (/api/settings/me/data-export) is byte-compat", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/settings/me/data-export",
        headers: { authorization: `Bearer ${ids.sessionA}` }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        tables: { wellnessCheckins: unknown[]; wellnessTherapyNotes: unknown[] };
      };
      expect(
        body.tables.wellnessCheckins.find((row) => (row as { id: string }).id === checkinId)
      ).toEqual(expectedCheckin);
      expect(
        body.tables.wellnessTherapyNotes.find((row) => (row as { id: string }).id === therapyNoteId)
      ).toEqual(expectedTherapyNote);
    });

    it("async nested-archive export surface (sections.wellness) is byte-compat", async () => {
      const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-export-golden-"));
      const originalVaultRoot = process.env.JARVIS_VAULT_ROOT;
      process.env.JARVIS_VAULT_ROOT = vaultRoot;
      try {
        const { handleExportBuildJob } =
          await import("../../packages/settings/src/data-export-jobs.js");
        const repository = new (
          await import("../../packages/settings/src/data-export-repository.js")
        ).DataExportRepository();
        const dataContext = new DataContextRunner(appDb);
        const jobRecord = await dataContext.withDataContext(
          { actorUserId: ids.userA, requestId: "req:test" },
          (scopedDb) => repository.createJob(scopedDb, ids.userA)
        );

        await dataContext.withDataContext(
          { actorUserId: ids.userA, requestId: "req:test" },
          (scopedDb) => {
            const jobPayload = {
              data: {
                actorUserId: ids.userA,
                jobId: jobRecord.id,
                kind: "export.build" as const
              }
            } as Job<ExportBuildJobPayload>;
            return handleExportBuildJob(jobPayload, scopedDb, () => getBuiltInModuleManifests());
          }
        );

        const vaultRunner = new VaultContextRunner(vaultRoot);
        const archiveJson = await vaultRunner.withVaultContext(
          { actorUserId: ids.userA },
          (vaultCtx) => readVaultFile(vaultCtx, `exports/${jobRecord.id}.json`)
        );
        const archive = JSON.parse(archiveJson) as {
          sections: { wellness: { checkins: unknown[]; therapy_notes: unknown[] } };
        };

        expect(
          archive.sections.wellness.checkins.find((row) => (row as { id: string }).id === checkinId)
        ).toEqual(expectedCheckin);
        expect(
          archive.sections.wellness.therapy_notes.find(
            (row) => (row as { id: string }).id === therapyNoteId
          )
        ).toEqual(expectedTherapyNote);
      } finally {
        if (originalVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
        else process.env.JARVIS_VAULT_ROOT = originalVaultRoot;
        await rm(vaultRoot, { recursive: true, force: true });
      }
    });
  });

  // User-authored preferences appear in exports; snapshots and opaque validation data do not.
  describe("module-owned export sections", () => {
    const sourceId = "99999999-0000-4000-8000-000000000101";
    const topicId = "99999999-0000-4000-8000-000000000102";
    const exclusionId = "99999999-0000-4000-8000-000000000103";
    const userBExclusionId = "99999999-0000-4000-8000-000000000104";
    // Greppable leak markers that cannot collide with fixture prose.
    const sourceFingerprint = "NEWS-FP-MARKER-SOURCE-A";
    const topicFingerprint = "NEWS-FP-MARKER-TOPIC-A";
    const snapshotMarker = "NEWS-SNAPSHOT-MARKER-A";
    const userBDomain = "userb-secret-publisher.example";
    const sportsFollowId = "99999999-0000-4000-8000-000000000201";
    const sportsSourceId = "99999999-0000-4000-8000-000000000202";
    const sportsAssignmentId = "99999999-0000-4000-8000-000000000203";
    const userBSportsSourceId = "99999999-0000-4000-8000-000000000204";
    const sportsEspnAssignmentId = "99999999-0000-4000-8000-000000000205";
    const sportsFingerprint = "SPORTS-FINGERPRINT-MARKER-A";
    const sportsRecipeMarker = "SPORTS-RECIPE-MARKER-A";
    const sportsParameterMarker = "SPORTS-PARAMETER-MARKER-A";
    const sportsPrivateHost = "private-host-marker.example";
    const userBSportsDomain = "userb-sports-secret.example";

    const expectedSource = {
      id: sourceId,
      ownerUserId: ids.userA,
      label: "The Example Gazette",
      canonicalDomain: "gazette.example",
      homepageUrl: "https://gazette.example",
      feedUrl: "https://gazette.example/feed.xml",
      retrievalMethod: "feed",
      validationStatus: "approved",
      healthStatus: "available",
      validatedAt: "2026-02-01T08:00:00.000Z",
      createdAt: "2026-02-01T08:00:01.000Z",
      updatedAt: "2026-02-01T08:00:02.000Z"
    };

    const expectedTopic = {
      id: topicId,
      ownerUserId: ids.userA,
      label: "Fusion energy progress",
      guidance: "Focus on grid-scale milestones",
      validationStatus: "approved",
      validatedAt: "2026-02-02T08:00:00.000Z",
      createdAt: "2026-02-02T08:00:01.000Z",
      updatedAt: "2026-02-02T08:00:02.000Z"
    };

    const expectedExclusion = {
      id: exclusionId,
      ownerUserId: ids.userA,
      canonicalDomain: "excluded-publisher.example",
      createdAt: "2026-02-03T08:00:00.000Z"
    };

    const expectedSportsSource = {
      id: sportsSourceId,
      ownerUserId: ids.userA,
      label: "Example Sports",
      canonicalDomain: "sports.example",
      homepageUrl: "https://sports.example",
      feedUrl: null,
      retrievalMethod: "scrape",
      enabled: true,
      healthState: "healthy",
      healthReasonCode: null,
      healthMessage: null,
      lastCheckedAt: "2026-02-04T08:00:00.000Z",
      lastSuccessAt: "2026-02-04T08:00:00.000Z",
      recipeStatus: "ready",
      recipeSchemaVersion: 1,
      authorizationConfirmedAt: "2026-02-04T07:59:00.000Z",
      validatedAt: "2026-02-04T07:58:00.000Z",
      createdAt: "2026-02-04T08:00:01.000Z",
      updatedAt: "2026-02-04T08:00:02.000Z"
    };

    const expectedSportsAssignment = {
      id: sportsAssignmentId,
      ownerUserId: ids.userA,
      sourceId: sportsSourceId,
      followId: null,
      sportKey: "football",
      targetUrl: "https://sports.example/team/7",
      healthState: "healthy",
      healthReasonCode: null,
      healthMessage: null,
      lastCheckedAt: "2026-02-04T08:00:00.000Z",
      lastSuccessAt: "2026-02-04T08:00:00.000Z",
      createdAt: "2026-02-04T08:00:03.000Z"
    };

    const expectedSportsEspnAssignment = {
      id: sportsEspnAssignmentId,
      ownerUserId: ids.userA,
      followId: sportsFollowId,
      sportKey: null,
      createdAt: "2026-02-04T08:00:04.000Z"
    };

    const expectedSportsHeadlinePreference = {
      ownerUserId: ids.userA,
      espnHeadlinesEnabled: false,
      updatedAt: "2026-02-04T08:00:05.000Z"
    };

    beforeAll(async () => {
      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query(
          `INSERT INTO app.news_custom_sources
            (id, owner_user_id, label, canonical_domain, homepage_url, feed_url,
             retrieval_method, validation_status, health_status, validation_fingerprint,
             validated_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'feed', 'approved', 'available', $7, $8, $9, $10)`,
          [
            sourceId,
            ids.userA,
            expectedSource.label,
            expectedSource.canonicalDomain,
            expectedSource.homepageUrl,
            expectedSource.feedUrl,
            sourceFingerprint,
            expectedSource.validatedAt,
            expectedSource.createdAt,
            expectedSource.updatedAt
          ]
        );
        await client.query(
          `INSERT INTO app.news_custom_topics
            (id, owner_user_id, label, guidance, validation_status, validation_fingerprint,
             validated_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'approved', $5, $6, $7, $8)`,
          [
            topicId,
            ids.userA,
            expectedTopic.label,
            expectedTopic.guidance,
            topicFingerprint,
            expectedTopic.validatedAt,
            expectedTopic.createdAt,
            expectedTopic.updatedAt
          ]
        );
        await client.query(
          `INSERT INTO app.news_source_exclusions (id, owner_user_id, canonical_domain, created_at)
           VALUES ($1, $2, $3, $4)`,
          [exclusionId, ids.userA, expectedExclusion.canonicalDomain, expectedExclusion.createdAt]
        );
        // Actor-isolation fixture: userB's exclusion must never surface in userA's export.
        await client.query(
          `INSERT INTO app.news_source_exclusions (id, owner_user_id, canonical_domain, created_at)
           VALUES ($1, $2, $3, now())`,
          [userBExclusionId, ids.userB, userBDomain]
        );
        // Real snapshot row (derived data) so the "snapshots are absent" assertions cannot
        // pass vacuously against an empty table.
        await client.query(
          `INSERT INTO app.news_compilation_snapshots
            (owner_user_id, compiled_at, expires_at, payload)
           VALUES ($1, now(), now() + interval '1 hour', $2::jsonb)`,
          [ids.userA, JSON.stringify({ headlines: [{ title: snapshotMarker }] })]
        );
        await client.query(
          `INSERT INTO app.sports_follows
             (id, owner_user_id, competition_key, team_key, created_at)
           VALUES ($1, $2, 'nfl', '7', '2026-02-04T07:57:00.000Z')`,
          [sportsFollowId, ids.userA]
        );
        await client.query(
          `INSERT INTO app.sports_custom_sources
             (id, owner_user_id, label, canonical_domain, homepage_url, retrieval_method,
              health_state, last_checked_at, last_success_at, validation_fingerprint, validated_at,
              created_at, updated_at, recipe_json, recipe_schema_version, recipe_fingerprint,
              recipe_status, confirmed_fetch_hosts, authorization_confirmed_at)
           VALUES ($1, $2, $3, 'sports.example', 'https://sports.example', 'scrape', 'healthy',
                   $4, $4, $5, $6, $7, $8, $9::jsonb, 1, $5, 'ready', $10::text[], $11)`,
          [
            sportsSourceId,
            ids.userA,
            expectedSportsSource.label,
            expectedSportsSource.lastCheckedAt,
            sportsFingerprint,
            expectedSportsSource.validatedAt,
            expectedSportsSource.createdAt,
            expectedSportsSource.updatedAt,
            JSON.stringify({ marker: sportsRecipeMarker }),
            ["sports.example", sportsPrivateHost],
            expectedSportsSource.authorizationConfirmedAt
          ]
        );
        await client.query(
          `INSERT INTO app.sports_source_assignments
             (id, owner_user_id, source_id, sport_key, target_url, target_parameters,
              preview_status, health_state, last_checked_at, last_success_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'verified', 'healthy', $7, $7, $8)`,
          [
            sportsAssignmentId,
            ids.userA,
            sportsSourceId,
            expectedSportsAssignment.sportKey,
            expectedSportsAssignment.targetUrl,
            JSON.stringify({ marker: sportsParameterMarker }),
            expectedSportsAssignment.lastCheckedAt,
            expectedSportsAssignment.createdAt
          ]
        );
        await client.query(
          `INSERT INTO app.sports_espn_source_assignments
             (id, owner_user_id, follow_id, created_at)
           VALUES ($1, $2, $3, $4)`,
          [
            sportsEspnAssignmentId,
            ids.userA,
            sportsFollowId,
            expectedSportsEspnAssignment.createdAt
          ]
        );
        await client.query(
          `INSERT INTO app.sports_headline_prefs
             (owner_user_id, espn_headlines_enabled, updated_at)
           VALUES ($1, false, $2)`,
          [ids.userA, expectedSportsHeadlinePreference.updatedAt]
        );
        await client.query(
          `INSERT INTO app.sports_custom_sources
             (id, owner_user_id, label, canonical_domain, homepage_url, feed_url,
              retrieval_method, validation_fingerprint, validated_at, recipe_status,
              confirmed_fetch_hosts, authorization_confirmed_at)
           VALUES ($1, $2, 'User B sports secret', $3, $4, $5, 'feed', 'user-b-sports-fp',
                   now(), 'feed', $6::text[], now())`,
          [
            userBSportsSourceId,
            ids.userB,
            userBSportsDomain,
            `https://${userBSportsDomain}`,
            `https://${userBSportsDomain}/feed.xml`,
            [userBSportsDomain]
          ]
        );
      } finally {
        await client.end();
      }
    });

    afterAll(async () => {
      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query("DELETE FROM app.news_compilation_snapshots WHERE owner_user_id = $1", [
          ids.userA
        ]);
        await client.query("DELETE FROM app.news_source_exclusions WHERE id = ANY($1::uuid[])", [
          [exclusionId, userBExclusionId]
        ]);
        await client.query("DELETE FROM app.news_custom_topics WHERE id = $1", [topicId]);
        await client.query("DELETE FROM app.news_custom_sources WHERE id = $1", [sourceId]);
        await client.query("DELETE FROM app.sports_headline_prefs WHERE owner_user_id = $1", [
          ids.userA
        ]);
        await client.query("DELETE FROM app.sports_espn_source_assignments WHERE id = $1", [
          sportsEspnAssignmentId
        ]);
        await client.query("DELETE FROM app.sports_custom_sources WHERE id = ANY($1::uuid[])", [
          [sportsSourceId, userBSportsSourceId]
        ]);
        await client.query("DELETE FROM app.sports_follows WHERE id = $1", [sportsFollowId]);
      } finally {
        await client.end();
      }
    });

    it("flat tables surface exports authored preferences, omits snapshots + fingerprints, isolates actors", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/settings/me/data-export",
        headers: { authorization: `Bearer ${ids.sessionA}` }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        tables: {
          newsPersonalization: {
            custom_sources: unknown[];
            custom_topics: unknown[];
            source_exclusions: unknown[];
          };
          sportsSources: {
            assignments: unknown[];
            espnAssignments: unknown[];
            headlinePreferences: unknown[];
            sources: unknown[];
          };
        };
      };

      const section = body.tables.newsPersonalization;
      expect(section).toBeDefined();
      // Exactly the three authored-preference lists — no snapshot key can sneak in.
      expect(Object.keys(section).sort()).toEqual([
        "custom_sources",
        "custom_topics",
        "source_exclusions"
      ]);
      // toEqual pins the full row shape: an extra validationFingerprint key would fail here.
      expect(section.custom_sources.find((row) => (row as { id: string }).id === sourceId)).toEqual(
        expectedSource
      );
      expect(section.custom_topics.find((row) => (row as { id: string }).id === topicId)).toEqual(
        expectedTopic
      );
      expect(
        section.source_exclusions.find((row) => (row as { id: string }).id === exclusionId)
      ).toEqual(expectedExclusion);
      expect(
        body.tables.sportsSources.sources.find(
          (row) => (row as { id: string }).id === sportsSourceId
        )
      ).toEqual(expectedSportsSource);
      expect(
        body.tables.sportsSources.assignments.find(
          (row) => (row as { id: string }).id === sportsAssignmentId
        )
      ).toEqual(expectedSportsAssignment);
      expect(body.tables.sportsSources.espnAssignments).toContainEqual(
        expectedSportsEspnAssignment
      );
      expect(body.tables.sportsSources.headlinePreferences).toEqual([
        expectedSportsHeadlinePreference
      ]);

      // Leak sweep over the entire export payload, not just the news section.
      expect(res.payload).not.toContain(sourceFingerprint);
      expect(res.payload).not.toContain(topicFingerprint);
      expect(res.payload).not.toContain("validationFingerprint");
      expect(res.payload).not.toContain("validation_fingerprint");
      expect(res.payload).not.toContain(snapshotMarker);
      // Actor isolation: userB's exclusion domain/id must not appear in userA's export.
      expect(res.payload).not.toContain(userBDomain);
      expect(res.payload).not.toContain(userBExclusionId);
      expect(res.payload).not.toContain(sportsFingerprint);
      expect(res.payload).not.toContain(sportsRecipeMarker);
      expect(res.payload).not.toContain(sportsParameterMarker);
      expect(res.payload).not.toContain(sportsPrivateHost);
      expect(res.payload).not.toContain(userBSportsDomain);
    });

    it("async nested-archive surface (sections.newsPersonalization) matches and leaks nothing", async () => {
      const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-export-news-"));
      const originalVaultRoot = process.env.JARVIS_VAULT_ROOT;
      process.env.JARVIS_VAULT_ROOT = vaultRoot;
      try {
        const { handleExportBuildJob } =
          await import("../../packages/settings/src/data-export-jobs.js");
        const repository = new (
          await import("../../packages/settings/src/data-export-repository.js")
        ).DataExportRepository();
        const dataContext = new DataContextRunner(appDb);
        const jobRecord = await dataContext.withDataContext(
          { actorUserId: ids.userA, requestId: "req:test" },
          (scopedDb) => repository.createJob(scopedDb, ids.userA)
        );

        const workerDataContext = new DataContextRunner(workerDb);
        await workerDataContext.withDataContext(
          { actorUserId: ids.userA, requestId: "req:test" },
          (scopedDb) => {
            const jobPayload = {
              data: {
                actorUserId: ids.userA,
                jobId: jobRecord.id,
                kind: "export.build" as const
              }
            } as Job<ExportBuildJobPayload>;
            return handleExportBuildJob(jobPayload, scopedDb, () => getBuiltInModuleManifests());
          }
        );

        const vaultRunner = new VaultContextRunner(vaultRoot);
        const archiveJson = await vaultRunner.withVaultContext(
          { actorUserId: ids.userA },
          (vaultCtx) => readVaultFile(vaultCtx, `exports/${jobRecord.id}.json`)
        );
        const archive = JSON.parse(archiveJson) as {
          sections: {
            newsPersonalization: {
              custom_sources: unknown[];
              custom_topics: unknown[];
              source_exclusions: unknown[];
            };
            sportsSources: {
              assignments: unknown[];
              sources: unknown[];
            };
          };
        };

        const section = archive.sections.newsPersonalization;
        expect(section).toBeDefined();
        expect(
          section.custom_sources.find((row) => (row as { id: string }).id === sourceId)
        ).toEqual(expectedSource);
        expect(section.custom_topics.find((row) => (row as { id: string }).id === topicId)).toEqual(
          expectedTopic
        );
        expect(
          section.source_exclusions.find((row) => (row as { id: string }).id === exclusionId)
        ).toEqual(expectedExclusion);
        expect(
          archive.sections.sportsSources.sources.find(
            (row) => (row as { id: string }).id === sportsSourceId
          )
        ).toEqual(expectedSportsSource);
        expect(
          archive.sections.sportsSources.assignments.find(
            (row) => (row as { id: string }).id === sportsAssignmentId
          )
        ).toEqual(expectedSportsAssignment);
        expect(archiveJson).not.toContain(sourceFingerprint);
        expect(archiveJson).not.toContain(topicFingerprint);
        expect(archiveJson).not.toContain(snapshotMarker);
        expect(archiveJson).not.toContain(userBDomain);
        expect(archiveJson).not.toContain(sportsFingerprint);
        expect(archiveJson).not.toContain(sportsRecipeMarker);
        expect(archiveJson).not.toContain(sportsParameterMarker);
        expect(archiveJson).not.toContain(sportsPrivateHost);
        expect(archiveJson).not.toContain(userBSportsDomain);
      } finally {
        if (originalVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
        else process.env.JARVIS_VAULT_ROOT = originalVaultRoot;
        await rm(vaultRoot, { recursive: true, force: true });
      }
    });
  });

  it("requires authentication", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/settings/me/data-export"
    });

    expect(res.statusCode).toBe(401);
  });

  it("declares the data-export route in the settings manifest so the route guard exposes it", () => {
    const settingsManifest = getBuiltInModuleManifests().find(
      (manifest) => manifest.id === "settings"
    );
    expect(settingsManifest?.routes).toContainEqual({
      method: "GET",
      path: "/api/settings/me/data-export",
      permissionId: "settings.view"
    });
  });

  it("Finding 2: completedJob sets completed_at = now() and distinct from expires_at", async () => {
    const repository = new (
      await import("../../packages/settings/src/data-export-repository.js")
    ).DataExportRepository();
    const dataContext = new DataContextRunner(appDb);
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:test" },
      async (scopedDb) => {
        const job = await repository.createJob(scopedDb, ids.userA);

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const completedAt = new Date(Date.now() - 10000); // artificially old completedAt

        await repository.completeJob(scopedDb, job.id, completedAt, expiresAt);

        const finishedJob = await repository.getJobById(scopedDb, job.id);
        expect(finishedJob?.status).toBe("ready");
        expect(finishedJob?.completed_at).toBeDefined();
        expect(finishedJob?.expires_at).toBeDefined();
        // completed_at shouldn't equal expires_at
        expect(finishedJob?.completed_at?.getTime()).not.toBe(finishedJob?.expires_at?.getTime());
        expect(finishedJob?.completed_at?.getTime()).toBe(completedAt.getTime());
      }
    );
  });

  it("Finding 3: initial status update throw marks job failed instead of stuck pending", async () => {
    const { handleExportBuildJob } =
      await import("../../packages/settings/src/data-export-jobs.js");
    const dataContext = new DataContextRunner(appDb);
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:test" },
      async (scopedDb) => {
        const repository = new (
          await import("../../packages/settings/src/data-export-repository.js")
        ).DataExportRepository();
        const jobRecord = await repository.createJob(scopedDb, ids.userA);

        const spy = vi
          .spyOn(
            (await import("../../packages/settings/src/data-export-repository.js"))
              .DataExportRepository.prototype,
            "workerUpdateJobStatus"
          )
          .mockRejectedValueOnce(new Error("Forced failure"));

        const jobPayload = {
          data: { actorUserId: ids.userA, jobId: jobRecord.id, kind: "export.build" as const }
        } as Job<ExportBuildJobPayload>;

        try {
          await handleExportBuildJob(jobPayload, scopedDb, () => getBuiltInModuleManifests());

          const updatedJob = await repository.getJobById(scopedDb, jobRecord.id);
          expect(updatedJob?.status).toBe("failed");
          expect(updatedJob?.error_message).toContain("Forced failure");
        } finally {
          spy.mockRestore();
        }
      }
    );
  });

  it("lets the worker invoke the bounded expired-export listing function without direct table SELECT", async () => {
    const repository = new (
      await import("../../packages/settings/src/data-export-repository.js")
    ).DataExportRepository();
    const dataContext = new DataContextRunner(appDb);
    const expiredAt = new Date(Date.now() - 60_000);
    const futureAt = new Date(Date.now() + 60_000);

    const { expiredJob, futureJob } = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:test" },
      async (scopedDb) => {
        const expiredJob = await repository.createJob(scopedDb, ids.userA);
        const futureJob = await repository.createJob(scopedDb, ids.userA);
        await repository.completeJob(scopedDb, expiredJob.id, new Date(), expiredAt);
        await repository.completeJob(scopedDb, futureJob.id, new Date(), futureAt);
        return { expiredJob, futureJob };
      }
    );

    const workerClient = new Client({ connectionString: connectionStrings.worker });
    await workerClient.connect();
    try {
      await expect(workerClient.query("SELECT id FROM app.data_export_jobs")).rejects.toThrow(
        /permission denied|violates row-level security|policy/i
      );

      const result = await workerClient.query<{
        id: string;
        ownerUserId: string;
        format: string;
      }>("SELECT * FROM app.list_expired_data_export_jobs(now())");

      expect(result.rows).toContainEqual({
        id: expiredJob.id,
        ownerUserId: ids.userA,
        format: "json"
      });
      expect(result.rows).not.toContainEqual({
        id: futureJob.id,
        ownerUserId: ids.userA,
        format: "json"
      });
    } finally {
      await workerClient.end();
    }

    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:test" },
      async (scopedDb) => {
        expect((await repository.getJobById(scopedDb, expiredJob.id))?.status).toBe("ready");
        expect((await repository.getJobById(scopedDb, futureJob.id))?.status).toBe("ready");
      }
    );
  });

  it("schedules data export cleanup with a metadata-only payload", async () => {
    const { EXPORT_CLEANUP_CRON, reconcileDataExportCleanupSchedule } =
      await import("../../packages/settings/src/data-export-schedule.js");
    const { EXPORT_CLEANUP_QUEUE } =
      await import("../../packages/settings/src/data-export-jobs.js");
    const schedule = vi.fn().mockResolvedValue(undefined);
    const boss = { schedule };

    await reconcileDataExportCleanupSchedule(boss as never);

    expect(schedule).toHaveBeenCalledWith(
      EXPORT_CLEANUP_QUEUE,
      EXPORT_CLEANUP_CRON,
      { kind: "export.cleanup" },
      { tz: "UTC", key: "data-export-cleanup" }
    );
  });

  it("deletes expired export vault files before marking rows expired", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-export-cleanup-"));
    const originalVaultRoot = process.env.JARVIS_VAULT_ROOT;
    process.env.JARVIS_VAULT_ROOT = vaultRoot;
    try {
      const { handleExportCleanupJob } =
        await import("../../packages/settings/src/data-export-jobs.js");
      const repository = new (
        await import("../../packages/settings/src/data-export-repository.js")
      ).DataExportRepository();
      const dataContext = new DataContextRunner(appDb);
      const expiresAt = new Date(Date.now() - 60_000);
      const jobRecord = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        async (scopedDb) => {
          const jobRecord = await repository.createJob(scopedDb, ids.userA);
          await repository.completeJob(scopedDb, jobRecord.id, new Date(), expiresAt);
          return jobRecord;
        }
      );

      const vaultRunner = new VaultContextRunner(vaultRoot);
      await vaultRunner.withVaultContext({ actorUserId: ids.userA }, (vaultCtx) =>
        writeVaultFile(vaultCtx, `exports/${jobRecord.id}.json`, "{}")
      );

      await handleExportCleanupJob(
        { data: { kind: "export.cleanup" } } as never,
        workerDb,
        dataContext
      );

      await vaultRunner.withVaultContext({ actorUserId: ids.userA }, async (vaultCtx) => {
        await expect(readVaultFile(vaultCtx, `exports/${jobRecord.id}.json`)).rejects.toThrow();
      });
      await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        async (scopedDb) => {
          expect((await repository.getJobById(scopedDb, jobRecord.id))?.status).toBe("expired");
        }
      );
    } finally {
      if (originalVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
      else process.env.JARVIS_VAULT_ROOT = originalVaultRoot;
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("marks expired export rows cleaned when the vault file is already missing", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-export-cleanup-"));
    const originalVaultRoot = process.env.JARVIS_VAULT_ROOT;
    process.env.JARVIS_VAULT_ROOT = vaultRoot;
    try {
      const { handleExportCleanupJob } =
        await import("../../packages/settings/src/data-export-jobs.js");
      const repository = new (
        await import("../../packages/settings/src/data-export-repository.js")
      ).DataExportRepository();
      const dataContext = new DataContextRunner(appDb);
      const jobRecord = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        async (scopedDb) => {
          const jobRecord = await repository.createJob(scopedDb, ids.userA);
          await repository.completeJob(
            scopedDb,
            jobRecord.id,
            new Date(),
            new Date(Date.now() - 60_000)
          );
          return jobRecord;
        }
      );

      await handleExportCleanupJob(
        { data: { kind: "export.cleanup" } } as never,
        workerDb,
        dataContext
      );

      await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        async (scopedDb) => {
          expect((await repository.getJobById(scopedDb, jobRecord.id))?.status).toBe("expired");
        }
      );
    } finally {
      if (originalVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
      else process.env.JARVIS_VAULT_ROOT = originalVaultRoot;
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("keeps an expired export row ready when vault deletion fails", async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), "jarvis-export-cleanup-"));
    const originalVaultRoot = process.env.JARVIS_VAULT_ROOT;
    process.env.JARVIS_VAULT_ROOT = vaultRoot;
    try {
      const { mkdir } = await import("node:fs/promises");
      const { handleExportCleanupJob } =
        await import("../../packages/settings/src/data-export-jobs.js");
      const repository = new (
        await import("../../packages/settings/src/data-export-repository.js")
      ).DataExportRepository();
      const dataContext = new DataContextRunner(appDb);
      const jobRecord = await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        async (scopedDb) => {
          const jobRecord = await repository.createJob(scopedDb, ids.userA);
          await repository.completeJob(
            scopedDb,
            jobRecord.id,
            new Date(),
            new Date(Date.now() - 60_000)
          );
          return jobRecord;
        }
      );

      const vaultRunner = new VaultContextRunner(vaultRoot);
      await vaultRunner.withVaultContext({ actorUserId: ids.userA }, async (vaultCtx) => {
        await mkdir(join(vaultCtx.vaultRoot, "exports", `${jobRecord.id}.json`), {
          recursive: true
        });
      });

      await expect(
        handleExportCleanupJob({ data: { kind: "export.cleanup" } } as never, workerDb, dataContext)
      ).rejects.toThrow();

      await dataContext.withDataContext(
        { actorUserId: ids.userA, requestId: "req:test" },
        async (scopedDb) => {
          expect((await repository.getJobById(scopedDb, jobRecord.id))?.status).toBe("ready");
        }
      );
    } finally {
      if (originalVaultRoot === undefined) delete process.env.JARVIS_VAULT_ROOT;
      else process.env.JARVIS_VAULT_ROOT = originalVaultRoot;
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });
});
