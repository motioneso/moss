import { expect, test, type Page } from "@playwright/test";

import { signInUatAdmin, requireUatBaseURL } from "./real-chat-signin.js";

// Live-path proof for #2752 on real data: a disposable stack with its own database,
// real ESPN scoreboard fetches (no sports fixtures). Team follows are created from
// team keys read back out of the real overview response — no catalog search, no
// guessed keys. Asserts the first game of the wrapped Tonight row lines up with
// row one with no left divider, at wide, mid (601-1080), and phone widths.
export const uatLevel = {
  level: "admin+data",
  without: []
} as const;

test.describe.configure({ mode: "serial" });

const API_TIMEOUT_MS = 120_000;

interface OverviewGame {
  readonly id: string;
  readonly competitionKey: string;
  readonly state: string;
  readonly startsAt: string;
  readonly home: { readonly teamKey: string; readonly shortName: string };
  readonly away: { readonly teamKey: string; readonly shortName: string };
}

async function readOverview(page: Page): Promise<{
  readonly groups: readonly {
    readonly competitionKey: string;
    readonly games: readonly OverviewGame[];
  }[];
}> {
  const response = await page.request.get("/api/sports/overview", {
    timeout: API_TIMEOUT_MS
  });
  expect(response.ok(), `overview -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as {
    readonly groups?: unknown;
    readonly scoreboard: readonly {
      readonly competitionKey: string;
      readonly games: readonly OverviewGame[];
    }[];
  };
}

async function overviewDiagnostic(page: Page): Promise<string> {
  try {
    const overview = await readOverview(page);
    return overview.scoreboard
      .map(
        (group) =>
          `${group.competitionKey}: ${group.games.map((game) => game.state).join(",") || "(none)"}`
      )
      .join(" | ");
  } catch (error) {
    return `overview fetch failed: ${String(error)}`;
  }
}

// Follow up to three real teams from pre games starting within the next twelve
// hours, using the exact team keys the real overview response carries.
async function followTonightTeams(page: Page): Promise<readonly string[]> {
  const overview = await readOverview(page);
  const now = Date.now();
  const followed: string[] = [];
  const seen = new Set<string>();
  for (const group of overview.scoreboard) {
    for (const game of group.games) {
      if (game.state !== "pre") continue;
      const startsAt = new Date(game.startsAt).getTime();
      if (Number.isNaN(startsAt) || startsAt <= now || startsAt - now > 12 * 3_600_000) continue;
      for (const side of [game.home, game.away]) {
        const key = `${game.competitionKey}:${side.teamKey}`;
        if (seen.has(key) || followed.length >= 3) break;
        seen.add(key);
        const follow = await page.request.post("/api/sports/follows", {
          data: { competitionKey: game.competitionKey, teamKey: side.teamKey },
          timeout: API_TIMEOUT_MS
        });
        expect(follow.ok(), `follow ${side.shortName} -> ${follow.status()}`).toBeTruthy();
        followed.push(side.shortName);
      }
      if (followed.length >= 3) break;
    }
    if (followed.length >= 3) break;
  }
  return followed;
}

interface RowGeometry {
  left: number;
  top: number;
  borderLeftWidth: string;
  paddingLeft: string;
}

async function tonightRows(page: Page): Promise<RowGeometry[]> {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".jds-brief--sports .sp-tonight__row")];
    return rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        left: rect.left,
        top: rect.top,
        borderLeftWidth: style.borderLeftWidth,
        paddingLeft: style.paddingLeft
      };
    });
  });
}

function contentLeft(row: RowGeometry): number {
  return row.left + parseFloat(row.borderLeftWidth) + parseFloat(row.paddingLeft);
}

test("tonight divider holds on real games at wide, mid, and phone widths (#2752)", async ({
  page
}) => {
  test.setTimeout(600_000);
  await signInUatAdmin(page);

  // Whole-league follows are real user data; competitions derive from follows, so
  // following the WNBA pulls its real scoreboard into the overview too.
  const leagueFollow = await page.request.post("/api/sports/follows", {
    data: { competitionKey: "wnba" },
    timeout: API_TIMEOUT_MS
  });
  expect(leagueFollow.ok(), `follow wnba league -> ${leagueFollow.status()}`).toBeTruthy();

  // Front-load the data check: the client's own Tonight list is the verdict on
  // whether real games are reachable. Poll without reloading — each reload
  // restarts the client's in-flight overview fetch, while the first fetch warms
  // the server cache for the client's own refetch cadence.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${requireUatBaseURL()}/today`);
  let rows: RowGeometry[] = [];
  try {
    await expect
      .poll(
        async () => {
          rows = await tonightRows(page);
          return rows.length;
        },
        { timeout: 360_000, intervals: [5_000] }
      )
      .toBeGreaterThanOrEqual(4);
  } catch (error) {
    const diagnostic = await overviewDiagnostic(page);
    console.log(`[2752-live] scoreboard state: ${diagnostic}`);
    throw new Error(`real Tonight list never wrapped (scoreboard: ${diagnostic})`, {
      cause: error
    });
  }

  const followed = await followTonightTeams(page);
  console.log(`[2752-live] followed real teams: ${followed.join(", ")}`);
  expect(followed.length, "no real tonight teams to follow").toBeGreaterThanOrEqual(2);
  await page.reload();
  await expect
    .poll(
      async () => {
        rows = await tonightRows(page);
        return rows.length;
      },
      { timeout: 120_000, intervals: [5_000] }
    )
    .toBeGreaterThanOrEqual(4);

  // Wide: first game of row two lines up with row one, no divider or indent.
  const rowTop = rows[0]!.top;
  const rowTwoFirst = rows.findIndex((row) => row.top > rowTop + 1);
  expect(rowTwoFirst, "Tonight list never wrapped to a second row").toBeGreaterThan(0);
  expect(
    Math.abs(contentLeft(rows[rowTwoFirst]!) - contentLeft(rows[0]!))
  ).toBeLessThanOrEqual(1);
  expect(rows[rowTwoFirst]!.borderLeftWidth).toBe("0px");
  expect(rows[rowTwoFirst]!.paddingLeft).toBe("0px");
  expect(rows[1]!.borderLeftWidth).not.toBe("0px");

  const list = page.locator(".jds-brief--sports .sp-tonight");
  await list.scrollIntoViewIfNeeded();
  await list.screenshot({ path: "tests/screenshots/2752-tonight-live.png" });

  // Mid (601-1080, single column): every row flush, no dividers.
  await page.setViewportSize({ width: 800, height: 1000 });
  let mid = await tonightRows(page);
  try {
    await expect
      .poll(
        async () => {
          mid = await tonightRows(page);
          return mid.length;
        },
        { timeout: 60_000, intervals: [5_000] }
      )
      .toBeGreaterThanOrEqual(4);
  } catch {
    expect(mid.length).toBeGreaterThanOrEqual(4);
  }
  const midTops = new Set(mid.map((row) => Math.round(row.top)));
  expect(midTops.size, "800px width should be single column").toBe(mid.length);
  for (const row of mid) {
    expect(Math.abs(contentLeft(row) - contentLeft(mid[0]!))).toBeLessThanOrEqual(1);
    expect(row.borderLeftWidth).toBe("0px");
  }

  // Phone: every row flush, no dividers.
  await page.setViewportSize({ width: 390, height: 900 });
  let phone = await tonightRows(page);
  try {
    await expect
      .poll(
        async () => {
          phone = await tonightRows(page);
          return phone.length;
        },
        { timeout: 60_000, intervals: [5_000] }
      )
      .toBeGreaterThanOrEqual(4);
  } catch {
    expect(phone.length).toBeGreaterThanOrEqual(4);
  }
  for (const row of phone) {
    expect(Math.abs(contentLeft(row) - contentLeft(phone[0]!))).toBeLessThanOrEqual(1);
    expect(row.borderLeftWidth).toBe("0px");
  }
  await list.scrollIntoViewIfNeeded();
  await list.screenshot({ path: "tests/screenshots/2752-tonight-live-phone.png" });
});
