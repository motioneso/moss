// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeatherForecastCard } from "../../packages/weather/src/forecast/card.js";
import {
  weatherWindowCoverage,
  formatWeatherForecastSnapshot
} from "../../packages/weather/src/forecast/contract.js";
import { weatherForecastSnapshot } from "../../packages/weather/src/forecast/tool.js";
import { selectForecastWindow } from "../../packages/weather/src/forecast/window.js";
import {
  forecastSnapshot,
  intervalSource,
  weatherIntervals,
  weatherPlace
} from "../fixtures/weather-forecast.js";

function render(snapshot = forecastSnapshot()) {
  return new DOMParser().parseFromString(
    renderToStaticMarkup(createElement(WeatherForecastCard, { snapshot })),
    "text/html"
  );
}

describe("saved Weather card", () => {
  it("renders A inline with friendly dates, all hour buckets and one quiet source line", () => {
    const snapshot = forecastSnapshot();
    const doc = render(snapshot);
    expect(doc.querySelector("h3")?.textContent).toBe("Los Angeles, California, United States");
    expect(doc.body.textContent).toContain("This evening");
    expect(doc.body.textContent).toContain("Sat, Oct 24 · 6–10 PM PDT");
    expect(doc.body.textContent).not.toContain("America/Los_Angeles");
    expect(doc.body.textContent).not.toContain("2026-10-24");
    expect(doc.body.textContent).not.toContain("Local weather forecast");
    expect(doc.body.textContent).not.toContain("Name another city and region");
    expect(doc.querySelector(".jds-card")).toBeNull();
    expect([...doc.querySelectorAll("li small")].map((e) => e.textContent)).toEqual([
      "6–7 PM",
      "7–8 PM",
      "8–9 PM",
      "9–10 PM"
    ]);
    expect(doc.querySelectorAll(".weather-forecast__line")).toHaveLength(3);
    expect(doc.querySelectorAll(".weather-forecast__dot")).toHaveLength(4);
    expect(doc.querySelectorAll("li svg")).toHaveLength(4);
    expect(doc.querySelector("footer")?.textContent).toBe("Open-Meteo · Updated 3:00 AM");
    expect(doc.querySelectorAll("footer")).toHaveLength(1);
    expect(doc.querySelector("button")).toBeNull();
    const fallback = formatWeatherForecastSnapshot(snapshot);
    expect(fallback).toContain("60°F");
    expect(fallback).toContain("10%");
    expect(fallback).toContain("8 mph");
  });

  it("rounds hourly temperatures and range consistently without mutating saved data", () => {
    const snapshot = forecastSnapshot();
    snapshot.fields.intervals[0]!.temperature = 60.4;
    snapshot.fields.intervals[3]!.temperature = 56.6;
    const before = JSON.stringify(snapshot);
    const doc = render(snapshot);
    expect(doc.querySelector(".weather-forecast__summary strong")?.textContent).toBe("57–60°F");
    expect([...doc.querySelectorAll("li > strong")].map((e) => e.textContent)).toEqual([
      "60°",
      "59°",
      "58°",
      "57°"
    ]);
    expect(doc.body.textContent).not.toMatch(/60\.4|56\.6/);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("preserves missing positions, breaks the curve and scopes partial peaks to known hours", () => {
    const snapshot = forecastSnapshot();
    snapshot.fields.coverage = "partial";
    snapshot.fields.intervals.splice(1, 1);
    snapshot.fields.locationSource = "timezone-fallback";
    snapshot.fields.approximate = true;
    snapshot.fields.stale = true;
    snapshot.fields.observedAt = null;
    snapshot.fields.intervals[0]!.rainProbability = null;
    snapshot.fields.intervals[0]!.windSpeed = null;
    snapshot.coverage = weatherWindowCoverage(snapshot.fields);
    const doc = render(snapshot);
    expect(doc.body.textContent).toContain("Partial forecast");
    expect(doc.body.textContent).toContain("7–8 PM unavailable");
    expect(doc.body.textContent).toContain("Approximate location");
    expect(doc.body.textContent).toContain(
      "Name another city and region in chat to correct it without saving Settings."
    );
    expect(doc.body.textContent).toContain("Stale forecast");
    expect(doc.body.textContent).toContain("Observation unavailable");
    expect([...doc.querySelectorAll("dd")].map((e) => e.textContent)).toEqual([
      "Unknown",
      "Unknown"
    ]);
    expect(doc.body.textContent).toContain("known hours");
    expect(doc.querySelectorAll("li")).toHaveLength(4);
    expect(doc.querySelectorAll("li")[1]?.getAttribute("aria-label")).toBe("7–8 PM: unavailable");
    expect(doc.querySelectorAll(".weather-forecast__line")).toHaveLength(1);
    expect(doc.querySelectorAll(".weather-forecast__dot")).toHaveLength(3);
  });

  it("shows available peaks without claiming whole-window coverage", () => {
    const snapshot = forecastSnapshot();
    snapshot.fields.coverage = "partial";
    snapshot.fields.intervals.splice(1, 1);
    snapshot.coverage = weatherWindowCoverage(snapshot.fields);
    const doc = render(snapshot);
    expect([...doc.querySelectorAll("dt")].map((e) => e.textContent)).toEqual([
      "Rain chance · known hours",
      "Wind · known hours"
    ]);
    expect([...doc.querySelectorAll("dd")].map((e) => e.textContent)).toEqual(["13%", "8 mph"]);
  });

  it("supports Celsius, negative temperatures, rain icons and flat curves", () => {
    const snapshot = forecastSnapshot();
    snapshot.fields.unit = "metric";
    snapshot.fields.windUnit = "km/h";
    for (const item of snapshot.fields.intervals) {
      item.temperature = -2.4;
      item.condition = "Light rain";
    }
    const doc = render(snapshot);
    expect(doc.querySelector(".weather-forecast__summary strong")?.textContent).toBe("-2–-2°C");
    expect(doc.querySelectorAll("li .lucide-cloud-rain")).toHaveLength(4);
    expect(doc.body.textContent).toContain("8 km/h");
    expect(doc.querySelector("svg")?.outerHTML).not.toContain("NaN");
  });

  it("keeps long windows and both DST fold hours, with calendar dates for future snapshots", () => {
    const now = new Date("2026-10-31T12:00:00Z");
    const source = intervalSource({
      intervals: weatherIntervals("2026-11-01", "America/Los_Angeles", 0, 12)
    });
    const window = selectForecastWindow(
      source,
      weatherPlace,
      { dayOffset: 1, startHour: 0, endHour: 12 },
      now
    )!;
    const snapshot = { ...weatherForecastSnapshot(window), ref: "weather-ref" };
    const doc = render(snapshot);
    expect(doc.querySelectorAll("li")).toHaveLength(13);
    expect(doc.querySelectorAll(".weather-forecast__dot")).toHaveLength(13);
    const labels = [...doc.querySelectorAll("li small")].map((e) => e.textContent);
    expect(labels[1]).toContain("PDT");
    expect(labels[2]).toContain("PST");
    expect(labels.at(-1)).toBe("11 AM–12 PM");
    expect(doc.body.textContent).toContain("Sun, Nov 1");
    expect(doc.body.textContent).not.toContain("This evening");
  });

  it("retains missing edge hours and never fabricates an endpoint observation", () => {
    const snapshot = forecastSnapshot();
    snapshot.fields.coverage = "partial";
    snapshot.fields.intervals.shift();
    snapshot.fields.intervals.pop();
    snapshot.fields.coveredStart = snapshot.fields.intervals[0]!.startsAt;
    snapshot.fields.coveredEnd = snapshot.fields.intervals.at(-1)!.endsAt;
    snapshot.coverage = weatherWindowCoverage(snapshot.fields);
    const doc = render(snapshot);
    expect(doc.querySelectorAll("li")).toHaveLength(4);
    expect(doc.querySelectorAll(".weather-forecast__dot")).toHaveLength(2);
    expect(doc.querySelectorAll("li")[3]?.textContent).toContain("9–10 PM");
    expect(doc.querySelectorAll("li")[3]?.getAttribute("aria-label")).toContain("unavailable");
  });

  it("falls back to a compact empty state without numeric content for an invalid snapshot", () => {
    const snapshot = forecastSnapshot();
    snapshot.fields.intervals = [];
    const doc = render(snapshot);
    expect(doc.querySelector('[role="status"]')?.textContent).toContain(
      "Hourly forecast unavailable"
    );
    expect(doc.querySelector(".jds-empty")).not.toBeNull();
    expect(doc.querySelector(".weather-forecast__curve")).toBeNull();
    expect(doc.body.textContent).not.toMatch(/°|NaN|Infinity/);
  });
});
