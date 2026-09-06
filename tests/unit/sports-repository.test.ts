import { describe, expect, it } from "vitest";
import { SportsFollowsRepository, toDto } from "../../packages/sports/src/repository.js";

// The owner-scoped RLS round-trip (create/list isolation, whole-competition dup guard) is a
// real-DB integration test deferred to Task 10, when the sports module is registered in
// module-registry and app.sports_follows exists in the foundation migration set. These unit
// tests cover the pure row→DTO mapping and the repository's method surface pre-registration.
describe("SportsFollowsRepository", () => {
  it("maps a team follow row to a DTO (snake_case → camelCase, Date → ISO)", () => {
    const dto = toDto({
      id: "11111111-1111-4111-8111-111111111111",
      competition_key: "nfl",
      team_key: "dal",
      source_team_id: "6",
      created_at: new Date("2026-01-04T17:30:00.000Z")
    });
    expect(dto).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      competitionKey: "nfl",
      teamKey: "dal",
      sourceTeamId: "6",
      createdAt: "2026-01-04T17:30:00.000Z"
    });
  });

  it("preserves a null team_key (whole-competition follow)", () => {
    const dto = toDto({
      id: "22222222-2222-4222-8222-222222222222",
      competition_key: "eng.1",
      team_key: null,
      source_team_id: null,
      created_at: new Date("2026-01-04T00:00:00.000Z")
    });
    expect(dto.teamKey).toBeNull();
    expect(dto.sourceTeamId).toBeNull();
    expect(dto.competitionKey).toBe("eng.1");
  });

  it("exposes list/create/setSourceTeamId/remove methods", () => {
    const repo = new SportsFollowsRepository();
    expect(typeof repo.list).toBe("function");
    expect(typeof repo.create).toBe("function");
    expect(typeof repo.setSourceTeamId).toBe("function");
    expect(typeof repo.remove).toBe("function");
  });
});
