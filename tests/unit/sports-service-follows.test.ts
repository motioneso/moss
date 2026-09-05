// tests/unit/sports-service-follows.test.ts
import { describe, expect, it } from "vitest";

import type { SportsFollowDto } from "@moss/shared";
import type { DataContextDb } from "@moss/db";

import type { CreateSportsFollowInput } from "../../packages/sports/src/repository.js";
import {
  SportsService,
  type SportsFollowsWriter
} from "../../packages/sports/src/sports-service.js";

function makeFakeWriter(initial: SportsFollowDto[] = []): SportsFollowsWriter & {
  readonly rows: SportsFollowDto[];
} {
  const rows = [...initial];
  return {
    rows,
    async list() {
      return rows;
    },
    async create(_db: DataContextDb, input: CreateSportsFollowInput) {
      const teamKey = input.teamKey ?? null;
      const existing = rows.find(
        (r) =>
          r.competitionKey === input.competitionKey && r.sourceTeamId === input.sourceTeamId
      );
      if (existing) return existing;
      const created: SportsFollowDto = {
        id: `f-${rows.length + 1}`,
        competitionKey: input.competitionKey,
        teamKey,
        sourceTeamId: input.sourceTeamId,
        createdAt: "2026-07-27T00:00:00.000Z"
      };
      rows.push(created);
      return created;
    },
    async setSourceTeamId(_db: DataContextDb, id: string, sourceTeamId: string) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.teamKey === null) return undefined;
      const updated: SportsFollowDto = { ...row, sourceTeamId };
      rows.splice(rows.indexOf(row), 1, updated);
      return updated;
    },
    async remove(_db: DataContextDb, id: string) {
      const index = rows.findIndex((r) => r.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    }
  };
}

/** Minimal dataset-client stand-in for the "teams" roster lookup `followTeam` now performs to
 *  close the teamKey against the catalog (#1265 QA BLOCKING-1a). `rosters` is keyed by
 *  competitionKey; a missing/empty entry models the fail-soft ESPN outage path (empty list +
 *  degraded), which `followTeam` must treat as fail-CLOSED. */
function makeDatasetClient(
  rosters: Record<string, readonly string[]>,
  degraded = false,
  // Round 5 of review finding S1: a team the provider gives no permanent number for cannot be
  // followed at all, so a roster can be asked to serve teams without one.
  withNumbers = true
) {
  return {
    async getDataset(_key: string, params: Record<string, unknown>) {
      const competitionKey = String(params.competitionKey ?? "");
      const teamKeys = rosters[competitionKey] ?? [];
      return {
        data: teamKeys.map((teamKey) => ({
          teamKey,
          competitionKey,
          name: teamKey.toUpperCase(),
          shortName: teamKey.toUpperCase(),
          crestUrl: null,
          sourceTeamId: withNumbers ? `id-${teamKey}` : null,
          abbreviation: teamKey
        })),
        degraded,
        cacheMiss: false
      };
    }
  };
}

function makeService(
  writer: SportsFollowsWriter,
  rosters: Record<string, readonly string[]> = { nfl: ["dal", "nyy"] },
  degraded = false,
  withNumbers = true
) {
  return new SportsService({
    datasetClient: makeDatasetClient(rosters, degraded, withNumbers) as never,
    dataContext: {
      withDataContext() {
        throw new Error("not used by followTeam/unfollowTeam");
      }
    },
    repository: writer
  });
}

describe("SportsService.followTeam / unfollowTeam (#1265)", () => {
  it("rejects a competitionKey outside the catalog before any write", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer);
    const result = await service.followTeam({} as DataContextDb, {
      competitionKey: "not-a-league"
    });
    expect(result.ok).toBe(false);
    expect(writer.rows).toHaveLength(0);
  });

  it("follows a catalog team and unfollow fully restores state (idempotent)", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer);

    const followed = await service.followTeam({} as DataContextDb, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect(followed.ok).toBe(true);
    expect(writer.rows).toHaveLength(1);

    const unfollowed = await service.unfollowTeam({} as DataContextDb, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect(unfollowed.ok).toBe(true);
    if (unfollowed.ok) expect(unfollowed.removed).toBe(true);
    expect(writer.rows).toHaveLength(0);

    const refollowed = await service.followTeam({} as DataContextDb, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect(refollowed.ok).toBe(true);
    expect(writer.rows).toHaveLength(1);
  });

  it("saves the permanent team number alongside the short name", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer);
    await service.followTeam({} as DataContextDb, { competitionKey: "nfl", teamKey: "dal" });
    expect(writer.rows[0]?.sourceTeamId).toBe("id-dal");
    expect(writer.rows[0]?.teamKey).toBe("dal");
  });

  // Review finding S1, round 5: with no permanent number there is nothing that could identify
  // the team later, so the save is refused rather than falling back to the short name.
  it("refuses to save a team the provider gives no permanent number for", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer, { nfl: ["dal"] }, false, false);
    const result = await service.followTeam({} as DataContextDb, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("permanent id");
    expect(writer.rows).toHaveLength(0);
  });

  // #1265 security QA BLOCKING-1(a): `followTeam` is a `granted_at_install` auto-run write tool,
  // so an assistant-supplied teamKey reaches it with no human confirmation, and the row it writes
  // is later interpolated into an outbound ESPN schedule URL. The teamKey must therefore be closed
  // against the same league roster the picker/REST route serve — an unknown key is rejected BEFORE
  // the write, not nulled-and-continued.
  it("rejects a teamKey that is not in the competition's roster, before any write", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer);
    const result = await service.followTeam({} as DataContextDb, {
      competitionKey: "nfl",
      teamKey: "../../../evil"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown team");
    expect(writer.rows).toHaveLength(0);
  });

  // Whole-competition follows carry no teamKey, so the roster lookup must not apply to them.
  it("still allows a competition-wide follow with no teamKey", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer);
    const result = await service.followTeam({} as DataContextDb, { competitionKey: "nfl" });
    expect(result.ok).toBe(true);
    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0]?.teamKey).toBeNull();
  });

  // `teamsFor` fails soft (empty list + degraded) on an ESPN outage rather than throwing. For a
  // security-tier auto-run write tool that must fail CLOSED: no roster means no team follow.
  // Deliberate — do not add a degraded-bypass here (#1265 coordinator ruling).
  it("fails closed on a degraded/empty roster instead of trusting the caller's teamKey", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer, { nfl: [] }, true);
    const result = await service.followTeam({} as DataContextDb, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect(result.ok).toBe(false);
    expect(writer.rows).toHaveLength(0);
  });

  it("unfollowing something never followed is a no-op, not an error", async () => {
    const writer = makeFakeWriter();
    const service = makeService(writer);
    const result = await service.unfollowTeam({} as DataContextDb, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.removed).toBe(false);
  });
});
