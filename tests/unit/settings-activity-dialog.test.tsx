import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActivityDialog,
  type ActivityDialogStep
} from "../../apps/web/src/settings/settings-activity-dialog.js";

function step(overrides: Partial<ActivityDialogStep> = {}): ActivityDialogStep {
  return {
    key: "s1",
    kindLabel: "model call",
    title: "Wrote the answer",
    result: "Replied.",
    meta: null,
    failed: false,
    failureCode: null,
    facts: [["Started", "09:41:09"]],
    askedFor: null,
    returned: null,
    ...overrides
  };
}

function htmlFor(current: ActivityDialogStep): string {
  return renderToString(
    createElement(ActivityDialog, {
      data: {
        title: "Answered a chat message",
        statusText: "Done",
        statusTone: "forest",
        badges: [],
        meta: "Today 09:41",
        quote: null,
        steps: [current],
        expiresAt: null
      },
      locale: { timezone: "UTC", region: "en-US", dateFormat: "24" },
      onClose: () => undefined
    })
  );
}

describe("ActivityDialog asked-for and returned rows (#2956 slice D)", () => {
  it("hides both rows when the step recorded nothing for them", () => {
    const html = htmlFor(step({ askedFor: null, returned: null }));

    expect(html).not.toContain("Asked for");
    expect(html).not.toContain("Returned");
    expect(html).not.toContain("Not recorded");
    expect(html).toContain("Started");
  });

  it("shows each row once its step recorded a value", () => {
    const html = htmlFor(step({ askedFor: "The afternoon forecast", returned: "Nothing" }));

    expect(html).toContain("Asked for");
    expect(html).toContain("The afternoon forecast");
    expect(html).toContain("Returned");
    expect(html).toContain("Nothing");
  });
});
