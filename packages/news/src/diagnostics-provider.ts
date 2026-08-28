import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ModuleDiagnosticObservation, ModuleDiagnosticProvider } from "@moss/module-sdk";

import {
  NewsPersonalizationRepository,
  type NewsRefreshDiagnostics
} from "./personalization-repository.js";

const STALE_AFTER_SECONDS = 24 * 60 * 60;

function failureDescription(kind: string | null | undefined): string {
  switch (kind) {
    case "fetch":
      return "while fetching news";
    case "ai":
      return "while preparing the feed";
    case "internal":
      return "because of an internal error";
    default:
      return "because of an unknown error";
  }
}

function failureIsNewest(diagnostics: NewsRefreshDiagnostics): boolean {
  const failure = diagnostics.refresh.lastFailureAt;
  if (!failure) return false;
  const success = diagnostics.refresh.lastSuccessAt;
  return !success || failure > success;
}

function statusFor(diagnostics: NewsRefreshDiagnostics): ModuleDiagnosticObservation["status"] {
  if (!diagnostics.refresh.updatedAt && !diagnostics.snapshotCompiledAt) return "unknown";
  if (diagnostics.refresh.state === "failed" || failureIsNewest(diagnostics)) return "failed";
  if (
    !diagnostics.snapshotCompiledAt ||
    (diagnostics.snapshotAgeSeconds ?? 0) > STALE_AFTER_SECONDS ||
    (diagnostics.refresh.state === "idle" &&
      diagnostics.requestedGeneration > diagnostics.compiledGeneration)
  ) {
    return "degraded";
  }
  return "ok";
}

function summaryFor(diagnostics: NewsRefreshDiagnostics): string {
  switch (statusFor(diagnostics)) {
    case "unknown":
      return "News has never been refreshed for this account.";
    case "failed":
      return `News refresh failed ${failureDescription(diagnostics.refresh.lastFailureKind ?? diagnostics.refresh.failureKind)}.`;
    case "degraded":
      return "News is available but its feed is not current.";
    case "ok":
      return "News is current.";
  }
}

function factsFor(
  diagnostics: NewsRefreshDiagnostics
): Readonly<Record<string, string | number | null>> {
  return {
    state: diagnostics.refresh.state,
    failureKind: diagnostics.refresh.failureKind ?? null,
    lastFailureKind: diagnostics.refresh.lastFailureKind,
    lastRequestedAt: diagnostics.refresh.lastRequestedAt,
    lastAttemptAt: diagnostics.refresh.lastAttemptAt,
    lastSuccessAt: diagnostics.refresh.lastSuccessAt,
    lastFailureAt: diagnostics.refresh.lastFailureAt,
    snapshotAgeSeconds: diagnostics.snapshotAgeSeconds,
    itemCount: diagnostics.itemCount,
    requestedGeneration: diagnostics.requestedGeneration,
    compiledGeneration: diagnostics.compiledGeneration
  };
}

export function createNewsDiagnosticsProvider(
  repository: Pick<
    NewsPersonalizationRepository,
    "readRefreshDiagnostics"
  > = new NewsPersonalizationRepository()
): ModuleDiagnosticProvider {
  return {
    domain: "news",
    providerId: "news.refresh",
    async observe(scopedDb: unknown, _ctx) {
      assertDataContextDb(scopedDb);
      const diagnostics = await repository.readRefreshDiagnostics(scopedDb as DataContextDb);
      return {
        domain: "news",
        providerId: "news.refresh",
        observedAt: new Date().toISOString(),
        status: statusFor(diagnostics),
        summary: summaryFor(diagnostics),
        remediationActionId: "news.refreshNews",
        facts: factsFor(diagnostics)
      };
    }
  };
}
