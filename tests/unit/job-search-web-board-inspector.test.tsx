// Task 20 (#1304, inspector half): what BoardScreen renders once a row is opened — the detail
// fetch (job-search.match.get), the reasons it renders, the row actions, and the row/keyline
// layout assertions. Split from job-search-web-board.test.tsx when that file crossed the
// 1000-line gate; the list-surface tests stayed there. Shared fixtures and DOM helpers are in
// ./helpers/job-search-board-harness.
//
// api.ts is mocked so every assertion is against the transport call itself, never a real fetch.
import "./helpers/install-module-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../external-modules/job-search/src/web/api", () => ({
  invokeTool: vi.fn(),
  runQueue: vi.fn()
}));

import { act } from "react-test-renderer";
import * as api from "../../external-modules/job-search/src/web/api";
import type { MatchDetail } from "../../external-modules/job-search/src/web/board-types";

import {
  match,
  matchDetail,
  cause,
  portal,
  fixtures,
  setupBoardHarness,
  renderBoard,
  fakeAssistantSurface,
  flush,
  flatten,
  text,
  findButton,
  findByRole,
  rowTitles,
  findRowButton,
  findByClass,
  scrollToSpy,
  focusSpy,
  documentGetElementByIdSpy
} from "./helpers/job-search-board-harness";

setupBoardHarness();

describe("job-search web BoardScreen — inspector", () => {
  // #1330: the inspector's "Open posting" link uses BoardMatch's own url field, so it must not
  // wait on the job-search.match.get round trip the reasons below depend on.
  it("renders the 'Open posting' link from the row's own url, before the detail fetch resolves", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", url: "https://jobs.example.com/role-a" })
    ];
    // Never resolves — proves the link is present before, not because of, this response landing.
    fixtures.matchGetResult = undefined;
    vi.mocked(api.invokeTool).mockImplementation(async (name: string) => {
      if (name === "job-search.matches.list") return { items: fixtures.matchesItems };
      if (name === "job-search.portal.list") return { portals: [] };
      if (name === "job-search.match.get") return new Promise(() => undefined);
      throw new Error(`unexpected invokeTool ${name}`);
    });
    const renderer = await renderBoard();
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });

    const link = renderer.root.findAllByType("a").find((item) => item.props.href);
    expect(link).toBeTruthy();
    expect(link!.props.href).toBe("https://jobs.example.com/role-a");
  });

  it("fetches job-search.match.get with the selected matchId and renders its fitReason/wantReason once resolved", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A", fit: 80, want: 20 })];
    fixtures.matchGetResult = {
      match: matchDetail({
        id: "m1",
        fitReason: "Matches your stated skills.",
        wantReason: "Aligns with your stated priorities."
      })
    };
    const renderer = await renderBoard();
    await flush(renderer);

    // Deliberately not asserting the "Loading the reason…" text here: this test harness's
    // act(async () => {...}) drains the mock's already-resolved promise within the same act
    // call, so the loading frame isn't independently observable — the loading branch itself is
    // simple JSX with nothing left to verify beyond what TypeScript already checks.
    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    expect(api.invokeTool).toHaveBeenCalledWith("job-search.match.get", { matchId: "m1" });
    expect(text(renderer)).toContain("Matches your stated skills.");
    expect(text(renderer)).toContain("Aligns with your stated priorities.");
    expect(findByRole(renderer, "alert")).toHaveLength(0);
  });

  it("renders the captured job description, explicit axes, score scale, scored time, and an h2 title", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A", want: 74 })];
    fixtures.matchGetResult = {
      match: matchDetail({
        id: "m1",
        body: "Own the reliability roadmap and mentor the platform team.",
        want: 74,
        scoredAt: "2026-07-29T18:05:00.000Z"
      })
    };
    const renderer = await renderBoard();
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    const rendered = text(renderer);
    expect(rendered).toContain("Job description");
    expect(rendered).toContain("Own the reliability roadmap and mentor the platform team.");
    expect(rendered).toContain("74/100");
    expect(rendered).toContain("Scored Jul 29 at 18:05 UTC");
    expect(rendered).toMatch(/Fit measures.*Want measures.*independently/i);
    expect(rendered).not.toMatch(/doesn.t store the full posting text|open the original posting/i);
    expect(renderer.root.findAllByType("h1")).toHaveLength(0);
    expect(renderer.root.findAllByType("h2").map((heading) => flatten(heading.children))).toEqual([
      "Role A"
    ]);
  });

  it("uses the plain unavailable fallback only when the description body is empty", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A" })];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1", body: "" }) };
    const renderer = await renderBoard();
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    expect(text(renderer)).toContain("Job description unavailable");
    expect(text(renderer)).not.toMatch(/doesn.t store the full posting text|open the original/i);
  });

  it("shows a plain error message, not a crash, when job-search.match.get fails", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A" })];
    fixtures.matchGetShouldReject = true;
    const renderer = await renderBoard();
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    // board.tsx's catch surfaces the real Error's own message (same pattern as fetchMatches's
    // catch above) rather than papering over it with the generic fallback, which only applies
    // to a non-Error throw or a match.get response that resolves to { match: null }.
    expect(findByRole(renderer, "alert").length).toBeGreaterThan(0);
    expect(text(renderer)).toMatch(/Request failed \(500\)/i);
  });

  it("never shows a stale row's detail after the selection moves to a different row", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", fit: 80, want: 20 }),
      match({ id: "m2", title: "Role B", fit: 60, want: 40 })
    ];
    let resolveFirst!: (value: { match: MatchDetail | null }) => void;
    let callCount = 0;
    vi.mocked(api.invokeTool).mockImplementation(async (name: string, params?: unknown) => {
      if (name === "job-search.matches.list") return { items: fixtures.matchesItems };
      if (name === "job-search.portal.list") return { portals: [] };
      if (name === "job-search.match.get") {
        callCount += 1;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return { match: matchDetail({ id: (params as { matchId: string }).matchId }) };
      }
      throw new Error(`unexpected invokeTool ${name}`);
    });
    const renderer = await renderBoard();
    await flush(renderer);

    // Open Role A — its match.get call is left pending on purpose.
    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    // Mockup rewrite (task #99): list and detail are a full view swap now, never shown together
    // (board.tsx: `selectedMatch ? <Inspector/> : <list/>`), so switching to a different row's
    // detail means going back to the list first — Role B's row isn't in the tree at all while
    // Role A's detail is showing. Role A's in-flight fetch keeps running in the background; going
    // back doesn't cancel it, which is exactly the race this test means to exercise.
    await act(async () => {
      findButton(renderer, /Back to matches/)!.props.onClick();
    });
    await flush(renderer);
    // Switch to Role B before Role A's fetch resolves, then let Role B's own fetch land.
    await act(async () => {
      findRowButton(renderer, /Role B/)!.props.onClick();
    });
    await flush(renderer);

    // Now the stale Role A response arrives — it must not overwrite Role B's already-ready state.
    await act(async () => {
      resolveFirst({ match: matchDetail({ id: "m1", fitReason: "Stale reason for Role A." }) });
    });
    await flush(renderer);

    expect(text(renderer)).not.toContain("Stale reason for Role A.");
  });

  it("Back restores the opened row's scroll position and keyboard focus", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A" })];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1" }) };
    const renderer = await renderBoard();
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);
    await act(async () => {
      findButton(renderer, /Back to matches/)!.props.onClick();
    });

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 480 });
    expect(documentGetElementByIdSpy).toHaveBeenCalledWith("job-search-match-m1");
    expect(focusSpy).toHaveBeenCalledOnce();
  });

  // Task 20/#1304: the plan's three-actions requirement — Discuss, Open posting, and Dismiss must
  // all be reachable from one opened row, not just individually wired. Discuss needs the full
  // MatchDetail (fitReason/wantReason) the same way the fit/want reasons do, so this only asserts
  // once fixtures.matchGetResult has resolved, matching how the other two already behave once a row opens.
  it("renders Discuss, Open posting, and Pass together once a row's detail has loaded", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", url: "https://jobs.example.com/role-a" })
    ];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1" }) };
    const renderer = await renderBoard("p1", fakeAssistantSurface());
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    const discussButton = renderer.root.findAllByType("button").find((item) => {
      const children = Array.isArray(item.props.children)
        ? item.props.children
        : [item.props.children];
      return children.some((child: unknown) => child === "Discuss");
    });
    // Mockup rewrite (task #100): the decision block's own dismiss button reads "Pass" now, not
    // "Dismiss" — the onDismiss prop it calls didn't rename, only its label (inspector.tsx).
    const passButton = renderer.root.findAllByType("button").find((item) => {
      const children = Array.isArray(item.props.children)
        ? item.props.children
        : [item.props.children];
      return children.some((child: unknown) => child === "Pass");
    });
    const openPostingLink = renderer.root.findAllByType("a").find((item) => item.props.href);

    expect(discussButton).toBeTruthy();
    expect(passButton).toBeTruthy();
    expect(openPostingLink).toBeTruthy();
  });

  // #3228 JS-05: an unscored row is synthetic (no match row to update), so Save/Pass would queue
  // a write that changes nothing.
  it("hides Save and Pass for an unscored role", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", state: "unscored", fit: null, want: null })
    ];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1", state: "unscored" }) };
    const renderer = await renderBoard("p1", fakeAssistantSurface());
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    const labels = renderer.root
      .findAllByType("button")
      .map((item) => flatten(item.children).trim());
    expect(labels).toContain("Discuss");
    expect(labels).not.toContain("Pass");
    expect(labels).not.toContain("Save");
  });

  // Without assistantSurface, Discuss must not render at all (a hidden control, not a disabled
  // one — discuss.tsx's own "an action that silently does nothing is worse than an action that is
  // not there") while Open posting and Pass are unaffected, since neither depends on it.
  it("hides Discuss (but not Open posting or Pass) when no assistantSurface is provided", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", url: "https://jobs.example.com/role-a" })
    ];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1" }) };
    const renderer = await renderBoard("p1");
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    const discussButton = renderer.root.findAllByType("button").find((item) => {
      const children = Array.isArray(item.props.children)
        ? item.props.children
        : [item.props.children];
      return children.some((child: unknown) => child === "Discuss");
    });
    const passButton = renderer.root.findAllByType("button").find((item) => {
      const children = Array.isArray(item.props.children)
        ? item.props.children
        : [item.props.children];
      return children.some((child: unknown) => child === "Pass");
    });
    const openPostingLink = renderer.root.findAllByType("a").find((item) => item.props.href);

    expect(discussButton).toBeFalsy();
    expect(passButton).toBeTruthy();
    expect(openPostingLink).toBeTruthy();
  });

  // #1330 built the link; Task 20/#1304's own board-screen gap named this assertion explicitly —
  // a real external `<a>`, not an onClick-driven button, so the browser's own noopener/noreferrer
  // guarantees apply rather than anything this module would have to reimplement.
  it("'Open posting' is a real link with rel=\"noopener noreferrer\", not an onClick button", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", url: "https://jobs.example.com/role-a" })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    const link = renderer.root.findAllByType("a").find((item) => item.props.href);
    expect(link).toBeTruthy();
    expect(link!.props.href).toBe("https://jobs.example.com/role-a");
    expect(link!.props.target).toBe("_blank");
    expect(link!.props.rel).toBe("noopener noreferrer");
    expect(link!.props.onClick).toBeUndefined();
  });

  it("a scored row and its detail keep Fit and Want labelled and separate", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A", fit: 80, want: 70 })];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1", fit: 80, want: 70 }) };
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toMatch(/Fit 80/);
    expect(text(renderer)).toMatch(/Want 70/);
    expect(findByClass(renderer, "jds-score")).toEqual([]);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    expect(text(renderer)).toMatch(/Fit/);
    expect(text(renderer)).toMatch(/Want/);
    expect(findByClass(renderer, "jds-score")).toHaveLength(2);
    expect(text(renderer)).toMatch(/80/);
    expect(text(renderer)).toMatch(/70/);
  });

  // K-D1 superseded (task #98): the old "n-1 dividers for n rows" mechanism — KeyRow's own
  // `divided={i > 0}` sibling-divider bookkeeping — is retired along with KeyRow itself.
  // match-row.tsx draws its own top hairline on EVERY row unconditionally, via the CSS class
  // `jds-hairline-row` (a border, not a DOM sibling — board.tsx's own comment: "No divided/i > 0
  // bookkeeping any more... the trailing divider below closes the list off at the bottom"), and
  // the list closes with exactly one trailing bare `jds-divider` regardless of row count. There is
  // no per-row-count arithmetic left to get wrong, so this replaces the old count-based assertion
  // with the two things that are still real: every row carries the hairline hook, and the list
  // closes with exactly one bare divider, never zero and never one per row.
  it("draws every row's own hairline via CSS and closes the list with exactly one trailing divider", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A" }),
      match({ id: "m2", title: "Role B" }),
      match({ id: "m3", title: "Role C" })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    const rows = findByClass(renderer, "jsm-row");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(String((row.props as { className?: string }).className).split(" ")).toContain(
        "jds-hairline-row"
      );
    }

    // Filtered to the bare, single-class "jds-divider" the list's own trailing <hr> renders —
    // board.tsx's hero rule (`jds-divider jds-divider--strong jsm-hero__rule`) also carries the
    // class and would otherwise inflate this count by one regardless of row count.
    const bareDividers = renderer.root.findAll(
      (item) => (item.props as { className?: string }).className === "jds-divider"
    );
    expect(bareDividers).toHaveLength(1);
  });

  it("bucket tabs count each state correctly and filter the visible rows on click", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "New Role", state: "new" }),
      match({ id: "m2", title: "Unscored Role", state: "unscored", fit: null, want: null }),
      match({ id: "m3", title: "Saved Role", state: "seen" }),
      match({ id: "m4", title: "Passed Role", state: "dismissed" })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    // "Unreviewed" absorbs both `new` and `unscored` through the shared matchBucket helper — two rows there, one
    // each in Saved and Passed.
    const counts = findByClass(renderer, "jds-tab__count").map((item) => item.props.children);
    expect(counts).toEqual([2, 1, 1]);

    // The board opens on Unreviewed — Saved and Passed rows are not part of the initial render.
    expect(rowTitles(renderer)).toEqual(["New Role", "Unscored Role"]);
    const unreviewed = findButton(renderer, /^Unreviewed/);
    expect(unreviewed!.props["aria-current"]).toBe("page");
    expect(renderer.root.findAllByProps({ role: "tablist" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ role: "tab" })).toHaveLength(0);

    const savedTab = findButton(renderer, /^Saved/);
    await act(async () => {
      savedTab!.props.onClick();
    });
    expect(rowTitles(renderer)).toEqual(["Saved Role"]);
    expect(savedTab!.props["aria-current"]).toBe("page");
    expect(unreviewed!.props["aria-current"]).toBeUndefined();

    const passedTab = findButton(renderer, /^Passed/);
    await act(async () => {
      passedTab!.props.onClick();
    });
    expect(rowTitles(renderer)).toEqual(["Passed Role"]);
  });

  it("never renders any element carrying a jsm-card* class anywhere in the tree", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", outsideFrame: true }),
      match({ id: "m2", title: "Role B", state: "unscored", fit: null, want: null })
    ];
    fixtures.portalsItems = [portal({ cause: cause() })];
    const renderer = await renderBoard();
    await flush(renderer);

    // The whole point of K2: `.jsm-card`/`.jsm-card__head`/`.jsm-card__axes`/`.jsm-card__axis`/
    // `.jsm-card__value`/`.jsm-card__foot`/`.jsm-card__pending`/`.jsm-card--outside` are all gone,
    // from styles.css and from every render path — a class-prefix scan is the one assertion that
    // covers all eight without naming each individually (and would also catch a future regression
    // reintroducing any of them under the same family).
    const cardClasses = renderer.root
      .findAll((item) => {
        const className = (item.props as { className?: string }).className;
        return typeof className === "string" && /(^|\s)jsm-card/.test(className);
      })
      .map((item) => (item.props as { className?: string }).className);
    expect(cardClasses).toEqual([]);
  });

  // Already-approved ruling (commit 3914bd36, applied consistently in both match-row.tsx and
  // inspector.tsx): the outside-frame flag is plain gold-toned text — `jds-eyebrow
  // jds-eyebrow--gold` — never a badge/chip. This test's old target class (`jds-badge--outline`)
  // was superseded before this remediation started; porting it forward is a stale-test fix, not a
  // new design decision.
  it("renders the outside-frame flag as plain gold text in the meta line, not by dimming the whole row", async () => {
    fixtures.matchesItems = [
      match({
        id: "m1",
        title: "Frame Breaker",
        outsideFrame: true,
        source: "LinkedIn",
        location: "Remote — US",
        postedAt: "2026-07-15T09:00:00.000Z"
      })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    // `.jsm-card--outside` (opacity dimming) is deleted — the outside-frame signal sits inline in
    // the row's own meta line beside the existing source/location/posted-date text, none of which
    // regressed when the card wrapper was removed.
    const goldFlag = findByClass(renderer, "jds-eyebrow--gold");
    expect(goldFlag).toHaveLength(1);
    expect(flatten(goldFlag[0]!.props.children)).toMatch(/Outside your stated frame/);

    expect(text(renderer)).toContain("LinkedIn");
    expect(text(renderer)).toContain("Remote — US");
    expect(text(renderer)).toMatch(/Posted Jul 15/);
  });
});
