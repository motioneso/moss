import type { DatasetClient } from "@moss/datasets";
import type { DataContextDb } from "@moss/db";
import type { SportsFollowsReader } from "../sports-service.js";
import type { SourceTeamRef } from "../source/sports-source.js";
import { catalogEntry } from "../source/catalog.js";
import type { CompletedResult } from "./espn-results.js";

import type {
  SportsResultQuery as ResultQuery,
  SportsResultRead as ResultRead
} from "@moss/shared";
export type {
  SportsResultQuery as ResultQuery,
  SportsResultRead as ResultRead
} from "@moss/shared";

const normalized = (value: string) => value.trim().toLocaleLowerCase("en-US");

/** Only reads actor-visible follows and public datasets; it has no writer or source-sync port. */
export class SportsResultReader {
  constructor(
    private readonly datasets: DatasetClient,
    private readonly follows: SportsFollowsReader,
    private readonly now: () => Date = () => new Date()
  ) {}

  async read(db: DataContextDb, query: ResultQuery): Promise<ResultRead> {
    const follows = await this.follows.list(db);
    const requested = query.competitionKey;
    if (requested && !catalogEntry(requested))
      return {
        status: "unavailable",
        candidates: [],
        message: "That competition is not available in Sports."
      };
    // Without an explicit competition, follows supply context. A partial global search cannot
    // prove uniqueness, so it is never used to silently choose between men's and women's teams.
    const keys = requested
      ? [requested]
      : [...new Set(follows.map((f) => f.competitionKey))].filter((key) => catalogEntry(key));
    if (!keys.length || keys.length > 8 || (!query.teamName && !query.sourceTeamId))
      return {
        status: "needs_team",
        candidates: [],
        message: "Which team and competition do you mean? Specify men's or women's when needed."
      };
    const rosters = await Promise.all(
      keys.map(async (competitionKey) => ({
        competitionKey,
        roster: await this.datasets.getDataset<SourceTeamRef[]>(
          "teams",
          { competitionKey },
          { fallback: [] }
        )
      }))
    );
    if (rosters.some(({ roster }) => roster.degraded || !roster.data.length))
      return {
        status: "unavailable",
        candidates: [],
        message:
          "Team coverage is incomplete. Please specify the team and competition or try again."
      };
    const name = normalized(query.teamName ?? "");
    const candidates = rosters.flatMap(({ competitionKey, roster }) =>
      roster.data
        .filter((t) => {
          if (!t.sourceTeamId) return false;
          if (query.sourceTeamId)
            return (
              t.sourceTeamId === query.sourceTeamId &&
              (!name || [t.name, t.shortName].some((label) => normalized(label) === name))
            );
          const matches = [t.name, t.shortName].some((label) => normalized(label) === name);
          return (
            matches &&
            (Boolean(requested) ||
              follows.some(
                (f) => f.competitionKey === competitionKey && f.sourceTeamId === t.sourceTeamId
              ))
          );
        })
        .map((t) => ({ competitionKey, sourceTeamId: t.sourceTeamId!, name: t.name }))
    );
    const identities = new Map(
      candidates.map((c) => [`${catalogEntry(c.competitionKey)!.espnSport}:${c.sourceTeamId}`, c])
    );
    if (identities.size !== 1)
      return {
        status: identities.size > 1 ? "ambiguous" : "needs_team",
        candidates,
        message: "Please choose the team and competition, including men's or women's when relevant."
      };
    const team = identities.values().next().value!;
    const sport = catalogEntry(team.competitionKey)!.espnSport;
    const competitions = [
      ...new Set([
        team.competitionKey,
        ...follows
          .filter(
            (f) =>
              f.sourceTeamId === team.sourceTeamId &&
              catalogEntry(f.competitionKey)?.espnSport === sport
          )
          .map((f) => f.competitionKey)
      ])
    ].slice(0, 8);
    // Match the results cache TTL so repeated turns reuse the same bounded provider read.
    const now = new Date(Math.floor(this.now().getTime() / 30_000) * 30_000);
    const from = new Date(now.getTime() - 90 * 86400000).toISOString();
    const to = now.toISOString();
    const reads = await Promise.all(
      competitions.map(async (competitionKey) => ({
        competitionKey,
        envelope: await this.datasets.getDataset<CompletedResult[]>(
          "results",
          {
            competitionKey,
            sourceTeamId: team.sourceTeamId,
            from,
            to
          },
          { fallback: [] }
        )
      }))
    );
    const failedCompetitions = reads
      .filter((r) => r.envelope.degraded)
      .map((r) => r.competitionKey);
    if (failedCompetitions.length === competitions.length)
      return {
        status: "unavailable",
        candidates: [team],
        message: `Results could not be read for ${competitions.join(", ")} from ${from} to ${to}. Try again later.`
      };
    const byId = new Map<string, CompletedResult>();
    for (const { envelope } of reads) {
      if (envelope.degraded) continue;
      for (const result of envelope.data) byId.set(`${result.sport}:${result.id}`, result);
    }
    const result =
      [...byId.values()].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0] ?? null;
    return {
      status: result ? "result" : "empty",
      team,
      result,
      from,
      to,
      retrievedAt: reads.map((r) => r.envelope.fetchedAt).sort()[0] ?? to,
      competitions,
      failedCompetitions,
      coverage: `Latest available result. Checked ${competitions.join(", ")} from ${from} to ${to}; other competitions may be missing.${failedCompetitions.length ? ` Failed: ${failedCompetitions.join(", ")}.` : ""}`
    };
  }
}
