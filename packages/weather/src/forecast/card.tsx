import { Card, SectionHead, Badge, Note } from "@moss/ui";
import { formatInZone, type VisualSnapshotV1 } from "@moss/shared";
import { readWeatherForecastSnapshot, weatherWindowCoverage } from "./contract.js";
import "./card.css";

export function WeatherForecastCard({ snapshot }: { snapshot: VisualSnapshotV1 }) {
  const v = readWeatherForecastSnapshot(snapshot);
  if (!v) throw new Error("Weather forecast unavailable");
  const degree = v.unit === "imperial" ? "°F" : "°C";
  const temperatures = v.intervals.map((item) => item.temperature);
  const rains = v.intervals.map((item) => item.rainProbability);
  const winds = v.intervals.map((item) => item.windSpeed);
  const peak = (values: readonly (number | null)[], unit: string) =>
    values.every((n): n is number => n !== null)
      ? `${Math.max(...values)}${unit}`
      : "Unknown for this window";
  return (
    <Card>
      <div className="weather-forecast">
        <SectionHead
          title="Local weather forecast"
          titleAs="h3"
          meta={<Badge>{v.coverage === "complete" ? "Hourly forecast" : "Partial coverage"}</Badge>}
        />
        <p>
          <strong>{v.place}</strong>
          {v.approximate ? " · Approximate location" : ""}
        </p>
        <p>
          {v.localDate} · {v.startHour}:00–{v.endHour}:00 · {v.timeZone}
        </p>
        <dl className="weather-forecast__metrics">
          <div>
            <dt>Temperature range</dt>
            <dd>
              {Math.min(...temperatures)}–{Math.max(...temperatures)}
              {degree}
            </dd>
          </div>
          <div>
            <dt>Peak rain chance{v.coverage === "partial" ? " (available hours)" : ""}</dt>
            <dd>{peak(rains, "%")}</dd>
          </div>
          <div>
            <dt>Peak wind{v.coverage === "partial" ? " (available hours)" : ""}</dt>
            <dd>{peak(winds, ` ${v.windUnit}`)}</dd>
          </div>
        </dl>
        <ul className="weather-forecast__intervals" aria-label="Hourly forecast">
          {v.intervals.map((item) => (
            <li key={item.startsAt}>
              <strong>
                <time dateTime={item.startsAt}>
                  {formatInZone(item.startsAt, v.timeZone, {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZoneName: "short"
                  })}
                </time>{" "}
                · {item.temperature}
                {degree}
              </strong>
              <span>{item.condition}</span>
              <span>
                Rain {item.rainProbability === null ? "unknown" : `${item.rainProbability}%`} · Wind{" "}
                {item.windSpeed === null ? "unknown" : `${item.windSpeed} ${v.windUnit}`}
              </span>
            </li>
          ))}
        </ul>
        <Note variant="practical">
          <p>
            Open-Meteo · Retrieved{" "}
            <time dateTime={v.retrievedAt}>
              {formatInZone(v.retrievedAt, v.timeZone, { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </p>
          <p>
            Observation:{" "}
            {v.observedAt
              ? formatInZone(v.observedAt, v.timeZone, { dateStyle: "medium", timeStyle: "short" })
              : "Unavailable"}
            {v.stale ? " · Stale snapshot" : ""}
          </p>
          <p>{weatherWindowCoverage(v)}</p>
          {v.approximate ? (
            <p>
              This is an approximate place. Name another city and region in the conversation to
              correct it without saving Settings.
            </p>
          ) : null}
        </Note>
      </div>
    </Card>
  );
}
export default { "weather.forecast": WeatherForecastCard };
