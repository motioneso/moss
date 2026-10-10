import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, ButtonLink, Dialog } from "@moss/ui";
import { WELLNESS_EXPORT_CATEGORIES, type WellnessExportCategory } from "@moss/shared";
import { getDataExportDownloadUrl, getDataExportStatus, type ExportJobStatus } from "../api/client";
import { requestWellnessExport } from "../api/wellness-export";

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

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayIso(): string {
  return isoDaysAgo(0);
}

const SENSITIVE_COPY =
  "This export will contain sensitive health and wellness data. Anyone you share it with will see it. Generate only if you trust the recipient (e.g. your doctor or therapist).";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function WellnessExportModal({ open, onClose }: Props) {
  const [from, setFrom] = useState<string>(isoDaysAgo(90));
  const [to, setTo] = useState<string>(todayIso());
  const [categories, setCategories] = useState<readonly WellnessExportCategory[]>([
    ...WELLNESS_EXPORT_CATEGORIES
  ]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const rangeValid = from <= to && from !== "" && to !== "";
  const categoriesValid = categories.length > 0;

  const statusQuery = useQuery<ExportJobStatus>({
    queryKey: ["wellness-export", "status", jobId],
    queryFn: () => getDataExportStatus(jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "building" ? 2000 : false;
    }
  });

  const startMutation = useMutation({
    mutationFn: () =>
      requestWellnessExport({
        from,
        to,
        categories: [...categories] as readonly WellnessExportCategory[]
      }),
    onSuccess: (data) => setJobId(data.jobId)
  });

  if (!open) return null;

  const status = statusQuery.data?.status;
  const isReady = status === "ready";
  const isFailed = status === "failed";
  const inProgress = status === "pending" || status === "building";
  const canGenerate = rangeValid && categoriesValid && acknowledged && (jobId === null || isFailed);

  function toggleCategory(cat: WellnessExportCategory) {
    setCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  }

  function reset() {
    setJobId(null);
    setAcknowledged(false);
    startMutation.reset();
  }

  function close() {
    reset();
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
              onChange={(e) => setFrom(e.target.value)}
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
              max={todayIso()}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>

          <fieldset className="wl-fieldset" style={{ marginBottom: 12 }}>
            <legend className="wl-field__label">Include</legend>
            {WELLNESS_EXPORT_CATEGORIES.map((cat) => (
              <label key={cat} className="jds-check">
                <input
                  type="checkbox"
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
              Export failed. Please try again.
            </div>
          ) : null}

          <Button
            variant="primary"
            icon={<DownloadIcon />}
            disabled={!canGenerate || startMutation.isPending}
            onClick={() => startMutation.mutate()}
          >
            {startMutation.isPending ? "Starting…" : "Generate export"}
          </Button>
        </>
      ) : statusQuery.isError ? (
        <p role="alert">
          Could not check your export.{" "}
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
