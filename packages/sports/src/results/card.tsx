import { Card, SectionHead, Badge, Note, IdentityMetric } from "@moss/ui";
import type { VisualSnapshotV1 } from "@moss/shared";
import { readSportsResultSnapshot } from "./contract.js";
import "./card.css";

export function SportsResultCard({ snapshot }: { snapshot: VisualSnapshotV1 }) {
  const result = readSportsResultSnapshot(snapshot);
  if (!result) throw new Error("Sports result unavailable");
  const score = (n: number | null) => (n === null ? "Unknown" : String(n));
  return (
    <Card>
      <div className="sports-result">
        <SectionHead
          title="Latest available result"
          titleAs="h3"
          meta={<Badge>{result.status}</Badge>}
        />
        <div className="sports-result__teams" aria-label="Match result">
          <IdentityMetric
            name={result.home.name}
            imageSrc={result.home.crestUrl}
            value={score(result.home.score)}
            detail="Home"
          />
          <IdentityMetric
            name={result.away.name}
            imageSrc={result.away.crestUrl}
            value={score(result.away.score)}
            detail="Away"
          />
        </div>
        <p>
          {result.competition} ·{" "}
          <time dateTime={result.startsAt}>
            {new Date(result.startsAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short"
            })}
          </time>
        </p>
        {result.home.shootout !== null || result.away.shootout !== null ? (
          <p>
            Shootout: {score(result.home.shootout)}–{score(result.away.shootout)} (home–away)
          </p>
        ) : null}
        {result.home.aggregate !== null || result.away.aggregate !== null ? (
          <p>
            Aggregate: {score(result.home.aggregate)}–{score(result.away.aggregate)} (home–away)
          </p>
        ) : null}
        <Note variant="practical">
          <p>
            ESPN · Retrieved{" "}
            <time dateTime={snapshot.retrievedAt}>
              {new Date(snapshot.retrievedAt).toLocaleString()}
            </time>
          </p>
          <p>{snapshot.coverage}</p>
        </Note>
      </div>
    </Card>
  );
}
export default { "sports.result": SportsResultCard };
