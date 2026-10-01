// @vitest-environment jsdom
// The provider card's update badges (#2689 slice 4): one look per state, Retry only where an
// admin can act.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CliUpdateStatus } from "../../apps/web/src/settings/cli-update-status.js";

const render = (tools: Parameters<typeof CliUpdateStatus>[0]["tools"], retrying = false) =>
  renderToStaticMarkup(
    createElement(CliUpdateStatus, { tools, name: "Claude", onRetry: () => undefined, retrying })
  );

describe("CliUpdateStatus", () => {
  it("shows nothing for a current or missing tool", () => {
    expect(render({ version: "1.0.0", state: "current" })).toBe("");
    expect(render(undefined)).toBe("");
    expect(render({ version: null, state: "not_installed" })).toBe("");
  });

  it("says it is updating while a check runs, with no Retry", () => {
    const html = render({ version: "1.0.0", state: "checking", candidateVersion: "1.1.0" });
    expect(html).toContain("Updating to 1.1.0");
    expect(html).not.toContain("Retry");
  });

  it("says held back with the reason as a tooltip and a Retry button", () => {
    const html = render({
      version: "1.0.0",
      state: "held_back",
      candidateVersion: "1.1.0",
      reason: "couldn't use Moss's tools in a test chat"
    });
    expect(html).toContain("Version 1.1.0 held back");
    expect(html).toContain("couldn&#x27;t use Moss&#x27;s tools in a test chat");
    expect(html).toContain("Retry");
  });

  it("says needs a newer Moss, with no Retry", () => {
    const html = render({ version: "1.0.0", state: "needs_newer_moss", candidateVersion: "1.2.0" });
    expect(html).toContain("Version 1.2.0 needs a newer Moss");
    expect(html).not.toContain("Retry");
  });

  it("says it can't check for updates, with Retry, and shows Checking while retrying", () => {
    const html = render({ version: "1.0.0", state: "cannot_check" });
    expect(html).toContain("Can&#x27;t check for updates");
    expect(html).toContain("Retry");
    expect(render({ version: "1.0.0", state: "cannot_check" }, true)).toContain("Checking");
  });
});
