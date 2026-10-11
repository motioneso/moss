import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { addLocalDays, todayLocalDayKey } from "@moss/module-sdk/time";
import { Button, ButtonLink, Dialog, Note } from "@moss/ui";
import {
  WELLNESS_EXPORT_CATEGORIES,
  type WellnessExportCategory,
  type MeResponse
} from "@moss/shared";
import {
  ApiError,
  getMe,
  getDataExportDownloadUrl,
  getDataExportStatus,
  type ExportJobStatus
} from "../api/client";
import { requestWellnessExport } from "../api/wellness-export";
import { queryKeys } from "../api/query-keys";
import { useUserLocale } from "../locale/locale-format";
import {
  exportDraftKey,
  exportRangeDays,
  readExportDraft,
  saveExportDraft,
  type ExportDraft
} from "./export-draft";

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 13 13"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="2,7 5,10 11,3" />
    </svg>
  );
}

const CATEGORY_LABELS: { readonly [K in WellnessExportCategory]: string } = {
  checkins: "Mood check-ins",
  medications: "Medications & logs",
  therapyNotes: "Therapy notes",
  insights: "Insights"
};

/** Default range: the 90 days up to today, as calendar days in the person's time zone. */
export function defaultExportRange(
  timeZone: string,
  now: Date = new Date()
): { readonly from: string; readonly to: string } {
  const today = todayLocalDayKey(timeZone, now);
  return { from: addLocalDays(today, -90), to: today };
}

const SENSITIVE_COPY =
  "This export will contain sensitive health and wellness data. Anyone you share it with will see it. Generate only if you trust the recipient (e.g. your doctor or therapist).";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WellnessExportModal(props: Props) {
  const account = useQuery<MeResponse>({
    queryKey: queryKeys.auth.me,
    queryFn: getMe,
    enabled: false
  });
  const userId = account.data?.user.id ?? null;
  return <AccountExportModal key={userId ?? "unknown"} {...props} userId={userId} />;
}

function AccountExportModal({ open, onClose, userId }: Props & { userId: string | null }) {
  const queryClient = useQueryClient();
  const draftQuery = useQuery({
    queryKey: exportDraftKey(userId),
    queryFn: () => readExportDraft(queryClient, userId),
    initialData: () => readExportDraft(queryClient, userId),
    enabled: false
  });
  const draft = draftQuery.data;
  const pendingStarts = useMutationState({
    filters: { mutationKey: ["wellness-export", "start", userId], status: "pending" },
    select: (mutation) => mutation.state.status
  });
  const isStarting = pendingStarts.length > 0;
  const locale = useUserLocale();
  const defaults = defaultExportRange(locale.timezone);
  const { categories, jobId } = draft;
  const from = draft.from ?? defaults.from;
  const to = draft.to ?? defaults.to;
  const [acknowledged, setAcknowledged] = useState(false);
  const starting = useRef(false);
  function updateDraft(next: ExportDraft) {
    saveExportDraft(queryClient, userId, next);
  }
  const days = exportRangeDays(from, to);
  const rangeValid = days !== null && days <= 366;
  const categoriesValid = categories.length > 0;

  const statusQuery = useQuery<ExportJobStatus>({
    queryKey: ["wellness-export", "status", userId, jobId],
    queryFn: () => getDataExportStatus(jobId!),
    enabled: open && jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "building" ? 2000 : false;
    }
  });

  const [expiryTick, setExpiryTick] = useState(0);
  const expiresAt = statusQuery.data?.expiresAt;
  useEffect(() => {
    if (!open || statusQuery.data?.status !== "ready" || !expiresAt) return;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return;
    const timer = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.min(remaining, 2_147_483_647)
    );
    return () => clearTimeout(timer);
  }, [open, statusQuery.data?.status, expiresAt, expiryTick]);

  const startMutation = useMutation({
    mutationKey: ["wellness-export", "start", userId],
    mutationFn: (selection: ExportDraft & { readonly from: string; readonly to: string }) =>
      requestWellnessExport({
        from: selection.from,
        to: selection.to,
        categories: [...selection.categories]
      }),
    onSuccess: (data, selection) => updateDraft({ ...selection, jobId: data.jobId }),
    onSettled: () => {
      starting.current = false;
    }
  });

  if (!open) return null;

  const status = statusQuery.data?.status;
  const isReady = status === "ready";
  const isFailed = status === "failed";
  const isExpired =
    status === "expired" ||
    (status === "ready" && expiresAt !== undefined && Date.parse(expiresAt) <= Date.now());
  const isUnavailable =
    statusQuery.error instanceof ApiError && [404, 410].includes(statusQuery.error.status);
  const inProgress = status === "pending" || status === "building";
  const canGenerate =
    rangeValid && categoriesValid && acknowledged && !isStarting && (jobId === null || isFailed);

  function toggleCategory(cat: WellnessExportCategory) {
    updateDraft({
      ...draft,
      categories: categories.includes(cat)
        ? categories.filter((c) => c !== cat)
        : [...categories, cat]
    });
  }

  function reset() {
    updateDraft({ ...draft, jobId: null });
    setAcknowledged(false);
    startMutation.reset();
  }

  function close() {
    setAcknowledged(false);
    onClose();
  }

  return (
    <Dialog
      title="Export for a clinician"
      closeLabel="Close export"
      description="Share"
      onClose={close}
      className="wl-dialog wl-dialog--export"
      footer={
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
      }
    >
      {!jobId || isFailed ? (
        <>
          <p className="wl-modal__desc" style={{ marginBottom: 14 }}>
            Generate a printable document of your wellness data for a date range and the categories
            you choose. Open it in a browser and print to PDF to share.
          </p>

          <Note variant="practical" className="wl-export-boundaries">
            Dates include UTC calendar days, from 00:00 UTC through the end of the To day. These may
            differ from your local days. Choose up to 366 days, including both dates.
          </Note>
          {!rangeValid ? (
            <p role="alert">Choose an ordered date range of no more than 366 inclusive days.</p>
          ) : null}
          <div className="wl-field" style={{ marginBottom: 12 }}>
            <label htmlFor="wlexport-from" className="wl-field__label">
              From
            </label>
            <input
              id="wlexport-from"
              type="date"
              className="wl-input"
              value={from}
              max={to}
              disabled={isStarting}
              onChange={(e) => updateDraft({ ...draft, from: e.target.value })}
            />
          </div>
          <div className="wl-field" style={{ marginBottom: 12 }}>
            <label htmlFor="wlexport-to" className="wl-field__label">
              To
            </label>
            <input
              id="wlexport-to"
              type="date"
              className="wl-input"
              value={to}
              max={defaults.to}
              disabled={isStarting}
              onChange={(e) => updateDraft({ ...draft, to: e.target.value })}
            />
          </div>

          <fieldset className="wl-fieldset" style={{ marginBottom: 12 }}>
            <legend className="wl-field__label">Include</legend>
            {WELLNESS_EXPORT_CATEGORIES.map((cat) => (
              <label key={cat} className="jds-check">
                <input
                  type="checkbox"
                  disabled={isStarting}
                  checked={categories.includes(cat)}
                  onChange={() => toggleCategory(cat)}
                />
                <span className="jds-check__box">
                  <CheckIcon />
                </span>
                {CATEGORY_LABELS[cat]}
              </label>
            ))}
          </fieldset>

          <label className="jds-check" style={{ marginBottom: 14, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              disabled={isStarting}
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span className="jds-check__box">
              <CheckIcon />
            </span>
            <span className="wl-consent-text">{SENSITIVE_COPY}</span>
          </label>

          {isFailed || startMutation.isError ? (
            <div
              className="wl-modal__note wl-modal__note--error"
              role="alert"
              style={{ marginBottom: 10 }}
            >
              {startMutation.error instanceof ApiError && startMutation.error.status === 409
                ? "An export is already in progress with different parameters. Keep this selection and try again when that export finishes."
                : "Export failed. Your selection is still here. Please try again."}
            </div>
          ) : null}

          <Button
            variant="primary"
            icon={<DownloadIcon />}
            disabled={!canGenerate || isStarting}
            onClick={() => {
              if (!canGenerate || starting.current) return;
              starting.current = true;
              startMutation.mutate({ ...draft, from, to, categories: [...categories] });
            }}
          >
            {isStarting ? "Starting…" : "Generate export"}
          </Button>
        </>
      ) : isExpired || isUnavailable ? (
        <div role="status">
          <p>
            {isExpired ? "This export has expired." : "This export is no longer available."} Your
            selected range and categories are still here.
          </p>
          <Button variant="primary" onClick={reset}>
            Generate again
          </Button>
        </div>
      ) : statusQuery.isError ? (
        <p role="alert">
          Could not check your export. Your job is still saved; retry its status before starting
          another export.{" "}
          <Button variant="link" onClick={() => void statusQuery.refetch()}>
            Try again
          </Button>
        </p>
      ) : inProgress || statusQuery.isPending ? (
        <div className="wl-modal__progress" role="status">
          <p>Building your export… this usually takes a few seconds.</p>
        </div>
      ) : isReady && jobId ? (
        <div className="wl-modal__ready" role="status">
          <p className="wl-modal__note">
            Your export is ready. Open it in a browser and print to PDF to share.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <ButtonLink
              href={getDataExportDownloadUrl(jobId)}
              variant="primary"
              size="sm"
              icon={<DownloadIcon />}
              download
            >
              Download
            </ButtonLink>
            <Button variant="quiet" size="sm" onClick={reset}>
              Start a new export
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
