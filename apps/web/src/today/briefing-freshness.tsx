import type { SourceFreshnessEntry, SourceFreshnessV1 } from "@moss/shared";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const EMAIL_DELAY_THRESHOLD_MS = 60 * 60 * 1000;

const SOURCE_LABEL: Record<string, string> = {
  email: "Email",
  calendar: "Calendar",
  vault: "Notes",
  tasks: "Tasks",
  commitments: "Commitments",
  chats: "Chats",
  goals: "Goals"
};

function formatAge(entry: SourceFreshnessEntry, capturedAt: string): string {
  if (entry.freshnessKind === "realtime") return "live";
  if (!entry.asOf) return "unknown";
  const ageMs = new Date(capturedAt).getTime() - new Date(entry.asOf).getTime();
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

function isStale(entry: SourceFreshnessEntry, capturedAt: string): boolean {
  if (entry.freshnessKind === "realtime" || !entry.asOf) return false;
  return new Date(capturedAt).getTime() - new Date(entry.asOf).getTime() > STALE_THRESHOLD_MS;
}

export function BriefingFreshnessList({ freshness }: { readonly freshness: SourceFreshnessV1 }) {
  return (
    <div className="bfresh">
      <span className="bfresh__label">Sources</span>
      <ul className="bfresh__list">
        {freshness.sources.map((entry) => {
          const age = formatAge(entry, freshness.capturedAt);
          return (
            <li key={entry.source} className="bfresh__item">
              <span className="bfresh__source">{SOURCE_LABEL[entry.source] ?? entry.source}</span>
              <span
                className={`bfresh__age${
                  entry.freshnessKind === "realtime"
                    ? " bfresh__age--live"
                    : age === "unknown"
                      ? " bfresh__age--unknown"
                      : ""
                }`}
                title={entry.asOf ?? undefined}
              >
                {age}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function delayedEmailSource(
  freshness: SourceFreshnessV1 | null
): (SourceFreshnessEntry & { readonly asOf: string }) | null {
  if (!freshness) return null;
  const email = freshness.sources.find((entry) => entry.source === "email");
  if (!email || email.freshnessKind === "realtime" || !email.asOf) return null;
  const capturedAt = Date.parse(freshness.capturedAt);
  const asOf = Date.parse(email.asOf);
  if (!Number.isFinite(capturedAt) || !Number.isFinite(asOf)) return null;
  return capturedAt - asOf > EMAIL_DELAY_THRESHOLD_MS ? { ...email, asOf: email.asOf } : null;
}

export function BriefingStaleBanner({
  freshness,
  excludeSources = []
}: {
  readonly freshness: SourceFreshnessV1;
  readonly excludeSources?: readonly string[];
}) {
  const excluded = new Set(excludeSources);
  const stale = freshness.sources.filter(
    (entry) => !excluded.has(entry.source) && isStale(entry, freshness.capturedAt)
  );
  if (stale.length === 0) return null;
  const names = stale.map((e) => SOURCE_LABEL[e.source] ?? e.source).join(", ");
  return <p className="bfresh__stale">Some sources are over a day old: {names}.</p>;
}

export function parseBriefingFreshness(
  sourceMetadata: Record<string, unknown>
): SourceFreshnessV1 | null {
  const ts = sourceMetadata.sourceTimestamps;
  if (!ts || typeof ts !== "object" || Array.isArray(ts)) return null;
  const rec = ts as Record<string, unknown>;
  if (rec.version !== 1 || typeof rec.capturedAt !== "string" || !Array.isArray(rec.sources))
    return null;
  return ts as SourceFreshnessV1;
}
