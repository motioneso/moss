// A fallback run is the deterministic source digest written when AI synthesis is
// unavailable (fallback / fallbackEvening). It stays stored for history and for
// the evening interview seed, but its text is never user-facing.
//
// `degraded` alone is not enough: an AI-written run is also `degraded: true` when a
// source account was served from cache. Only the fallback path has no AI model.
export function isFallbackRun(sourceMetadata: Readonly<Record<string, unknown>>): boolean {
  const aiModel = sourceMetadata.aiModel;
  const hasAiModel = typeof aiModel === "object" && aiModel !== null;
  return sourceMetadata.degraded === true && !hasAiModel;
}

// Summary text as the API returns it. Fallback runs return "", so every surface
// treats them as having no written briefing.
export function displaySummaryText(
  summaryText: string,
  sourceMetadata: Readonly<Record<string, unknown>>
): string {
  return isFallbackRun(sourceMetadata) ? "" : summaryText;
}
