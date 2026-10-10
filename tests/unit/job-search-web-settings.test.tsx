// Task 20 (#1304, settings half): SettingsScreen in isolation, plain node environment (no jsdom
// needed — same reasoning as job-search-web-onboarding.test.tsx's header). api.ts is mocked so
// this file exercises only the screen's own logic: portal.list rendering, the forced read/write
// transport split (reads via invokeTool, writes via runQueue — rulings I3/I4), the verbatim
// self-disabled-cause rendering, and the absence of any combined-score or scoring-weight control.
//
// K4 (2026-07-28 keyline-restructure plan) moved the briefing-detail control (and its own test)
// to job-search-profile.test.tsx along with the rest of the résumé/briefing-detail half of this
// screen — this file no longer renders that control, so it no longer asserts against it.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../external-modules/job-search/src/web/api", () => ({
  invokeTool: vi.fn(),
  runQueue: vi.fn()
}));

import {
  PORTAL_LIST_TOOL,
  PORTAL_SET_ENABLED_QUEUE,
  SettingsScreen
} from "../../external-modules/job-search/src/web/screens/settings";
import * as api from "../../external-modules/job-search/src/web/api";
import type { Profile } from "../../external-modules/job-search/src/web/use-profiles";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    profileId: "p1",
    name: "Acme SWE search",
    state: "active",
    briefingDetail: null,
    completedSteps: ["role", "want", "where", "comp", "sources"],
    readyToCrawl: true,
    surfaceKey: "surf-1",
    ...overrides
  };
}

interface PortalRowFixture {
  sourceId: string;
  label: string;
  enabled: boolean;
  lastOkAt: string | null;
  cause: { summary: string; nextAction: string; disabled: boolean } | null;
}

function portalRow(overrides: Partial<PortalRowFixture> = {}): PortalRowFixture {
  return {
    sourceId: "linkedin",
    label: "LinkedIn",
    enabled: true,
    lastOkAt: null,
    cause: null,
    ...overrides
  };
}

async function renderScreen(profileValue: Profile): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(SettingsScreen, { profile: profileValue }));
  });
  return renderer;
}

// Flushes the microtask queue a few times over — enough for a mocked invokeTool/runQueue's
// resolved promise to reach its .then(setState) (same pattern as job-search-web-root.test.tsx's
// flush helper).
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function flatten(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (typeof node === "object" && "children" in (node as { children?: unknown })) {
    return flatten((node as { children?: unknown }).children);
  }
  return "";
}

function text(renderer: ReactTestRenderer): string {
  return flatten(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

describe("SettingsScreen", () => {
  beforeEach(() => {
    vi.mocked(api.invokeTool).mockReset();
    vi.mocked(api.runQueue).mockReset();
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "queued" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads portals via invokeTool (read) and toggling one calls portal.set-enabled via runQueue (write)", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn", enabled: true })]
    });

    const renderer = await renderScreen(profile());
    await flush();

    expect(api.invokeTool).toHaveBeenCalledWith(PORTAL_LIST_TOOL, { profileId: "p1" });
    expect(text(renderer)).toMatch(/LinkedIn/);

    const checkbox = renderer.root.findByProps({ type: "checkbox" });
    await act(async () => {
      checkbox.props.onChange({ target: { checked: false } });
    });
    await flush();

    expect(api.runQueue).toHaveBeenCalledWith(PORTAL_SET_ENABLED_QUEUE, "portal.set-enabled", {
      profileId: "p1",
      sourceId: "linkedin",
      enabled: false
    });
    // invokeTool must never be used for the write itself — only for the list read.
    expect(api.invokeTool).not.toHaveBeenCalledWith(
      "job-search.portal.set-enabled",
      expect.anything()
    );
  });

  // #3228 JS-10: runQueue resolves when the job is accepted, before it runs, so the first reread
  // can still show the old value. The switch must hold its new position until a reread agrees.
  it("keeps the switch flipped while the queued change has not landed, then settles on the stored value", async () => {
    vi.useFakeTimers();
    try {
      let stored = true;
      vi.mocked(api.invokeTool).mockImplementation(async () => ({
        portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn", enabled: stored })]
      }));
      const renderer = await renderScreen(profile());
      await flush();

      await act(async () => {
        renderer.root
          .findByProps({ type: "checkbox" })
          .props.onChange({ target: { checked: false } });
      });
      await flush();
      expect(renderer.root.findByProps({ type: "checkbox" }).props.checked).toBe(false);

      stored = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      await flush();
      expect(renderer.root.findByProps({ type: "checkbox" }).props.checked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the user when the change was not accepted and shows the stored value", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn", enabled: true })]
    });
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "error", message: "Request failed (500)" });
    const renderer = await renderScreen(profile());
    await flush();

    await act(async () => {
      renderer.root
        .findByProps({ type: "checkbox" })
        .props.onChange({ target: { checked: false } });
    });
    await flush();

    expect(renderer.root.findByProps({ type: "checkbox" }).props.checked).toBe(true);
    expect(text(renderer)).toMatch(/couldn.t change|could not change/i);
  });

  it("labels monitoring and manual-run controls separately", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn", enabled: true })]
    });

    const renderer = await renderScreen(profile());
    await flush();

    expect(text(renderer)).toContain("LinkedIn monitoring");
    const checkbox = renderer.root.findByProps({
      type: "checkbox",
      "aria-label": "Enable LinkedIn monitoring"
    });
    expect(checkbox).toBeDefined();

    const runGroup = renderer.root.findByProps({
      role: "group",
      "aria-label": "LinkedIn manual check"
    });
    expect(runGroup.findAllByType("button")).toHaveLength(1);
    expect(runGroup.findAllByProps({ type: "checkbox" })).toHaveLength(0);
  });

  it("leads with watched-board controls without a ceremonial page hero", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn" })]
    });

    const renderer = await renderScreen(profile());
    await flush();

    const rendered = text(renderer);
    expect(rendered).not.toMatch(/every morning/i);
    expect(rendered).not.toContain("Where this search is looking");
    expect(renderer.root.findAllByProps({ className: "jds-strap jds-strap--gold" })).toHaveLength(
      0
    );
  });

  it("renders a self-disabled portal's cause verbatim, not a composed sentence", async () => {
    const summary =
      "LinkedIn asked for an account before showing postings, so I stopped. I will not sign in to a job board on your behalf.";
    const nextAction = "Disabled. Turn it back on if you want to try again.";
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [
        portalRow({
          sourceId: "linkedin",
          label: "LinkedIn",
          enabled: false,
          cause: { summary, nextAction, disabled: true }
        })
      ]
    });

    const renderer = await renderScreen(profile());
    await flush();

    const rendered = text(renderer);
    expect(rendered).toContain(summary);
    expect(rendered).toContain(nextAction);
  });

  it("renders no combined score and no scoring/weighting control", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({ portals: [] });

    const renderer = await renderScreen(profile());
    await flush();

    expect(text(renderer)).not.toMatch(/\boverall\b|\bcombined\b/i);
    expect(renderer.root.findAllByProps({ type: "range" })).toHaveLength(0);
    expect(text(renderer)).not.toMatch(/\bweight(ing)?\b/i);
  });

  // K7 (2026-07-28 keyline-restructure plan, Monitors redesign): the row's one real fact.
  it("renders Last success from lastOkAt, and omits the fact entirely when there's no successful run yet", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [
        portalRow({
          sourceId: "linkedin",
          label: "LinkedIn",
          lastOkAt: "2026-07-15T09:00:00.000Z"
        }),
        portalRow({ sourceId: "freehire", label: "freehire.me", lastOkAt: null })
      ]
    });

    const renderer = await renderScreen(profile());
    await flush();

    const rendered = text(renderer);
    expect(rendered).toMatch(/Last success.*Jul 15/);
    // The second row never ran successfully — no fabricated date, no dash placeholder, just an
    // absent fact (formatPostedOn's own header: an absent fact reads as "this board doesn't know").
    const freehireIndex = rendered.indexOf("freehire.me");
    expect(freehireIndex).toBeGreaterThanOrEqual(0);
  });

  // K7: the mockup's four-column fact grid (Schedule/Last checked/Last success/Found today)
  // reduces to one real field — none of the other three exist on job-search.portal.list's wire
  // shape, so they must never appear anywhere on this screen.
  it("never renders a schedule, last-checked, or found-today figure — none of those fields exist on the wire", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [
        portalRow({ sourceId: "linkedin", label: "LinkedIn", lastOkAt: "2026-07-15T09:00:00.000Z" })
      ]
    });

    const renderer = await renderScreen(profile());
    await flush();

    const rendered = text(renderer);
    expect(rendered).not.toMatch(/\bschedule\b/i);
    expect(rendered).not.toMatch(/last checked/i);
    expect(rendered).not.toMatch(/found today/i);
    expect(rendered).not.toMatch(/7:00\s*AM/i);
  });

  // K7: Run now drives job-search.crawl-run through runQueue (the only reachable path — the tool
  // 403s from the browser), and the button's own settled state is "queued", never "done"
  // (runQueue resolves on acceptance only — ruling I5).
  it('Run now queues job-search.crawl-run for the whole profile and settles on "Run queued"', async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn" })]
    });
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "queued" });

    const renderer = await renderScreen(profile());
    await flush();

    const runButton = renderer.root
      .findAllByProps({ type: "button" })
      .find((node) => flatten(node.props.children) === "Run now");
    expect(runButton).toBeDefined();

    await act(async () => {
      runButton!.props.onClick();
    });
    await flush();

    expect(api.runQueue).toHaveBeenCalledWith("job-search.crawl-run", "crawl.run", {
      profileId: "p1"
    });
    expect(text(renderer)).toMatch(/Run queued/);
  });

  it("Run now shows an inline error and stays clickable when the queue call fails", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn" })]
    });
    vi.mocked(api.runQueue).mockRejectedValue(new Error("boom"));

    const renderer = await renderScreen(profile());
    await flush();

    const runButton = renderer.root
      .findAllByProps({ type: "button" })
      .find((node) => flatten(node.props.children) === "Run now");
    await act(async () => {
      runButton!.props.onClick();
    });
    await flush();

    expect(text(renderer)).toMatch(/Couldn.t start/);
    // Still says "Run now", not stuck on "Queuing…" — an error must return the button to its
    // clickable resting label, not leave the user with no way to retry.
    expect(
      renderer.root
        .findAllByProps({ type: "button" })
        .some((node) => flatten(node.props.children) === "Run now")
    ).toBe(true);
  });

  // K7: the mockup draws "Add a monitor" and "Edit query" as buttons. Neither has a worker queue
  // behind it (source.ts declares them assistantTools-only, risk:"write") — a browser click would
  // 403 with confirmation_required, so this screen must never render either as a working control.
  it("never renders an Add a monitor or Edit query control — no queue exists for either", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({
      portals: [portalRow({ sourceId: "linkedin", label: "LinkedIn" })]
    });

    const renderer = await renderScreen(profile());
    await flush();

    const buttonLabels = renderer.root
      .findAllByProps({ type: "button" })
      .map((node) => flatten(node.props.children));
    expect(buttonLabels).not.toContain("Add a monitor");
    expect(buttonLabels).not.toContain("Edit query");
    expect(text(renderer)).toMatch(/through chat/i);
  });

  // K7: the footer line about keyless public job-board APIs, carried over from the mockup as text
  // (modules can't import Lucide, so no shield glyph).
  it("keeps the footer to the one available add/edit route", async () => {
    vi.mocked(api.invokeTool).mockResolvedValue({ portals: [] });

    const renderer = await renderScreen(profile());
    await flush();

    expect(text(renderer)).toMatch(/Add or edit a job board through chat/i);
  });

  // K7: the trailing "N enabled · all healthy" meta on the section head must be computed from the
  // real rows, and must not claim health when nothing is enabled.
  it("computes the Watched boards meta from real rows, honestly, including the zero-enabled case", async () => {
    vi.mocked(api.invokeTool).mockResolvedValueOnce({
      portals: [
        portalRow({ sourceId: "linkedin", label: "LinkedIn", enabled: true, cause: null }),
        portalRow({ sourceId: "freehire", label: "freehire.me", enabled: false, cause: null })
      ]
    });
    const healthy = await renderScreen(profile());
    await flush();
    expect(text(healthy)).toMatch(/1 enabled.*all healthy/);

    vi.mocked(api.invokeTool).mockResolvedValueOnce({
      portals: [
        portalRow({ sourceId: "linkedin", label: "LinkedIn", enabled: false, cause: null }),
        portalRow({ sourceId: "freehire", label: "freehire.me", enabled: false, cause: null })
      ]
    });
    const none = await renderScreen(profile());
    await flush();
    expect(text(none)).toMatch(/No boards enabled/);
    expect(text(none)).not.toMatch(/all healthy/);
  });
});
