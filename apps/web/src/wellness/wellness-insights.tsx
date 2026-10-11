import { Button, SectionHead } from "@moss/ui";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../api/query-keys";
import { getWellnessInsights } from "../api/client";

function ActivityIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}
function CloudRainIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M16 14v6" />
      <path d="M8 14v6" />
      <path d="M12 16v6" />
    </svg>
  );
}
function NotebookPenIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" />
      <path d="M2 6h4" />
      <path d="M2 10h4" />
      <path d="M2 14h4" />
      <path d="M2 18h4" />
      <path d="m21.378 3.626-1.004-1.004a2.121 2.121 0 0 0-3 0l-5.37 5.374 2 2 5.37-5.374" />
    </svg>
  );
}
function PillIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
      <path d="m8.5 8.5 7 7" />
    </svg>
  );
}
function ArrowRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

const INSIGHT_ICONS: Record<string, React.ReactNode> = {
  Activity: <ActivityIcon />,
  Sun: <SunIcon />,
  CloudRain: <CloudRainIcon />,
  NotebookPen: <NotebookPenIcon />,
  Pill: <PillIcon />
};

interface Props {
  onReviewNotes: () => void;
}

export function WellnessInsights({ onReviewNotes }: Props) {
  const insightsQuery = useQuery({
    queryKey: queryKeys.wellness.insights,
    queryFn: getWellnessInsights
  });

  const insights = insightsQuery.data?.insights ?? [];

  return (
    <div className="wl-insights">
      <SectionHead number="02" title="What this month is telling you" meta="30 days" />
      <div className="wl-insights__body">
        {insightsQuery.isLoading ? (
          <div className="wl-insight" style={{ padding: "16px 0" }}>
            <span className="wl-subtle-text" role="status">
              Loading insights&hellip;
            </span>
          </div>
        ) : insightsQuery.isError ? (
          <div className="wl-insight">
            <span className="wl-subtle-text" role="status">
              Couldn&apos;t load insights.{" "}
              <Button variant="link" onClick={() => void insightsQuery.refetch()}>
                Try again
              </Button>
            </span>
          </div>
        ) : insights.length === 0 ? (
          <div className="wl-insight" style={{ padding: "16px 0" }}>
            <span className="wl-subtle-text">
              Insights appear after about a week of check-ins. Keep going.
            </span>
          </div>
        ) : (
          insights.map((it) => (
            <div key={it.key} className="wl-insight">
              <span className={`wl-insight__ic wl-insight__ic--${it.tone}`}>
                {INSIGHT_ICONS[it.icon] ?? <ActivityIcon />}
              </span>
              <div className="wl-insight__main">
                <div className="wl-insight__tx">
                  <strong>{it.lead}</strong>
                  {it.rest}
                </div>
                {it.action === "review-notes" ? (
                  <div className="wl-insight__act">
                    <Button variant="link" onClick={onReviewNotes}>
                      Review those notes
                      <span className="ic">
                        <ArrowRightIcon />
                      </span>
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
