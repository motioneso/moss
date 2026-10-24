import { sportsResultQuerySchema } from "@moss/shared";
import type { DatasetClient } from "@moss/datasets";
import { assertDataContextDb } from "@moss/db";
import type {
  ToolExecute,
  ModuleAssistantToolManifest,
  VisualSnapshotRegistrationService
} from "@moss/module-sdk";
import type { SportsFollowsReader } from "../sports-service.js";
import { SportsResultReader, type ResultQuery, type ResultRead } from "./reader.js";

let reader: SportsResultReader | undefined;
export function configureSportsResultRead(
  datasets: DatasetClient,
  follows: SportsFollowsReader
): void {
  reader = new SportsResultReader(datasets, follows);
}

export function resultSnapshot(read: Extract<ResultRead, { status: "result" | "empty" }>) {
  if (!read.result) return null;
  return {
    kind: "sports.result",
    origin: "source" as const,
    source: { id: "espn", label: "ESPN" },
    retrievedAt: read.retrievedAt,
    coverage: read.coverage,
    fields: { ...read.result, home: { ...read.result.home }, away: { ...read.result.away } }
  };
}

export const sportsLatestResultExecute: ToolExecute = async (db, input, ctx, services) => {
  assertDataContextDb(db);
  if (!reader) throw new Error("Sports result reader is not configured");
  const read = await reader.read(db, input as ResultQuery);
  if (read.status !== "result" || !read.result) return { data: { ...read } };
  const registrar = services?.visualPresentation as VisualSnapshotRegistrationService | undefined;
  const snapshot = resultSnapshot(read);
  const registered = registrar?.registerSnapshot(ctx, snapshot);
  return {
    data: {
      ...read,
      ...(registered?.ok
        ? {
            presentation: {
              description:
                "If a visual helps, propose this source-bound card with chat.present. Keep useful prose; respect text-only instructions. Do not change facts or URLs.",
              proposal: {
                catalogVersion: registered.catalogVersion,
                blocks: [{ kind: registered.templateKind, snapshotRefs: [registered.ref] }],
                interactions: []
              }
            }
          }
        : {})
    }
  };
};

export const sportsLatestResultTool = {
  name: "sports.latestResult",
  permissionId: "sports.view",
  risk: "read",
  content: "outside",
  description:
    "Read the latest available completed match for a team over 90 days, across covered competitions. Uses follows or explicit competition/team context; returns clarification when ambiguous. Read-only: does not follow teams, change settings or sync sources. A source-bound visual is available when useful.",
  inputSchema: sportsResultQuerySchema,
  execute: sportsLatestResultExecute
} as const satisfies ModuleAssistantToolManifest;
