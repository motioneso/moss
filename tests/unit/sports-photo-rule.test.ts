import { describe, expect, it } from "vitest";

import {
  applySportsPhotoRule,
  validateSportsPhotoRule
} from "../../packages/sports/src/source/photo-rule.js";

/**
 * #2237 the saved instruction for where a publisher puts an article's lead photo. It is never
 * shown to anyone, so the only thing that matters is that a bad one is refused and a good one
 * finds exactly what it names, on the page the reader already fetched.
 */

const RULE = {
  version: 1,
  kind: "html",
  fetchHosts: ["www.publisher.example"],
  photo: { selector: "meta[property='og:image']", source: "attribute", attribute: "content" },
  fallback: "share_image"
};

describe("sports photo rule", () => {
  it("accepts a rule that names one publisher and a real selector", () => {
    const checked = validateSportsPhotoRule(RULE, { allowedHosts: ["www.publisher.example"] });
    expect(checked.ok).toBe(true);
  });

  it("refuses a rule that reaches outside the source's own allowed hosts", () => {
    expect(validateSportsPhotoRule(RULE, { allowedHosts: ["other.example"] }).ok).toBe(false);
    expect(
      validateSportsPhotoRule(
        { ...RULE, fetchHosts: ["www.publisher.example", "images.elsewhere.example"] },
        { allowedHosts: ["www.publisher.example", "images.elsewhere.example"] }
      ).ok
    ).toBe(false);
  });

  it("refuses anything that is not the agreed shape", () => {
    expect(validateSportsPhotoRule({ ...RULE, version: 2 }).ok).toBe(false);
    expect(validateSportsPhotoRule({ ...RULE, fetchHosts: [] }).ok).toBe(false);
    expect(validateSportsPhotoRule({ ...RULE, extra: true }).ok).toBe(false);
    expect(
      validateSportsPhotoRule({ ...RULE, photo: { ...RULE.photo, attribute: "onerror" } }).ok
    ).toBe(false);
    expect(
      validateSportsPhotoRule({
        ...RULE,
        photo: { ...RULE.photo, selector: "figure img::before" }
      }).ok
    ).toBe(false);
    expect(
      validateSportsPhotoRule({ ...RULE, photo: { ...RULE.photo, selector: "a".repeat(121) } }).ok
    ).toBe(false);
    expect(
      validateSportsPhotoRule({ ...RULE, photo: { ...RULE.photo, selector: "div[" } }).ok
    ).toBe(false);
  });

  it("finds the photo the rule names and makes the address absolute", () => {
    const checked = validateSportsPhotoRule(RULE);
    if (!checked.ok) throw new Error("expected a usable rule");
    const html = `<html><head><meta property="og:image" content="/media/lead.jpg"></head></html>`;
    expect(
      applySportsPhotoRule(html, "https://www.publisher.example/story/one", checked.rule)
    ).toBe("https://www.publisher.example/media/lead.jpg");
  });

  it("finds nothing rather than guessing when the page has moved on", () => {
    const checked = validateSportsPhotoRule(RULE);
    if (!checked.ok) throw new Error("expected a usable rule");
    const pageUrl = "https://www.publisher.example/story/one";
    expect(applySportsPhotoRule("<html><body>no photo</body></html>", pageUrl, checked.rule)).toBe(
      null
    );
    expect(
      applySportsPhotoRule(
        `<html><head><meta property="og:image" content="  "></head></html>`,
        pageUrl,
        checked.rule
      )
    ).toBe(null);
  });
});
