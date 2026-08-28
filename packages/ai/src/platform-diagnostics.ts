import type { DataContextDb, MossActionAuditLog, MossErrorLog } from "@moss/db";
import type { HostDiagnosticsDto } from "@moss/shared";
import type { AppMapReadService, SourceSearchResult, SourceInspector } from "@moss/settings";
import { aggregateModuleDiagnostics } from "@moss/module-sdk";
import type {
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

export interface PlatformDiagnosticsQuery {
  readonly domain?: string;
  readonly include?: readonly (
    | "version"
    | "runtime"
    | "modules"
    | "errors"
    | "actions"
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
  readonly onProviderError?: (moduleId: string, errorName: string) => void;
}): PlatformDiagnosticsService {
  return {
    async observe(scopedDb, ctx, query) {
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
        source,
        redactions
      };
    }
  };
}
