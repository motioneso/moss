// Task 20 (#1304, board half): BoardScreen's list surface — reading, sorting, the two score
// axes, portal banners, Search now, Pass, and the error/empty states. Runs in the plain node
// environment (no jsdom — a pure render needs no document APIs beyond the harness's window stub).
// api.ts is mocked so every assertion is against the transport call itself, never a real fetch.
// latch.ts is intentionally NOT mocked — the "Search now fires even when latched" test exercises
// the real module to prove board.tsx never imports or checks it.
//
// The inspector half of this screen lives in job-search-web-board-inspector.test.tsx; the two were
// one file until it crossed the 1000-line gate. Shared fixtures and DOM helpers are in
// ./helpers/job-search-board-harness.
import "./helpers/install-module-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../external-modules/job-search/src/web/api", () => ({
  invokeTool: vi.fn(),
  runQueue: vi.fn()
}));

import { act } from "react-test-renderer";
import * as api from "../../external-modules/job-search/src/web/api";
import { setLatched } from "../../external-modules/job-search/src/web/latch";
import {
  EMPTY_BOARD_FILTERS,
  filterBoardMatches,
  matchBucket,
  type BoardMatch
} from "../../external-modules/job-search/src/web/board-types";
import { activeFilterCount } from "../../external-modules/job-search/src/web/screens/board-filters";
// The search poll's tick, so the one test that has to reach a poll-driven board read advances by
// the real interval rather than a copied literal that could drift out of step with the hook.
import { TICK_MS } from "../../external-modules/job-search/src/web/use-search-run";

import {
  match,
  matchDetail,
  cause,
  portal,
  fixtures,
  setupBoardHarness,
  renderBoard,
  flush,
  flatten,
  text,
  findButton,
  findByRole,
  rowTitles,
  findRowButton,
  findByClass,
  fireWindowEvent
} from "./helpers/job-search-board-harness";

setupBoardHarness();

describe("job-search web BoardScreen", () => {
  it("shares bucket membership for scored and unscored matches", () => {
    expect(matchBucket(match({ state: "new" }))).toBe("unreviewed");
    expect(matchBucket(match({ state: "unscored", fit: null, want: null }))).toBe("unreviewed");
    expect(matchBucket(match({ state: "seen" }))).toBe("saved");
    expect(matchBucket(match({ state: "dismissed" }))).toBe("passed");
  });

  it("filters title/company, location, age, Fit, and source together over more than one page", () => {
    const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
    const filler = Array.from({ length: 29 }, (_, index) =>
      match({
        id: `filler-${index}`,
        title: `Filler ${index}`,
        company: "Elsewhere",
        location: "Seattle",
        source: "FreeHire",
        postedAt: "2026-06-01T00:00:00.000Z",
        fit: 20
      })
    );
    const target = match({
      id: "target",
      title: "Staff Platform Engineer",
      company: "Acme Labs",
      location: "Remote — US",
      source: "LinkedIn",
      postedAt: "2026-07-28T12:00:00.000Z",
      fit: 90
    });

    expect(
      filterBoardMatches(
        [...filler, target],
        {
          query: "acme",
          location: "remote",
          posted: "week",
          fit: "strong",
          source: "linkedin"
        },
        nowMs
      ).map((item) => item.id)
    ).toEqual(["target"]);
  });

  it("treats unknown dates and null Fit explicitly, and counts only active filters", () => {
    const nowMs = Date.parse("2026-07-30T12:00:00.000Z");
    const unknownDate = match({ id: "unknown-date", postedAt: null });
    const unscored = match({ id: "unscored", state: "unscored", fit: null, want: null });

    expect(
      filterBoardMatches(
        [unknownDate, unscored],
        { ...EMPTY_BOARD_FILTERS, posted: "month" },
        nowMs
      ).map((item) => item.id)
    ).toEqual(["unscored"]);
    expect(
      filterBoardMatches(
        [unknownDate, unscored],
        { ...EMPTY_BOARD_FILTERS, fit: "unscored" },
        nowMs
      ).map((item) => item.id)
    ).toEqual(["unscored"]);
    expect(
      activeFilterCount({
        ...EMPTY_BOARD_FILTERS,
        query: "engineer",
        source: "linkedin"
      })
    ).toBe(2);
    expect(activeFilterCount(EMPTY_BOARD_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_BOARD_FILTERS, query: "   " })).toBe(0);
  });

  it("states when filters and counts cover only the truncated loaded board", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Loaded Role" })];
    fixtures.matchesTruncated = true;
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toMatch(/filters and counts apply to the first 1,000 loaded roles/i);
    expect(text(renderer)).not.toMatch(/all roles|whole board/i);
  });

  it("drops a row missing url and reports it in invalidCount, without blanking the rest of the board", async () => {
    fixtures.matchesItems = [
      match({ id: "good" }),
      { ...match({ id: "bad" }), url: undefined } as unknown as BoardMatch
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(rowTitles(renderer)).toEqual(["Senior Engineer"]);
    expect(text(renderer)).toMatch(/1 role couldn't be shown/i);
  });

  it("drops a row with an unrecognized state and reports it in invalidCount", async () => {
    fixtures.matchesItems = [
      match({ id: "good" }),
      { ...match({ id: "bad" }), state: "archived" } as unknown as BoardMatch
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(rowTitles(renderer)).toEqual(["Senior Engineer"]);
    expect(text(renderer)).toMatch(/1 role couldn't be shown/i);
  });

  it("shows no dropped-row notice when every row is well-formed", async () => {
    fixtures.matchesItems = [match({ id: "m1" }), match({ id: "m2", title: "Other Role" })];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(rowTitles(renderer)).toEqual(["Senior Engineer", "Other Role"]);
    expect(text(renderer)).not.toMatch(/couldn't be shown/i);
  });

  it("reads matches via job-search.matches.list with explicit profileId and limit", async () => {
    fixtures.matchesItems = [match()];
    const renderer = await renderBoard("p1");
    await flush(renderer);

    // `offset: 0` is not incidental: the board reads every page (web/read-board.ts) rather than
    // rendering the tool's first page and calling that the board, which is what left a profile with
    // 167 matches showing 25 rows and every search afterwards looking like it did nothing.
    expect(api.invokeTool).toHaveBeenCalledWith("job-search.matches.list", {
      profileId: "p1",
      limit: 25,
      offset: 0
    });
    void renderer;
  });

  it("sorts Fit and Want independently — sorting one never reorders the other", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", fit: 90, want: 10 }),
      match({ id: "m2", title: "Role B", fit: 50, want: 95 }),
      match({ id: "m3", title: "Role C", fit: 70, want: 50 })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    // The board opens sorted by Fit descending — an unsorted board leads with whatever the store
    // returned, which reads as a broken matcher rather than an unsorted table.
    expect(rowTitles(renderer)).toEqual(["Role A", "Role C", "Role B"]);

    // So the first click on Fit flips it, rather than re-applying the order already on screen and
    // appearing to do nothing.
    const fitHeader = findButton(renderer, /^Fit/);
    await act(async () => {
      fitHeader!.props.onClick();
    });
    expect(rowTitles(renderer)).toEqual(["Role B", "Role C", "Role A"]);

    // Want sorts on its own axis and does not inherit Fit's direction (L9: the two are never
    // blended). A fresh column starts descending, highest want first.
    const wantHeader = findButton(renderer, /^Want/);
    await act(async () => {
      wantHeader!.props.onClick();
    });
    expect(rowTitles(renderer)).toEqual(["Role B", "Role C", "Role A"]);

    // And back to Fit descending, proving the two axes are independent rather than one ordering
    // shared between two labels.
    await act(async () => {
      fitHeader!.props.onClick();
    });
    expect(rowTitles(renderer)).toEqual(["Role A", "Role C", "Role B"]);
  });

  it("shows both labelled axes on the row and as separate score tracks once opened", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A", fit: 90, want: 10 })];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1", fit: 90, want: 10 }) };
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toMatch(/Fit 90/);
    expect(text(renderer)).toMatch(/Want 10/);
    expect(findByClass(renderer, "jds-score")).toEqual([]);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    const fills = renderer.root.findAll(
      (item) => (item.props as { className?: string }).className === "jds-score__fill"
    );
    expect(fills.map((fill) => fill.props.style?.["--jds-score"])).toEqual(["0.9", "0.1"]);
  });

  it("clamps both axis tracks when model-authored scores are out of range", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Role A", fit: 140, want: -20 })];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1", fit: 140, want: -20 }) };
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toMatch(/Fit 140/);
    expect(text(renderer)).toMatch(/Want -20/);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    const fills = renderer.root.findAll(
      (item) => (item.props as { className?: string }).className === "jds-score__fill"
    );
    expect(fills.map((fill) => fill.props.style?.["--jds-score"])).toEqual(["1", "0"]);
  });

  it("renders dashes and a 'Not read yet' flag for an unscored row, and the inspector says queued not dropped", async () => {
    fixtures.matchesItems = [
      match({
        id: "m1",
        title: "Unscored Role",
        fit: null,
        want: null,
        state: "unscored"
      })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toMatch(/Not read yet/);
    // An unscored row carries no number on either axis, and never a 0 — a zero is a score, drawn
    // in the same bar as a real one. match-row.tsx (task #98) still draws a rail on every row —
    // it's the leading fit-band colour swatch, always present — but for an unscored row it's the
    // quietest neutral tone (`jds-rail--line`), never one of the four band colours, and the
    // trailing word is "Not read yet", never a band label or a dash pretending to be one. Score's
    // `jds-score` bar (Want) never renders on the row at all, scored or not — see the test above.
    expect(findByClass(renderer, "jds-rail--line")).toHaveLength(1);
    for (const bandRail of ["jds-rail--accent", "jds-rail--steel", "jds-rail--line-strong"]) {
      expect(findByClass(renderer, bandRail)).toEqual([]);
    }
    expect(findByClass(renderer, "jds-score")).toEqual([]);

    await act(async () => {
      findRowButton(renderer, /Unscored Role/)!.props.onClick();
    });
    await flush(renderer);
    expect(text(renderer)).toMatch(/queued for scoring, not dropped/i);
  });

  // Team-lead ask (task #106 follow-up): the retired FitRail's two rendering tests protected "a
  // null Fit must never read as a scored zero" at the component level; fitBand itself never sees
  // null any more (match-row.tsx guards it — see fitBand's own test in job-search-keyline.test.tsx),
  // so the only place left to assert that invariant is here, on a SCORED row (want present, state
  // !== "unscored") with fit: null versus a real fit: 0 — both are isScored === true, but only one
  // has a band. Scoped to each row's own `.jsm-row__aside` (the fit-label slot) rather than the
  // whole row: the row's own meta line uses an em dash as an ordinary separator character
  // ("Remote — US"), which would otherwise falsely satisfy "renders a dash" for either fixture.
  it("on a scored row, a null Fit renders a bare em dash with no digit, distinguishable from a real 0 which renders 'Weak fit'", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "No Basis", fit: null, want: 50, state: "new" }),
      match({ id: "m2", title: "Rock Bottom", fit: 0, want: 50, state: "new" })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    function asideText(row: ReturnType<typeof findRowButton>): string {
      const aside = row!.findAll((item) =>
        String((item.props as { className?: string }).className ?? "")
          .split(" ")
          .includes("jsm-row__aside")
      )[0]!;
      return flatten(aside.children);
    }

    const noBasisAside = asideText(findRowButton(renderer, /No Basis/));
    expect(noBasisAside).toMatch(/Fit\s+—/);
    expect(noBasisAside).toMatch(/Want\s+50/);

    const rockBottomAside = asideText(findRowButton(renderer, /Rock Bottom/));
    expect(rockBottomAside).toMatch(/Fit\s+0/);
    expect(rockBottomAside).toMatch(/Want\s+50/);
    expect(rockBottomAside).not.toMatch(/—/);
  });

  it("sorts unscored rows last regardless of the active sort direction", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Scored Low", fit: 10, want: 10 }),
      match({
        id: "m2",
        title: "Unscored",
        fit: null,
        want: null,
        state: "unscored"
      }),
      match({ id: "m3", title: "Scored High", fit: 90, want: 90 })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    const fitHeader = findButton(renderer, /^Fit/);
    await act(async () => {
      fitHeader!.props.onClick(); // first click => desc
    });
    expect(rowTitles(renderer).at(-1)).toBe("Unscored");

    await act(async () => {
      fitHeader!.props.onClick(); // second click => asc
    });
    expect(rowTitles(renderer).at(-1)).toBe("Unscored");
  });

  it("renders a visible flag on an outside-frame row", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Frame Breaker", outsideFrame: true })];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toMatch(/Outside your stated frame/);
  });

  it("never renders a combined or overall score anywhere", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Role A", fit: 80, want: 20 }),
      match({
        id: "m2",
        title: "Role B",
        fit: null,
        want: null,
        state: "unscored"
      })
    ];
    fixtures.portalsItems = [portal({ cause: cause() })];
    const renderer = await renderBoard();
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Role A/)!.props.onClick();
    });
    await flush(renderer);

    expect(text(renderer)).not.toMatch(/\boverall\b|\bcombined\b/i);
  });

  it("renders a degraded portal's cause.summary and cause.nextAction verbatim", async () => {
    fixtures.matchesItems = [match()];
    const degradedCause = cause({
      summary: "Indeed returned fewer postings than expected.",
      nextAction: "We'll try again on the next scheduled run."
    });
    fixtures.portalsItems = [portal({ sourceId: "indeed", label: "Indeed", cause: degradedCause })];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toContain("Indeed returned fewer postings than expected.");
    expect(text(renderer)).toContain("We'll try again on the next scheduled run.");
  });

  it("renders a self-disabled portal as disabled-with-cause, not an error", async () => {
    fixtures.matchesItems = [match()];
    const disabledCause = cause({
      kind: "login_required",
      summary: "LinkedIn requires signing in, which this module never does.",
      nextAction: "This board keeps working from your other sources.",
      disabled: true
    });
    fixtures.portalsItems = [
      portal({ sourceId: "linkedin", label: "LinkedIn", enabled: false, cause: disabledCause })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(findByRole(renderer, "alert")).toHaveLength(0);
    expect(findByRole(renderer, "status").length).toBeGreaterThan(0);
    expect(text(renderer)).toContain("LinkedIn requires signing in, which this module never does.");
  });

  it("'Search now' enqueues via runQueue on job-search.crawl-run/crawl.run with the profileId, not local state", async () => {
    fixtures.matchesItems = [match()];
    const renderer = await renderBoard("p1");
    await flush(renderer);

    const searchNow = findButton(renderer, /^Search now/);
    await act(async () => {
      searchNow!.props.onClick();
    });
    await flush(renderer);

    expect(api.runQueue).toHaveBeenCalledWith("job-search.crawl-run", "crawl.run", {
      profileId: "p1"
    });
  });

  it("'Search now' fires even when the enqueue latch is already set for this actor/profile", async () => {
    setLatched("actor-x", "p1");
    fixtures.matchesItems = [match()];
    const renderer = await renderBoard("p1");
    await flush(renderer);

    const searchNow = findButton(renderer, /^Search now/);
    await act(async () => {
      searchNow!.props.onClick();
    });
    await flush(renderer);

    expect(api.runQueue).toHaveBeenCalledWith("job-search.crawl-run", "crawl.run", {
      profileId: "p1"
    });
  });

  it("renders each RunOutcome distinctly and keeps the button usable after an error", async () => {
    // One fresh board per outcome, deliberately. The button is disabled for the whole run now, not
    // just for the enqueue POST, so a single render cannot be clicked four times in a row the way
    // this test used to — a user who has started a search cannot start another until it ends, and a
    // test that reached past `disabled` to call the handler directly would be asserting a click no
    // one can make. Each outcome is what a first click produces from an idle board.
    async function clickSearch(outcome: Awaited<ReturnType<typeof api.runQueue>>) {
      fixtures.matchesItems = [match()];
      const renderer = await renderBoard();
      await flush(renderer);
      vi.mocked(api.runQueue).mockResolvedValueOnce(outcome);
      await act(async () => {
        findButton(renderer, /^Search now/)!.props.onClick();
      });
      await flush(renderer);
      return renderer;
    }

    // Accepted, so the run is followed: the notice says a search is under way and the button is
    // held disabled until the poll says the board has settled.
    const queued = await clickSearch({ kind: "queued" });
    expect(text(queued)).toMatch(/Searching… new roles will appear below/i);
    expect(findButton(queued, /^Search now/)!.props.disabled).toBe(true);
    expect(findByRole(queued, "alert")).toHaveLength(0);

    // The host's five-second manual-run singleton rejecting a double-click. There is a run in
    // flight either way, so this is followed exactly like an accepted one — not reported as a
    // failure, and not left with a clickable button.
    const already = await clickSearch({ kind: "already-queued" });
    expect(text(already)).toMatch(/Searching… new roles will appear below/i);
    expect(findButton(already, /^Search now/)!.props.disabled).toBe(true);
    expect(findByRole(already, "alert")).toHaveLength(0);

    // Nothing is running in either of the next two, so the button must come straight back.
    const disabled = await clickSearch({ kind: "disabled" });
    expect(text(disabled)).toMatch(/turned off for this account/i);
    expect(findButton(disabled, /^Search now/)!.props.disabled).toBeFalsy();

    const failed = await clickSearch({ kind: "error", message: "Network error" });
    expect(text(failed)).toMatch(/Couldn't start a search: Network error/);
    expect(findByRole(failed, "alert").length).toBeGreaterThan(0);

    // And a retry after the error really does reach the transport again.
    const button = findButton(failed, /^Search now/);
    expect(button!.props.disabled).toBeFalsy();
    const callsBefore = vi.mocked(api.runQueue).mock.calls.length;
    vi.mocked(api.runQueue).mockResolvedValueOnce({ kind: "queued" });
    await act(async () => {
      button!.props.onClick();
    });
    await flush(failed);
    expect(vi.mocked(api.runQueue).mock.calls.length).toBe(callsBefore + 1);
  });

  it("offers Save and Pass on undecided real rows without opening the inspector", async () => {
    fixtures.matchesItems = [
      match({ id: "m1", title: "Decide Me", state: "new" }),
      match({
        id: "synthetic",
        title: "Unscored Role",
        state: "unscored",
        fit: null,
        want: null
      })
    ];
    const renderer = await renderBoard();
    await flush(renderer);

    const save = renderer.root
      .findAllByType("button")
      .find((item) => item.props["aria-label"] === "Save Decide Me");
    const pass = renderer.root
      .findAllByType("button")
      .find((item) => item.props["aria-label"] === "Pass on Decide Me");

    expect(save).toBeTruthy();
    expect(pass).toBeTruthy();
    expect(
      renderer.root
        .findAllByType("button")
        .some((item) => String(item.props["aria-label"] ?? "").includes("Unscored Role"))
    ).toBe(false);

    await act(async () => {
      save!.props.onClick({ stopPropagation: vi.fn() });
    });
    expect(api.runQueue).toHaveBeenCalledWith("job-search.match-state", "match.set-state", {
      matchId: "m1",
      state: "seen"
    });
    expect(api.invokeTool).not.toHaveBeenCalledWith("job-search.match.get", { matchId: "m1" });
  });

  it("Pass (dismiss) enqueues job-search.match-state/match.set-state and hides the row immediately (optimistic)", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "To Dismiss" })];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1" }) };
    // Never resolves during this test — proves the row hides before the write settles, not after.
    vi.mocked(api.runQueue).mockReturnValue(new Promise(() => undefined));
    const renderer = await renderBoard("p1");
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /To Dismiss/)!.props.onClick();
    });
    await flush(renderer);

    const passButton = renderer.root.findAllByType("button").find((item) => {
      const children = Array.isArray(item.props.children)
        ? item.props.children
        : [item.props.children];
      return children.some((child: unknown) => child === "Pass");
    });
    await act(async () => {
      passButton!.props.onClick();
    });

    expect(api.runQueue).toHaveBeenCalledWith("job-search.match-state", "match.set-state", {
      matchId: "m1",
      state: "dismissed"
    });
    // handleDismiss nulls selectedMatchId immediately (board.tsx) — the view swaps straight back
    // to the list, and the same optimistic hide the old inline Dismiss gave still holds there.
    expect(rowTitles(renderer)).not.toContain("To Dismiss");
  });

  it("does not restore a passed match merely because enqueue acceptance precedes the worker write", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Bounces Back", state: "new" })];
    fixtures.matchGetResult = { match: matchDetail({ id: "m1" }) };
    const renderer = await renderBoard("p1");
    await flush(renderer);

    await act(async () => {
      findRowButton(renderer, /Bounces Back/)!.props.onClick();
    });
    await flush(renderer);

    const passButton = renderer.root.findAllByType("button").find((item) => {
      const children = Array.isArray(item.props.children)
        ? item.props.children
        : [item.props.children];
      return children.some((child: unknown) => child === "Pass");
    });
    await act(async () => {
      passButton!.props.onClick();
    });
    await flush(renderer);

    expect(rowTitles(renderer)).not.toContain("Bounces Back");
    expect(text(renderer)).not.toMatch(/couldn.t be passed/i);
  });

  it("restores a passed match when enqueueing is rejected", async () => {
    fixtures.matchesItems = [match({ id: "m1", title: "Bounces Back", state: "new" })];
    vi.mocked(api.runQueue).mockResolvedValueOnce({ kind: "error", message: "unavailable" });
    const renderer = await renderBoard("p1");
    await flush(renderer);

    const passButton = renderer.root
      .findAllByType("button")
      .find((item) => item.props["aria-label"] === "Pass on Bounces Back");
    await act(async () => {
      passButton!.props.onClick({ stopPropagation: vi.fn() });
    });
    await flush(renderer);

    expect(rowTitles(renderer)).toContain("Bounces Back");
    expect(text(renderer)).toMatch(/couldn.t be passed/i);
  });

  it("renders an error state with a working retry that re-invokes matches.list", async () => {
    fixtures.matchesShouldReject = true;
    const renderer = await renderBoard();
    await flush(renderer);

    expect(findByRole(renderer, "alert").length).toBeGreaterThan(0);
    const retry = findButton(renderer, /Try again/i);
    expect(retry).toBeTruthy();

    fixtures.matchesShouldReject = false;
    fixtures.matchesItems = [match({ id: "m1", title: "Recovered Role" })];
    await act(async () => {
      retry!.props.onClick();
    });
    await flush(renderer);

    expect(findByRole(renderer, "alert")).toHaveLength(0);
    expect(rowTitles(renderer)).toContain("Recovered Role");
  });

  // The live regression: a board with 167 rows and a crawl in progress vanished entirely because
  // one poll read failed. The whole screen was swapped for the error card, which also unmounted the
  // Search now control and with it the run being followed — so the user's search disappeared along
  // with the rows, and nothing said why. A board that has rows keeps them.
  it("keeps its rows and its search control when a later read fails", async () => {
    vi.useFakeTimers();
    try {
      fixtures.matchesItems = [match({ id: "m1", title: "Already Loaded Role" })];
      const renderer = await renderBoard();
      await flush(renderer);
      expect(rowTitles(renderer)).toContain("Already Loaded Role");

      const search = findButton(renderer, /^Search now/);
      await act(async () => {
        search!.props.onClick();
      });
      await flush(renderer);

      // The crawl finds a second role, so the poll's count moves and it goes to fetch the rows —
      // and that read is the one that fails. This is the exact sequence of the live regression: a
      // board mid-crawl, one failed read, and the whole screen replaced by an error card that took
      // the Search now control (and the run it was following) down with it.
      fixtures.matchesItems = [
        match({ id: "m1", title: "Already Loaded Role" }),
        match({ id: "m2", title: "Never Arrives" })
      ];
      fixtures.matchesShouldReject = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TICK_MS);
      });
      await flush(renderer);

      expect(rowTitles(renderer)).toContain("Already Loaded Role");
      expect(findButton(renderer, /^Search now/)).toBeTruthy();
      expect(findByRole(renderer, "alert")).toHaveLength(0);
      expect(text(renderer)).toMatch(/from the last load/i);
    } finally {
      vi.useRealTimers();
    }
  });

  // Every full read costs one request per 25 rows, and every module read tool in the app shares one
  // sixty-per-minute host budget — so a second read starting on top of one already running is
  // fourteen requests inside a second on a 168-row board. That is exactly how the live proof
  // collected 429s: the window-focus refetch landed on the mount read and every page offset was
  // requested twice. A 429 mid-read loses a whole page of the board, so this is not just waste.
  it("joins the read already in flight instead of paging the whole board a second time", async () => {
    const releases: Array<() => void> = [];
    let listCalls = 0;
    vi.mocked(api.invokeTool).mockImplementation(async (name: string) => {
      if (name === "job-search.matches.list") {
        listCalls += 1;
        // Held open, so the focus event below arrives while the mount read is genuinely still in
        // flight rather than after it has quietly finished.
        return await new Promise<unknown>((resolve) => {
          releases.push(() => resolve({ items: [match({ id: "m1", title: "Held Role" })] }));
        });
      }
      if (name === "job-search.portal.list") return { portals: [] };
      if (name === "job-search.resume.get") return { resume: null };
      throw new Error(`unexpected invokeTool ${name}`);
    });

    const renderer = await renderBoard();
    expect(listCalls).toBe(1);

    await act(async () => {
      fireWindowEvent("focus");
    });
    // Still one: the focus handler wants current rows, and a read for exactly that is already
    // running. Without the join this would be 2 here and 14 on Ben's board.
    expect(listCalls).toBe(1);

    for (const release of releases) release();
    await flush(renderer);
    expect(rowTitles(renderer)).toContain("Held Role");
  });

  it("renders a distinct empty state for zero matches — not loading, not error", async () => {
    fixtures.matchesItems = [];
    const renderer = await renderBoard();
    await flush(renderer);

    expect(text(renderer)).toMatch(/No matches yet/i);
    expect(text(renderer)).not.toMatch(/Loading/i);
    expect(findByRole(renderer, "alert")).toHaveLength(0);
  });
});
