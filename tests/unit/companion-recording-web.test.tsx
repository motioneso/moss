// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss"
}));

import { MacCompanion } from "../../apps/web/src/settings/settings-profile-subviews.js";

function render(state: string, pending = false) {
  const client = new QueryClient();
  client.setQueryData(["companion", "recording-capabilities"], {
    devices: [
      {
        deviceId: "synthetic-device",
        deviceName: "Fixture Mac",
        state,
        ...(pending
          ? {
              pending: {
                attemptId: "synthetic-attempt",
                policyVersion: 1,
                expiresAt: "2030-01-01T00:00:00Z"
              }
            }
          : {})
      }
    ]
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(MacCompanion))
  );
}

describe("single linking approval in Settings", () => {
  it.each(["approved", "unapproved", "revoked"])(
    "does not mount a recording-capability card for %s authority",
    (state) => {
      const html = render(state, true);
      expect(html).toContain("Approve the connection once in this browser");
      expect(html).toContain("Active sessions");
      expect(html).not.toContain("Fixture Mac");
      expect(html).not.toContain("Enable meeting recording");
      expect(html).not.toContain("Recording access needs an update");
      expect(html).not.toContain("transcription service");
      expect(html).not.toContain("<button");
    }
  );
  it("has no recording access UI when no request is pending", () => {
    const html = render("unapproved");
    expect(html).not.toContain("Fixture Mac");
    expect(html).not.toContain("one-time recording");
    expect(html).not.toContain("Couldn’t check recording access");
  });
});
