import { describe, expect, it } from "vitest";
import { outlookCalendarBinding } from "../../packages/connectors/src/outlook-calendar-config.js";
import { validateOutlookBrowserEndpoint } from "../../packages/connectors/src/outlook-calendar-browser.js";

describe("Outlook operator binding", () => {
  it("is off by default and requires one complete binding", () => {
    expect(outlookCalendarBinding({})).toBeNull();
    expect(() =>
      outlookCalendarBinding({ MOSS_OUTLOOK_BROWSER_ENDPOINT: "http://127.0.0.1:5188" })
    ).toThrow();
    expect(
      outlookCalendarBinding({
        MOSS_OUTLOOK_BROWSER_ENDPOINT: "http://127.0.0.1:5188",
        MOSS_OUTLOOK_BROWSER_OWNER: "00000000-0000-4000-8000-000000000001",
        MOSS_OUTLOOK_BROWSER_ACCOUNT: "invented@example.invalid"
      })
    ).toMatchObject({ endpoint: "http://127.0.0.1:5188" });
  });
  it.each([
    "http://localhost:5188",
    "https://127.0.0.1:5188",
    "http://example.invalid:5188",
    "http://127.0.0.1",
    "http://user:pass@127.0.0.1:5188",
    "http://127.0.0.1:5188/path",
    "http://127.0.0.1:5188/?endpoint=remote",
    "http://127.0.0.1:5188/#remote",
    "file:///tmp/browser"
  ])("refuses nonbinding endpoints without exposing the supplied value", (endpoint) => {
    expect(() => validateOutlookBrowserEndpoint(endpoint)).toThrow(/^source-changed$/);
  });
});
