import type { DataContextDb, MossActionAuditLog, MossErrorLog } from "@moss/db";
import type { HostDiagnosticsDto } from "@moss/shared";
import type { AppMapReadService, SourceSearchResult, SourceInspector } from "@moss/settings";
import {
  aggregateModuleDiagnostics,
  EMPTY_CONNECTIONS_SECTION,
  EMPTY_JOBS_SECTION
} from "@moss/module-sdk";
import type {
  ConnectionsSection,
  JobsSection,
  ModuleDiagnosticContextRunner,
  ModuleDiagnosticObservation,
  RegisteredModuleDiagnosticProvider
} from "@moss/module-sdk";

import type { AiRepository } from "./repository.js";

export type HostRuntimeObservation = HostDiagnosticsDto;

export interface StructuredErrorObservation {
  readonly occurredAt: string;
  readonly feature: string;
  readonly operation: string;
  readonly errorCategory: string;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly internalSummary: string;
  readonly requestId: string | null;
}

export interface ActionAuditObservation {
  readonly occurredAt: string;
  readonly toolModuleId: string;
  readonly toolName: string;
  readonly actionKind: string;
  readonly approvalMode: string;
  readonly outcome: string;
  readonly errorClass: string | null;
  readonly requestId: string | null;
}

export type {
  ConnectionObservation,
  ConnectionsSection,
  JobRunObservation,
  JobsSection,
  JobSummaryObservation
} from "@moss/module-sdk";

export interface PlatformDiagnosticsQuery {
  readonly domain?: string;
  readonly include?: readonly (
    | "version"
    | "runtime"
    | "modules"
    | "errors"
    | "actions"
    | "jobs"
    | "connections"
    | "source"
  )[];
  readonly query?: string;
  readonly limit?: number;
}

export interface PlatformDiagnosticsReport {
  readonly observedAt: string;
  readonly build: { readonly version: string; readonly buildId: string };
  readonly runtime: HostRuntimeObservation | null;
  readonly modules: readonly ModuleDiagnosticObservation[];
  readonly errors: readonly StructuredErrorObservation[];
  readonly actions: readonly ActionAuditObservation[];
  readonly jobs: JobsSection;
  readonly connections: ConnectionsSection;
  readonly source: SourceSearchResult | null;
  readonly redactions: readonly string[];
}

export interface PlatformDiagnosticsService {
  observe(
    scopedDb: DataContextDb,
    ctx: { readonly actorUserId: string; readonly requestId: string },
    query?: PlatformDiagnosticsQuery
  ): Promise<PlatformDiagnosticsReport>;
}

type DiagnosticInclude = NonNullable<PlatformDiagnosticsQuery["include"]>[number];

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function projectError(row: MossErrorLog): StructuredErrorObservation {
  return {
    occurredAt: timestamp(row.occurred_at),
    feature: row.feature,
    operation: row.operation,
    errorCategory: row.error_category,
    retryable: row.retryable,
    userMessage: row.user_message,
    internalSummary: row.internal_summary,
    requestId: row.request_id
  };
}

function projectAction(row: MossActionAuditLog): ActionAuditObservation {
  return {
    occurredAt: timestamp(row.occurred_at),
    toolModuleId: row.tool_module_id,
    toolName: row.tool_name,
    actionKind: row.action_kind,
    approvalMode: row.approval_mode,
    outcome: row.outcome,
    errorClass: row.error_class,
    requestId: row.request_id
  };
}

function limitFor(query: PlatformDiagnosticsQuery | undefined): number {
  return typeof query?.limit === "number" && Number.isFinite(query.limit)
    ? Math.max(1, Math.min(10, Math.floor(query.limit)))
    : 10;
}

function includeSet(query: PlatformDiagnosticsQuery | undefined): ReadonlySet<DiagnosticInclude> {
  return new Set(query?.include ?? ["version", "runtime", "modules", "errors", "actions"]);
}

/** Largest serialized size of one admin section. */
const SECTION_MAX_BYTES = 16 * 1024;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Drops items from the end until the section fits, and flags the section as truncated. */
function capSection<T extends { readonly truncated: boolean }>(
  section: T,
  lists: readonly (keyof T)[],
  limit: number
): T {
  const copy = { ...section } as Record<keyof T, unknown> & T;
  let truncated = section.truncated;
  for (const name of lists) {
    const items = copy[name] as readonly unknown[];
    if (items.length > limit) {
      (copy as Record<keyof T, unknown>)[name] = items.slice(0, limit);
      truncated = true;
    }
  }
  while (byteLength({ ...copy, truncated }) > SECTION_MAX_BYTES) {
    const key = lists
      .filter((name) => (copy[name] as readonly unknown[]).length > 0)
      .sort((a, b) => byteLength(copy[b] as unknown[]) - byteLength(copy[a] as unknown[]))[0];
    if (!key) break;
    (copy as Record<keyof T, unknown>)[key] = (copy[key] as readonly unknown[]).slice(0, -1);
    truncated = true;
  }
  return { ...copy, truncated };
}

export function createPlatformDiagnosticsService(dependencies: {
  readonly appMap: Pick<AppMapReadService, "getBuildInfo">;
  readonly sourceInspector?: Pick<SourceInspector, "search">;
  readonly collectHostDiagnostics?: (scopedDb: DataContextDb) => Promise<HostDiagnosticsDto>;
  readonly repository: Pick<AiRepository, "listRecentErrors" | "listActionAuditLog">;
  readonly moduleProviders: (
    actorUserId: string
  ) => Promise<readonly RegisteredModuleDiagnosticProvider[]>;
  readonly runInContext: ModuleDiagnosticContextRunner;
  readonly isInstanceAdmin: (scopedDb: DataContextDb, actorUserId: string) => Promise<boolean>;
  readonly assertDiagnosticsSafe: (dto: HostDiagnosticsDto) => void;
  /** Admin-only readers; absent means the section is reported as redacted. */
  readonly readJobs?: (
    scopedDb: DataContextDb,
    ctx: { readonly actorUserId: string; readonly requestId: string },
    opts: { readonly limit: number; readonly queuePrefix?: string; readonly since: Date }
  ) => Promise<JobsSection>;
  readonly readConnections?: (
    scopedDb: DataContextDb,
    ctx: { readonly actorUserId: string; readonly requestId: string },
    opts: { readonly limit: number }
  ) => Promise<ConnectionsSection>;
  readonly onProviderError?: (moduleId: string, errorName: string) => void;
}): PlatformDiagnosticsService {
  return {
    async observe(scopedDb, ctx, query) {
      if (!ctx.actorUserId) throw new Error("platform diagnostics requires an actor");
      const include = includeSet(query);
      const limit = limitFor(query);
      const redactions: string[] = [];
      const build = dependencies.appMap.getBuildInfo();

      let runtime: HostRuntimeObservation | null = null;
      if (include.has("runtime")) {
        if (!(await dependencies.isInstanceAdmin(scopedDb, ctx.actorUserId))) {
          redactions.push("runtime");
        } else if (dependencies.collectHostDiagnostics) {
          runtime = await dependencies.collectHostDiagnostics(scopedDb);
          dependencies.assertDiagnosticsSafe(runtime);
        } else {
          redactions.push("runtime");
        }
      }

      const modules = include.has("modules")
        ? await aggregateModuleDiagnostics(
            (await dependencies.moduleProviders(ctx.actorUserId)).filter(({ provider }) =>
              query?.domain ? provider.domain === query.domain : true
            ),
            dependencies.runInContext,
            ctx,
            { onProviderError: dependencies.onProviderError }
          ).then((observations) => observations.slice(0, limit))
        : [];
      const errors = include.has("errors")
        ? (
            await dependencies.repository.listRecentErrors(scopedDb, {
              query: query?.query,
              limit
            })
          )
            .slice(0, limit)
            .map(projectError)
        : [];
      const actions = include.has("actions")
        ? (
            await dependencies.repository.listActionAuditLog(scopedDb, {
              since: new Date(Date.now() - 24 * 60 * 60 * 1000),
              limit
            })
          )
            .slice(0, limit)
            .map(projectAction)
        : [];
      // Live lookup on every call. Never cached, never read from tool arguments.
      let jobs: JobsSection = EMPTY_JOBS_SECTION;
      let connections: ConnectionsSection = EMPTY_CONNECTIONS_SECTION;
      if (include.has("jobs") || include.has("connections")) {
        const admin = await dependencies.isInstanceAdmin(scopedDb, ctx.actorUserId);
        if (include.has("jobs")) {
          if (admin && dependencies.readJobs) {
            jobs = capSection(
              await dependencies.readJobs(scopedDb, ctx, {
                limit,
                ...(query?.domain ? { queuePrefix: query.domain } : {}),
                since: new Date(Date.now() - 24 * 60 * 60 * 1000)
              }),
              ["recent", "summaries"],
              limit
            );
          } else redactions.push("jobs");
        }
        if (include.has("connections")) {
          if (admin && dependencies.readConnections) {
            connections = capSection(await dependencies.readConnections(scopedDb, ctx, { limit }), [
              "items"
            ]);
          } else redactions.push("connections");
        }
      }
      const source =
        include.has("source") && query?.query && dependencies.sourceInspector
          ? await dependencies.sourceInspector.search({ query: query.query, limit })
          : null;
      if (include.has("source") && !dependencies.sourceInspector) redactions.push("source");

      return {
        observedAt: new Date().toISOString(),
        build,
        runtime,
        modules,
        errors,
        actions,
        jobs,
        connections,
        source,
        redactions
      };
    }
  };
}
