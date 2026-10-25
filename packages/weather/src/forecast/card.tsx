import type { CSSProperties } from "react";
import { Badge, Divider, EmptyState, Eyebrow } from "@moss/ui";
import { formatInZone, type VisualSnapshotV1 } from "@moss/shared";
import {
  Cloud,
  CloudFog,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  CloudLightning,
  CircleHelp,
  Droplets,
  Moon,
  Sun,
  Wind,
  type LucideIcon
} from "lucide-react";
import { readWeatherForecastSnapshot } from "./contract.js";
import { forecastPresentation } from "./card-presentation.js";
import "./card.css";

const conditionIcons: readonly [RegExp, LucideIcon, LucideIcon?][] = [
  [/thunder/i, CloudLightning],
  [/snow|hail/i, CloudSnow],
  [/rain|drizzle|shower/i, CloudRain],
  [/fog/i, CloudFog],
  [/partly cloudy/i, CloudSun, CloudMoon],
  [/clear/i, Sun, Moon],
  [/overcast|cloud/i, Cloud]
];

function ConditionIcon({
  condition,
  at,
  zone,
  size = 20
}: {
  condition: string;
  at: string;
  zone: string;
  size?: number;
}) {
  const hour = Number(formatInZone(at, zone, { hour: "numeric", hourCycle: "h23" }, "en-US"));
  const match = conditionIcons.find(([pattern]) => pattern.test(condition));
  const Icon = (hour >= 18 || hour < 6 ? match?.[2] : undefined) ?? match?.[1] ?? CircleHelp;
  return <Icon size={size} strokeWidth={1.5} aria-hidden="true" />;
}

export function WeatherForecastCard({ snapshot }: { snapshot: VisualSnapshotV1 }) {
  const v = readWeatherForecastSnapshot(snapshot);
  if (!v)
    return (
      <div className="weather-forecast" role="status">
        <EmptyState
          icon={<Cloud aria-hidden="true" />}
          title="Hourly forecast unavailable"
          description="Try again in a moment."
        />
        <Divider />
        <footer className="weather-forecast__source">
          Open-Meteo · Hourly forecast unavailable
        </footer>
      </div>
    );
  const p = forecastPresentation(v);
  const degree = v.unit === "imperial" ? "°F" : "°C";
  const first = v.intervals[0]!;
  const x = (index: number) => 50 + index * 100;
  const y = (temperature: number) => 20 + ((p.max - temperature) / Math.max(5, p.max - p.min)) * 60;
  return (
    <section className="weather-forecast" aria-label={`${v.place} hourly forecast`}>
      <header className="weather-forecast__head">
        <div>
          <Eyebrow tone="accent">{v.coverage === "partial" ? "Available hours" : p.day}</Eyebrow>
          <h3>{v.place}</h3>
          <p>
            {p.window}
            {v.approximate ? " · Approximate location" : ""}
          </p>
        </div>
        <ConditionIcon condition={p.condition} at={first.startsAt} zone={v.timeZone} size={36} />
      </header>
      {v.coverage === "partial" && (
        <div className="weather-forecast__coverage" role="status">
          <Badge tone="amber">Partial forecast</Badge>
          <span>
            {p.hours
              .filter((h) => !h.item)
              .map((h) => h.label)
              .join(", ")}{" "}
            unavailable
          </span>
        </div>
      )}
      <div className="weather-forecast__summary">
        <strong>
          {p.min}–{p.max}
          <span>{degree}</span>
        </strong>
        <span>{p.condition}</span>
      </div>
      <div
        className="weather-forecast__scroll"
        role="region"
        aria-label="Hourly forecast"
        tabIndex={0}
      >
        <div
          className="weather-forecast__curve"
          style={{ "--weather-hours": p.hours.length } as CSSProperties}
        >
          <svg
            viewBox={`0 0 ${p.hours.length * 100} 110`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className="weather-forecast__baseline" d={`M 50 95 H ${x(p.hours.length - 1)}`} />
            {p.hours.map((hour, i) => {
              const next = p.hours[i + 1];
              return hour.temperature !== null && next && next.temperature !== null ? (
                <path
                  className="weather-forecast__line"
                  key={hour.at}
                  d={`M ${x(i)} ${y(hour.temperature)} L ${x(i + 1)} ${y(next.temperature)}`}
                />
              ) : null;
            })}
            {p.hours.map((hour, i) =>
              hour.temperature !== null ? (
                <circle
                  className="weather-forecast__dot"
                  key={hour.at}
                  cx={x(i)}
                  cy={y(hour.temperature)}
                  r="4"
                />
              ) : null
            )}
          </svg>
          <ul className="weather-forecast__hours">
            {p.hours.map((hour) => (
              <li
                key={hour.at}
                aria-label={`${hour.label}: ${hour.item ? `${hour.temperature}${degree}, ${hour.item.condition}; rain ${hour.item.rainProbability === null ? "unknown" : `${Math.round(hour.item.rainProbability)}%`}; wind ${hour.item.windSpeed === null ? "unknown" : `${Math.round(hour.item.windSpeed)} ${v.windUnit}`}` : "unavailable"}`}
              >
                <strong>{hour.temperature === null ? "—" : `${hour.temperature}°`}</strong>
                {hour.item ? (
                  <ConditionIcon
                    condition={hour.item.condition}
                    at={hour.item.startsAt}
                    zone={v.timeZone}
                  />
                ) : (
                  <span aria-hidden="true">—</span>
                )}
                <small>
                  <time dateTime={new Date(hour.at).toISOString()}>{hour.label}</time>
                </small>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <dl className="weather-forecast__facts">
        <div>
          <Droplets size={20} aria-hidden="true" />
          <div>
            <dt>Rain chance · {v.coverage === "partial" ? "known hours" : "peak"}</dt>
            <dd>
              {p.peak(
                v.intervals.map((i) => i.rainProbability),
                "%"
              )}
            </dd>
          </div>
        </div>
        <div>
          <Wind size={20} aria-hidden="true" />
          <div>
            <dt>Wind · {v.coverage === "partial" ? "known hours" : "peak"}</dt>
            <dd>
              {p.peak(
                v.intervals.map((i) => i.windSpeed),
                ` ${v.windUnit}`
              )}
            </dd>
          </div>
        </div>
      </dl>
      <Divider />
      <footer className="weather-forecast__source">
        Open-Meteo · Updated{" "}
        <time dateTime={v.retrievedAt}>
          {formatInZone(
            v.retrievedAt,
            v.timeZone,
            { hour: "numeric", minute: "2-digit", hour12: true },
            "en-US"
          )}
        </time>
        {v.stale ? " · Stale forecast" : ""}
        {v.observedAt === null ? " · Observation unavailable" : ""}
      </footer>
    </section>
  );
}
export default { "weather.forecast": WeatherForecastCard };
