import { describe, expect, it } from "vitest";
import { hasUsefulSportsAnswer } from "../uat/sports-answer.js";

const result = { home: { name: "Brentford", score: 1 }, away: { name: "Liverpool", score: 2 } };

describe("Sports acceptance prose", () => {
  it.each([
    "Liverpool beat Brentford 2–1.",
    "Brentford 1-2 Liverpool.",
    "Liverpool won 2 — 1 away at Brentford."
  ])("accepts the concise result: %s", (reply) => {
    expect(hasUsefulSportsAnswer(reply, result)).toBe(true);
  });

  it.each([
    "",
    "Arsenal beat Brentford 2–1.",
    "Liverpool beat Chelsea 2–1.",
    "Liverpool beat Brentford 3–0.",
    "Liverpool beat Brentford 12–11.",
    "Liverpool and Brentford played on October 12.",
    "Unable to retrieve Liverpool versus Brentford 2–1.",
    "root = Liverpool Brentford 2–1"
  ])("rejects missing, unrelated or unusable content: %s", (reply) => {
    expect(hasUsefulSportsAnswer(reply, result)).toBe(false);
  });
});
