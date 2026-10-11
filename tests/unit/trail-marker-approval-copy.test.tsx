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
import { ApiError } from "../../apps/web/src/api/client.js";
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

function renderRequest(path: string, client = new QueryClient()): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [path] }, createElement(LinkTrailMarkerPage))
    )
  );
}

function renderReadError(status: number): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } }
  });
  client
    .getQueryCache()
    .build(client, { queryKey: queryKeys.companionPairAttempt("abc") })
    .setState({
      status: "error",
      error: new ApiError(status, "Fixture error"),
      fetchStatus: "idle"
    });
  return renderRequest("/link/trail-marker#code=abc", client);
}

describe("Trail Marker request status", () => {
  it.each(["pending", "approved"])("keeps a long device name wrappable when %s", (status) => {
    const client = new QueryClient();
    const deviceName = `Example-${"LongDeviceName".repeat(4)}`;
    client.setQueryData(queryKeys.companionPairAttempt("abc"), { deviceName, status });
    const host = document.createElement("div");
    host.innerHTML = renderRequest("/link/trail-marker#code=abc", client);
    const card = host.querySelector<HTMLElement>(".jds-card")!;
    expect(card.style.minWidth).toBe("0px");
    expect(card.style.overflowWrap).toBe("anywhere");
    const name = card.querySelector("strong")!;
    expect(name.textContent).toBe(deviceName);
    if (status === "pending") expect(name.parentElement!.style.minWidth).toBe("0px");
    client.clear();
  });

  it("announces a missing request code and offers no approval", () => {
    const html = renderRequest("/link/trail-marker");
    expect(html).toContain('role="alert"');
    expect(html).toContain("missing its request code");
    expect(html).not.toContain(">Approve</button>");
    expect(html).not.toContain("Checking the request");
  });

  it("announces the initial request check", () => {
    const html = renderRequest("/link/trail-marker#code=abc");
    expect(html).toContain('role="status"');
    expect(html).toContain("Checking the request");
  });

  it("does not describe a transport failure as an expired request", () => {
    const html = renderReadError(503);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t check this request");
    expect(html).toContain("Check request again");
    expect(html).not.toContain("no longer open");
  });

  it("explains an invalid request without offering a transport retry", () => {
    const html = renderReadError(400);
    expect(html).toContain("This request link couldn&#x27;t be used");
    expect(html).not.toContain("Check request again");
  });

  it("explains a closed request without suggesting an ineffective retry", () => {
    const html = renderReadError(404);
    expect(html).toContain("That request is no longer open");
    expect(html).toContain("Start a new one from the Mac");
    expect(html).not.toContain("Check request again");
  });

  it.each([401, 403])("distinguishes account verification failure %s", (status) => {
    const html = renderReadError(status);
    expect(html).toContain("account access couldn&#x27;t be verified");
    expect(html).not.toContain("no longer open");
    expect(html).not.toContain(">Approve</button>");
  });

  it("keeps the device context for an already answered request", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.companionPairAttempt("abc"), {
      deviceName: "Example Mac",
      status: "approved"
    });
    const html = renderRequest("/link/trail-marker#code=abc", client);
    expect(html).toContain('role="status"');
    expect(html).toContain("Example Mac");
    expect(html).toContain("was already answered");
    expect(html).not.toContain(">Approve</button>");
  });
});

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
