// Stub types for the Workshop page (#1755). `ModuleBuildSummary`/`ExternalModuleSummary` will
// move to `@moss/shared` once the backend (#1752/#1753) lands and defines the real response
// shapes — these are a local placeholder so the page shell can be built and tested now.

export type ModuleBuildStatus =
  | "awaiting_plan_approval"
  | "awaiting_change"
  | "planning"
  | "building"
  | "ready"
  | "failed"
  | "cancelled";

export interface ModuleBuildLogEntry {
  readonly verb: string;
  readonly text: string;
}

export interface ModuleBuildSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: ModuleBuildStatus;
  readonly step: string | null;
  readonly stepIndex: number | null;
  readonly totalSteps: number | null;
  readonly progressPercent: number | null;
  readonly startedAt: string;
  readonly costCents: number;
  readonly dailyLimitCents: number;
  readonly log: readonly ModuleBuildLogEntry[];
  readonly reachesExternalServices: number;
  readonly storesData: boolean;
}

export interface ExternalModuleSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly scope: "you" | "everyone";
  readonly approvedAt: string;
  readonly lastRefreshedAt: string | null;
  readonly usedByCount: number | null;
  readonly broken: boolean;
  readonly brokenReason: string | null;
}
