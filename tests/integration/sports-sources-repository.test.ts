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

const candidate = (index: number): VerifiedSportsSourceCandidate => ({
  candidateId: `candidate-${index}`,
  label: `Publisher ${index}`,
  canonicalDomain: `publisher-${index}.example.com`,
  homepageUrl: `https://publisher-${index}.example.com/`,
  feedUrl: null,
  retrievalMethod: "scrape",
  sampleCount: 1,
  validationFingerprint: "opaque-fingerprint"
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
    expect(result).toMatchObject({ assignedFollowIds: [ownFollowId] });
  });
});
