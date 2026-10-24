import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WeatherForecastCard } from "../../packages/weather/src/forecast/card.js";
import {
  weatherWindowCoverage,
  formatWeatherForecastSnapshot
} from "../../packages/weather/src/forecast/contract.js";
import { forecastSnapshot } from "../fixtures/weather-forecast.js";

describe("saved Weather card", () => {
  it("renders exact source units/place/local hours with equivalent readable text", () => {
    const snapshot = forecastSnapshot();
    const html = renderToStaticMarkup(createElement(WeatherForecastCard, { snapshot }));
    expect(html).toContain("Los Angeles, California, United States");
    expect(html).toContain("America/Los_Angeles");
    expect(html).toContain("57–60");
    expect(html).toContain("Hourly forecast");
    expect(html).toContain("Open-Meteo");
    expect(html).not.toContain("<button");
    const fallback = formatWeatherForecastSnapshot(snapshot);
    expect(fallback).toContain("60°F");
    expect(fallback).toContain("10%");
    expect(fallback).toContain("8 mph");
  });
  it("names partial, stale, approximate and unknown facts without inventing whole-window peaks", () => {
    const snapshot = forecastSnapshot();
    snapshot.fields.coverage = "partial";
    snapshot.fields.intervals.splice(1, 1);
    snapshot.fields.locationSource = "timezone-fallback";
    snapshot.fields.approximate = true;
    snapshot.fields.stale = true;
    snapshot.fields.intervals[0]!.rainProbability = null;
    snapshot.fields.intervals[0]!.windSpeed = null;
    snapshot.coverage = weatherWindowCoverage(snapshot.fields);
    const html = renderToStaticMarkup(createElement(WeatherForecastCard, { snapshot }));
    expect(html).toContain("Partial coverage");
    expect(html).toContain("Approximate location");
    expect(html).toContain("Stale snapshot");
    expect(html).toContain("Unknown for this window");
    expect(html).toContain("Missing intervals cannot establish the whole window");
  });
});
