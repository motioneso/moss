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
  it("does not interpret clock minutes before a temperature as a temperature range", () => {
    expect(
      hasUsefulWeatherAnswer(
        "It will cool from about 60°F at 18:00 to 57°F by 22:00; bring a light layer.",
        forecast
      )
    ).toBe(true);
  });
  it("accepts source-grounded rain advice without requiring a temperature", () => {
    expect(
      hasUsefulWeatherAnswer(
        "You can leave the umbrella at home, with only a 10% rain chance this evening.",
        forecast
      )
    ).toBe(true);
  });
  it("accepts a temperature drop calculated from the actual interval endpoints", () => {
    expect(
      hasUsefulWeatherAnswer(
        "It will cool from **60°F** to **57°F**—a drop of roughly **3°F**. Bring a light layer.",
        forecast
      )
    ).toBe(true);
  });
  it("keeps the inclusive rounding bound despite endpoint floating-point noise", () => {
    const decimal = {
      ...forecast,
      intervals: forecast.intervals.map((item, index) => ({
        ...item,
        temperature: [70.6, 68.5, 67.3, 66.2][index]!
      }))
    };
    expect(
      hasUsefulWeatherAnswer(
        "It will cool from about 71°F to 66°F—a drop of roughly 5°F. Bring a light layer.",
        decimal
      )
    ).toBe(true);
    expect(
      hasUsefulWeatherAnswer(
        "It will cool from about 71°F to 66°F—a drop of roughly 5.01°F. Bring a light layer.",
        decimal
      )
    ).toBe(false);
  });
  it.each([
    "It will cool from 60°F to 57°F—a drop of roughly 30°F. Bring a light layer.",
    "It will cool from 60°F to 57°F—a drop of roughly 3°C. Bring a light layer.",
    "Bring a light layer: it will be 3°F this evening."
  ])("rejects an unsupported difference or absolute temperature: %s", (reply) => {
    expect(hasUsefulWeatherAnswer(reply, forecast)).toBe(false);
  });
  it("requires the saved units even when other-unit values are accurately converted", () => {
    expect(
      hasUsefulWeatherAnswer("Bring a light layer: it will be around 14–16°C tonight.", forecast)
    ).toBe(false);
  });
  it.each([
    ["- **21:00:** 57°F", true],
    ["- **22:00:** 57°F", false],
    ["- **18:00:** 57°F", false]
  ])("grounds an explicit hourly row in its source sample: %s", (row, useful) => {
    expect(
      hasUsefulWeatherAnswer(`Evening temperatures:\n${row}\nBring a light layer.`, forecast)
    ).toBe(useful);
  });
  it.each([
    "I don't know whether you need a jacket; perhaps check another forecast.",
    "Bring a jacket: this evening will be around 90°F at your saved location.",
    "Bring a jacket: this evening will be around 90 degrees Fahrenheit at your saved location.",
    "Bring a jacket: this evening will be around 57–60°C at your saved location.",
    "A jacket could be nice. Perhaps check another forecast for your weather.",
    "The jacket is blue and the weather exists somewhere outside tonight.",
    "Bring an umbrella: the rain chance is 90% this evening.",
    "Bring a light jacket in the 57–60°F weather, but expect a 90% rain chance."
  ])("rejects nonanswers and unsupported source claims: %s", (reply) => {
    expect(hasUsefulWeatherAnswer(reply, forecast)).toBe(false);
  });
});
