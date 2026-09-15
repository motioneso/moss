import type { DatasetClient } from "@moss/datasets";
import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";

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
