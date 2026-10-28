import type { DatasetClient } from "@moss/datasets";
import { assertDataContextDb } from "@moss/db";
import type { DataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import {
  capHeartbeatItems,
  heartbeatRevision,
  parseHeartbeatSourceReadInput,
  type HeartbeatEvidenceItem,
  type HeartbeatSourceRead
} from "@moss/shared";

import { SportsFollowsRepository } from "./repository.js";
import { SportsService } from "./sports-service.js";

/**
 * Sole intended consumer is the daily briefing (spec §4.7). It is mechanically visible to the
 * chat tool-registry because the platform has no briefing-only flag today; its output is kept to
 * compact today-facts only (never the rich `sports.scores`/`sports.schedule` chat surface §2 bars).
 *
 * The service reads followed facts directly from the gateway-scoped db passed to `execute`; the
 * `dataContext` runner seam is unused on this path, so a throwing stub satisfies the type without
 * ever opening a second, unscoped connection.
 *
 * The service needs a `DatasetClient`, which the composition root only has once it has built the
 * sports module's `espn` external source (`packages/module-registry/src/index.ts`, mirroring the
 * `adoptChatRpcConnection` late-bound-ref pattern used for the chat RPC connection). This module's
 * tool is registered as static manifest data (`./manifest.ts`) constructed at import time, before
 * that wiring runs — so construction is deferred to `configureSportsBriefingService`, which the
 * registry calls once, synchronously, during boot, strictly before any request can reach
 * `sportsFollowedFactsTodayExecute`.
 */
let service: SportsService | undefined;

export function configureSportsBriefingService(datasetClient: DatasetClient): void {
  service = new SportsService({
    datasetClient,
    dataContext: {
      withDataContext() {
        throw new Error("sports briefing tool reads the gateway-scoped db directly");
      }
    },
    repository: new SportsFollowsRepository()
  });
}

export const sportsFollowedFactsTodayExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  if (!service) {
    throw new Error(
      "sports briefing tool used before configureSportsBriefingService ran (composition-root bug)"
    );
  }
  const timeZone =
    typeof (input as Record<string, unknown> | null)?.["timeZone"] === "string"
      ? ((input as Record<string, unknown>)["timeZone"] as string)
      : undefined;
  const { facts, evidence } = await service.getFollowedFactsForToday(scopedDb, ctx.actorUserId, {
    timeZone
  });
  return { data: { facts, evidence } };
};

/**
 * Input must stay inside the read contract. Extra keys (an owner or user id) are refused, and the
 * follows read below runs as the actor the data context was opened for.
 */
export async function authorizeSportsHeartbeatRead(
  _scopedDb: DataContextDb,
  input: Record<string, unknown>
): Promise<boolean> {
  return parseHeartbeatSourceReadInput(input) !== null;
}

/** Next fixtures for followed teams, read from the dataset cache only. */
export const sportsHeartbeatNextFixturesExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const parsed = parseHeartbeatSourceReadInput(input);
  if (!parsed) throw new Error("Invalid heartbeat read input");
  if (!service) {
    throw new Error(
      "sports briefing tool used before configureSportsBriefingService ran (composition-root bug)"
    );
  }
  const { games, freshness } = await service.getCachedFixturesForHeartbeat(scopedDb, {
    horizonHours: parsed.horizonHours
  });
  const { items: bounded, truncated } = capHeartbeatItems(games, parsed.limit);
  const items: HeartbeatEvidenceItem[] = bounded.map((game) => ({
    entityKey: `fixture:${game.competitionKey}:${game.id}`,
    episodeKey: `fixture:${game.competitionKey}:${game.id}:${game.startsAt}`,
    title: game.headline,
    at: game.startsAt,
    kind: "fixture",
    facts: {
      competitionKey: game.competitionKey,
      phase: game.phase,
      statusDetail: game.statusDetail,
      homeScore: game.homeScore,
      awayScore: game.awayScore
    }
  }));
  const upcoming = bounded
    .map((game) => Date.parse(game.startsAt))
    .filter((starts) => starts > Date.now())
    .sort((a, b) => a - b);
  const data: HeartbeatSourceRead = {
    source: "sports",
    revision: heartbeatRevision(
      games.map((g) => [g.competitionKey, g.id, g.startsAt, g.phase, g.statusDetail].join("|"))
    ),
    nextBoundaryAt: upcoming[0] ? new Date(upcoming[0]).toISOString() : null,
    freshness,
    truncated,
    items
  };
  return { data };
};
