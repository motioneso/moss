import { describe, expect, it } from "vitest";
import { hasUsefulWeatherAnswer } from "../uat/weather-answer.js";
import { forecastSnapshot } from "../fixtures/weather-forecast.js";

describe("installed Weather prose assessment", () => {
  const forecast = forecastSnapshot().fields;
  it("accepts a source-grounded jacket interpretation with rounded temperature range", () => {
    expect(
      hasUsefulWeatherAnswer(
        "Bring a light jacket: around 57–60°F this evening, with some rain possible.",
        forecast
      )
    ).toBe(true);
  });
  it.each(["57 to 60 degrees Fahrenheit", "57–60 Fahrenheit", "57 to 60 F", "57 and 60 degrees"])(
    "accepts equivalent source-grounded temperature wording: %s",
    (temperature) => {
      expect(
        hasUsefulWeatherAnswer(
          `Bring a light jacket: around ${temperature} this evening, with some rain possible.`,
          forecast
        )
      ).toBe(true);
    }
  );
  it("accepts ordinary Celsius wording using the source's metric units", () => {
    const metric = {
      ...forecast,
      unit: "metric" as const,
      windUnit: "km/h" as const,
      intervals: forecast.intervals.map((item) => ({
        ...item,
        temperature: ((item.temperature - 32) * 5) / 9
      }))
    };
    expect(
      hasUsefulWeatherAnswer(
        "Bring a light jacket: around 14 to 16 degrees Celsius this evening.",
        metric
      )
    ).toBe(true);
    expect(
      hasUsefulWeatherAnswer(
        "Bring a light jacket: around 14 to 16 degrees Fahrenheit this evening.",
        metric
      )
    ).toBe(false);
  });
  it.each([
    "I don't know whether you need a jacket; perhaps check another forecast.",
    "Bring a jacket: this evening will be around 90°F at your saved location.",
    "Bring a jacket: this evening will be around 90 degrees Fahrenheit at your saved location.",
    "Bring a jacket: this evening will be around 57–60°C at your saved location.",
    "A jacket could be nice. Perhaps check another forecast for your weather.",
    "The jacket is blue and the weather exists somewhere outside tonight."
  ])("rejects nonanswers and unsupported source claims: %s", (reply) => {
    expect(hasUsefulWeatherAnswer(reply, forecast)).toBe(false);
  });
});
