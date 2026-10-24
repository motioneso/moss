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
  it.each([
    "I don't know whether you need a jacket; perhaps check another forecast.",
    "Bring a jacket: this evening will be around 90°F at your saved location.",
    "Bring a jacket: this evening will be around 57–60°C at your saved location.",
    "A jacket could be nice. Perhaps check another forecast for your weather.",
    "The jacket is blue and the weather exists somewhere outside tonight."
  ])("rejects nonanswers and unsupported source claims: %s", (reply) => {
    expect(hasUsefulWeatherAnswer(reply, forecast)).toBe(false);
  });
});
