import { WELLNESS_EXPORT_CATEGORIES, type WellnessExportCategory } from "@moss/shared";
import type { QueryClient } from "@tanstack/react-query";

/** Null dates are untouched and follow the person's default range. */
export interface ExportDraft {
  readonly from: string | null;
  readonly to: string | null;
  readonly categories: readonly WellnessExportCategory[];
  readonly jobId: string | null;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function exportRangeDays(from: string, to: string): number | null {
  if (!validDay(from) || !validDay(to) || from > to) return null;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

export const exportDraftKey = (userId: string | null) =>
  ["wellness-export", "draft", userId] as const;
const storageKey = (userId: string) => `moss:wellness-export:${userId}`;

export function readExportDraft(client: QueryClient, userId: string | null): ExportDraft {
  const cached = client.getQueryData<ExportDraft>(exportDraftKey(userId));
  if (cached) return cached;
  if (userId) {
    try {
      const raw: unknown = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? "null");
      if (raw && typeof raw === "object") {
        const draft = raw as Record<string, unknown>;
        if (
          (draft.from === null || validDay(draft.from)) &&
          (draft.to === null || validDay(draft.to)) &&
          Array.isArray(draft.categories) &&
          draft.categories.every((category) => WELLNESS_EXPORT_CATEGORIES.includes(category)) &&
          (draft.jobId === null || (typeof draft.jobId === "string" && draft.jobId.length <= 200))
        )
          return {
            from: draft.from,
            to: draft.to,
            categories: draft.categories,
            jobId: draft.jobId
          };
      }
    } catch {
      /* Unavailable storage cannot block the export form. */
    }
  }
  return {
    from: null,
    to: null,
    categories: [...WELLNESS_EXPORT_CATEGORIES],
    jobId: null
  };
}

// Store selection and job identity only. Never persist health content or acknowledgment.
export function saveExportDraft(client: QueryClient, userId: string | null, draft: ExportDraft) {
  client.setQueryData(exportDraftKey(userId), draft);
  if (userId) {
    try {
      sessionStorage.setItem(storageKey(userId), JSON.stringify(draft));
    } catch {
      /* Query cache still supports ordinary route re-entry. */
    }
  }
}
