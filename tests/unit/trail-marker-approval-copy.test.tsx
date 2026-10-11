// @vitest-environment jsdom
// Task 7 of the focus plan: the approval page must list what a newly linked Mac may do, must not
// keep the old "cannot read your data" sentence (it stopped being true once a Mac reads the
// current focus block), and Settings must say how to connect. Rendered to static markup, the same
// way a first paint would show it, with the pair-attempt query pre-filled so no request is made.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../apps/web/src/api/use-assistant-name.js", () => ({
  useAssistantName: () => "Moss"
}));

import {
  APPROVAL_CAPABILITIES,
  LinkTrailMarkerPage
} from "../../apps/web/src/companion/link-trail-marker-page.js";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import { MacCompanion } from "../../apps/web/src/settings/settings-profile-subviews.js";

function renderApproval(recordingPolicyVersion?: 1): string {
  const client = new QueryClient();
  client.setQueryData(queryKeys.companionPairAttempt("abc"), {
    deviceName: "Ben's MacBook",
    status: "pending",
    recordingPolicyVersion
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/link/trail-marker#code=abc"] },
        createElement(LinkTrailMarkerPage)
      )
    )
  );
}

describe("Trail Marker approval page copy", () => {
  it("lists the four things a linked Mac may do", () => {
    const html = renderApproval();
    expect(APPROVAL_CAPABILITIES).toHaveLength(4);
    for (const capability of APPROVAL_CAPABILITIES) expect(html).toContain(capability);
    expect(html).toContain("focus block you have on right now");
    expect(html).toContain("which app is in front");
  });

  it("no longer says a linked Mac cannot read your data", () => {
    const html = renderApproval();
    expect(html).not.toContain("cannot read your data");
    expect(html).toContain("never gets your password or your browser session");
  });
});

it("includes recording in supported pairing and keeps legacy pairing unapproved", () => {
  const html = renderApproval(1);
  expect(html).toContain("<li>Record meetings when you choose Start</li>");
  expect(html.match(/<li>/g)).toHaveLength(5);
  expect(html.match(/>Approve<\/button>/g)).toHaveLength(1);
  expect(html).not.toContain("Connecting never starts recording");
  expect(html).not.toContain("Enable meeting recording");
  expect(html).not.toContain("configured transcription service");
  expect(renderApproval()).not.toContain("Record meetings when you choose Start");
});

describe("Trail Marker Settings group", () => {
  it("says how to connect without showing a Moss address or another approval", () => {
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MacCompanion))
    );
    expect(html).toContain("How to connect");
    expect(html).not.toContain(window.location.origin);
    expect(html).not.toContain("enter ");
    expect(html).not.toContain("Enable meeting recording");
    expect(html).not.toContain("Recording access needs an update");
    expect(html).not.toContain("one-time recording");
    expect(html).toContain("Connect in Browser");
    expect(html).toContain("nothing to download yet");
  });

  it("describes the focus access a linked Mac gets, not just check-in", () => {
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MacCompanion))
    );
    expect(html).toContain("which focus block you have on");
  });
});
