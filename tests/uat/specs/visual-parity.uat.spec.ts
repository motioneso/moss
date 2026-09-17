import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import {
  captureEntry,
  guardCapture,
  reportLine,
  waitForRoutePopulated,
  waitForStablePopulated,
  type RouteName,
  type RouteReadinessEvidence
} from "../visual-parity/capture.js";
import { DECLARED_SIZE_MISMATCHES } from "../visual-parity/declared-size-mismatches.js";
import { MOCKUPS } from "../visual-parity/mockups.js";
import {
  addDay,
  armCalendar,
  closeDialogs,
  createBriefingRun,
  createDayPlan,
  createTask,
  disableSeededCustomSources,
  ensurePlanning,
  ensureReader,
  forceChrome,
  json,
  localDay,
  localIso,
  manifest,
  mirrorBlock,
  openToday,
  resolveStamp,
  scrollSectionTop,
  seedCachedEvents,
  stabilizeSportsFollowOrder,
  setPolicy,
  setWeatherLocation
} from "../visual-parity/seed.js";
import {
  blurComposer,
  check,
  expectAttr,
  openChatDrawer,
  shellGeometry
} from "../visual-parity/shell-navigation.js";
import { type MatrixContext } from "../visual-parity/shell-navigation-matrix.js";
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  withJobSearchFixture: true,
  withSportsPublicSourceFixtures: true,
  chatScript: "phase1-smoke",
  withEspnFixture: true
} as const;
const OUT =
  process.env.MOSS_PARITY_OUT ??
  "/home/ben/.viberoom/rooms/moss-design-update/workspace/evidence/visual-parity/p0-baseline";
const LONG_TASK_LIST_NAME = "Parity mobile toolbar list with a deliberately long name";
const HERE = dirname(fileURLToPath(import.meta.url));
const MOCKROOT = joinPath(HERE, "..", "..", "..", "docs", "superpowers", "specs", "assets");
const OWNED = new Set(
  (process.env.PARITY_OWNED ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const GUARDS: Array<[string, string]> = [
  ["tasks", "/tasks"],
  ["calendar", "/calendar"],
  ["settings", "/settings"],
  ["today", "/today"]
];
interface ParityEvent {
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
}
interface ParityTask {
  readonly key: string;
  readonly title: string;
  readonly due: string | null;
  readonly status?: string;
}
interface ParityManifest {
  readonly tasks: readonly ParityTask[];
  readonly meetings: readonly ParityEvent[];
  readonly events: readonly ParityEvent[];
  readonly todayPlanTasks: readonly string[];
  readonly tomorrowPlanTasks: readonly string[];
  readonly news: { readonly expectedHeadline: string };
  readonly weather: { readonly location: string };
}
interface ScoreGame {
  readonly home?: { readonly sourceTeamId?: string };
  readonly away?: { readonly sourceTeamId?: string };
}
async function signIn(page: Page): Promise<void> {
  await page.goto(process.env.JARVIS_UAT_BASE_URL!);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}
async function localeTz(page: Page): Promise<string> {
  const locale = (await json(page, "/api/me/locale")).body as { locale: { timezone: string } };
  return locale.locale.timezone;
}
async function seedAll(
  page: Page
): Promise<{ day: string; timeZone: string; ids: Record<string, string> }> {
  const m = manifest() as unknown as ParityManifest;
  const day = localDay();
  await signIn(page);
  const timeZone = await localeTz(page);
  const accountId = await armCalendar(page);
  await seedCachedEvents(
    page,
    accountId,
    [...m.meetings, ...m.events].map((e: ParityEvent, i: number) => ({
      title: e.title,
      startsAt: resolveStamp(day, e.startsAt),
      endsAt: resolveStamp(day, e.endsAt),
      externalId: `vp-${i}`
    }))
  );
  await setPolicy(page, "suggest");
  await stabilizeSportsFollowOrder();
  await disableSeededCustomSources();
  const longList = await json(page, "/api/tasks/lists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: LONG_TASK_LIST_NAME })
  });
  expect(longList.status).toBe(201);
  const ids: Record<string, string> = {};
  for (const t of m.tasks) {
    const due = t.due ? resolveStamp(day, t.due) : null;
    ids[t.key] = await createTask(page, t.title, due);
    if (t.status === "done") {
      const r = await json(page, `/api/tasks/${ids[t.key]}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" })
      });
      expect(r.status).toBe(200);
    }
  }
  await createDayPlan(
    page,
    day,
    timeZone,
    m.todayPlanTasks.map((k: string) => ids[k] as string)
  );
  await createDayPlan(
    page,
    addDay(day),
    timeZone,
    m.tomorrowPlanTasks.map((k: string) => ids[k] as string)
  );
  const morningTools = ["tasks.list", "calendar.listVisibleEvents", "news.topHeadlinesToday"];
  await createBriefingRun(page, "morning", "Parity morning", morningTools, localIso(day, "08:00"));
  await createBriefingRun(
    page,
    "evening",
    "Parity evening",
    ["tasks.list"],
    localIso(day, "20:00")
  );
  await setWeatherLocation(page, m.weather.location);
  return { day, timeZone, ids };
}
async function overview(
  page: Page,
  path: string,
  key: string,
  ms: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await json(page, path);
    if (r.status === 200 && Array.isArray((r.body as Record<string, unknown>)[key])) {
      const rows = (r.body as Record<string, unknown>)[key] as readonly unknown[];
      if (rows.length > 0) return r.body as Record<string, unknown>;
    }
    await page.waitForTimeout(5000);
  }
  throw new Error(`parity: ${path} carried no ${key}`);
}
async function populatedMorning(page: Page, m: ParityManifest): Promise<void> {
  const task0 = m.tasks[0];
  const meeting0 = m.meetings[0];
  if (!task0 || !meeting0) throw new Error("parity: manifest tasks/meetings empty");
  await expect(page.getByText(task0.title).first()).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(meeting0.title).first()).toBeVisible({ timeout: 30000 });
  const sports = await overview(page, "/api/sports/overview", "scoreboard", 120000);
  const groups = sports["scoreboard"] as Array<{ readonly games: readonly ScoreGame[] }>;
  const games = groups.flatMap((g) => g.games);
  expect(games.some((g) => [g.home?.sourceTeamId, g.away?.sourceTeamId].includes("359"))).toBe(
    true
  );
  const news = await overview(page, "/api/news/overview", "topStories", 180000);
  await expect(page.locator(".jds-brief--news").first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator(".jds-brief--sports").first()).toBeVisible({ timeout: 60000 });
  const arsenalItem = page.getByRole("listitem").filter({ hasText: "Arsenal" }).first();
  await expect(arsenalItem).toBeVisible({ timeout: 60000 });
  await expect(page.locator("#weather")).toContainText(/\S/, { timeout: 60000 });
  console.log(
    `[parity] populated: timeline, weather, news lead "${((news["topStories"] as Array<{ title: string }>)[0] as { title: string }).title}", sports scores`
  );
}
async function assertFixtureSeam(page: Page, m: ParityManifest): Promise<void> {
  const news = await overview(page, "/api/news/overview", "topStories", 180000);
  const stories = news["topStories"] as Array<{ readonly title: string; readonly url: string }>;
  const lead = stories[0];
  const invalidLinks = stories.filter((story) => {
    try {
      return new URL(story.url).hostname !== "fixture.invalid";
    } catch {
      return true;
    }
  });
  if (lead?.title !== m.news.expectedHeadline || invalidLinks.length > 0) {
    throw new Error(
      `fixture seam inactive: expected lead "${m.news.expectedHeadline}", got "${lead?.title ?? "<none>"}"; ` +
        `${invalidLinks.length} top story link(s) were not on fixture.invalid`
    );
  }
}
async function assertSportsSourceSeam(page: Page): Promise<void> {
  const sports = await overview(page, "/api/sports/overview", "followed", 180000);
  const stories = sports["topStories"] as Array<{ readonly publisherDomain?: string }>;
  const cards = sports["followed"] as Array<{
    readonly name: string;
    readonly stories: Array<{ readonly title: string; readonly publisherDomain?: string }>;
  }>;
  const customDomains = new Set([
    "www.fotmob.com",
    "feeds.bbci.co.uk",
    "raw.githubusercontent.com",
    "fotmob.com",
    "raw.githack.com"
  ]);
  const customStories = [...stories, ...cards.flatMap((card) => card.stories)].filter((story) =>
    customDomains.has(story.publisherDomain ?? "")
  );
  if (customStories.length > 0) {
    throw new Error(
      `sports custom sources active: ${customStories.length} seeded stories across ` +
        `${stories.length} top stories and ${cards.length} followed cards`
    );
  }
  const arsenal = cards.find((card) => card.name === "Arsenal");
  const headline = "Arsenal seal late win to stay top of the pile";
  if (!arsenal?.stories.some((story) => story.title === headline)) {
    throw new Error("espn fixture inactive: Arsenal card lacks the fixture headline");
  }
  assertApiRequestLog();
}

async function seededBriefingSummary(
  page: Page,
  briefingType: "morning" | "evening"
): Promise<string> {
  const definitions = await json(page, "/api/briefings/definitions");
  const definition = (
    definitions.body.definitions as Array<{ id: string; briefingType: string }>
  ).find((item) => item.briefingType === briefingType);
  if (!definition) throw new Error(`parity: seeded ${briefingType} briefing definition missing`);
  const runs = await json(page, `/api/briefings/definitions/${definition.id}/runs`);
  const run = (runs.body.runs as Array<{ status: string; summaryText: string }>).find(
    (item) => item.status === "succeeded" && item.summaryText.trim() !== ""
  );
  if (!run) throw new Error(`parity: seeded ${briefingType} briefing summary missing`);
  return run.summaryText.trim();
}

function matrixContext(m: ParityManifest, eveningSummary: string): MatrixContext {
  const waitForExpectedRoute = async (
    page: Page,
    route: RouteName
  ): Promise<RouteReadinessEvidence> =>
    waitForRoutePopulated(page, route, {
      taskTitle: m.tasks[0]?.title,
      meetingTitle: m.meetings[0]?.title,
      eventTitles: [m.meetings[0]?.title, m.events[0]?.title].filter((title): title is string =>
        Boolean(title)
      ),
      settingsPaneTitle: "Account & preferences",
      eveningSummary,
      tomorrowTaskTitle: m.tasks.find((task) => task.key === "due-tomorrow")?.title,
      tomorrowEventTitle: m.events.find((event) => event.title === "Parity dentist")?.title
    });
  return {
    check,
    shellGeometry,
    openChatDrawer,
    blurComposer,
    expectAttr,
    localDay,
    localIso,
    openToday,
    waitForRoutePopulated: waitForExpectedRoute,
    longTaskListName: LONG_TASK_LIST_NAME
  };
}
function assertApiRequestLog(): void {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("espn fixture inactive: invalid UAT project");
  const args = buildUatComposeArgs(project, ["logs", "--tail", "5000", "jarv1s"]);
  const logs = execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lines = logs.split("\n").filter((line) => line.includes('"msg":"incoming request"'));
  if (lines.length === 0) throw new Error("espn fixture inactive: no API request log lines");
  console.log(`[parity] API request log lines: ${lines.length}`);
}
async function driveState(page: Page, state: string, w: number): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (state.startsWith("today-")) {
    await closeDialogs(page).catch(() => undefined);
    await page.setViewportSize({ width: w, height: 1000 });
    if (state === "today-morning-news") await scrollSectionTop(page, ".jds-brief--news");
    if (state === "today-morning-sports")
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.7));
  } else if (state.startsWith("reader-")) {
    const tab = state.includes("-review") || state.includes("partial") ? 1 : 0;
    await ensureReader(page, w, tab as 0 | 1);
  } else if (state.startsWith("evening-step-")) {
    await ensurePlanning(page, w, Number(state.slice("evening-step-".length)));
  } else if (state === "evening-saved") {
    await expect(dialog).toBeVisible();
  }
}
// Test-side quiescence: background refresh jobs rewrite overview rows early on, so
// poll the stable projection (not capture code) until it settles before holding.
async function apiQuiescent(page: Page): Promise<void> {
  const project = async () =>
    page.evaluate(async () => {
      type Story = { title?: string; url?: string };
      const read = async (path: string) =>
        (await fetch(path).then((r) => r.json())) as {
          topStories?: Story[];
          followed?: Array<{ name?: string; stories?: Story[] }>;
        };
      const [news, sports] = await Promise.all([
        read("/api/news/overview"),
        read("/api/sports/overview")
      ]);
      return JSON.stringify({
        news: (news.topStories ?? []).map((story) => [story.title, story.url]),
        sports: (sports.topStories ?? []).map((story) => [story.title, story.url]),
        followed: (sports.followed ?? []).map((card) => [
          card.name,
          (card.stories ?? []).map((story) => [story.title, story.url])
        ])
      });
    });
  const deadline = Date.now() + 120_000;
  let prev = await project();
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const next = await project();
    if (next === prev && next !== "") return;
    prev = next;
  }
  throw new Error("parity: overview APIs never reached quiescence");
}
test("visual parity walk: 32 captures, diffs and report", async ({ page }) => {
  test.setTimeout(process.env.PARITY_SHELL === "1" ? 1_500_000 : 900_000);
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, "guard"), { recursive: true });
  await forceChrome(page);
  await seedAll(page);
  const m = manifest() as unknown as ParityManifest;
  if (process.env.PARITY_GUARD_ONLY === "1") {
    await openToday(page, new Date(localIso(localDay(), "08:00")));
    await populatedMorning(page, m);
    for (const [name, path] of GUARDS) {
      await page.goto(path);
      for (const w of [1440, 375])
        await guardCapture(page, `guard-${name}-${w}`, w, join(OUT, "guard"));
    }
    writeFileSync(join(OUT, "guard-report.md"), `# guard captures\n`);
    return;
  }
  await openToday(page, new Date(localIso(localDay(), "08:00")));
  await populatedMorning(page, m);
  await assertFixtureSeam(page, m);
  await assertSportsSourceSeam(page);
  console.log(
    "[parity] fixture seams accepted: news fixture.invalid, sports ESPN-only, API requests logged"
  );
  const eveningSummary = await seededBriefingSummary(page, "evening");
  const readiness = matrixContext(m, eveningSummary);
  if (process.env.PARITY_SHELL === "1") {
    await import("../visual-parity/shell-navigation.js").then(({ runShellChecks }) =>
      runShellChecks(page, OUT, readiness)
    );
    return;
  }
  const lines = ["| file | size | masked | diff | size |", "|---|---|---|---|---|"];
  let lastState = "",
    lastWidth = 0;
  for (const entry of MOCKUPS) {
    if (
      entry.clock === "evening" &&
      !lastState.startsWith("evening") &&
      !lastState.startsWith("today-evening") &&
      lastState !== ""
    ) {
      await openToday(page, new Date(localIso(localDay(), "20:00")));
    }
    if (
      entry.clock === "morning" &&
      (lastState.startsWith("evening") || lastState.startsWith("today-evening"))
    ) {
      await openToday(page, new Date(localIso(localDay(), "08:00")));
    }
    if (entry.state !== lastState || entry.viewport.w !== lastWidth) {
      if (entry.state === "reader-partial-review")
        await mirrorBlock(page, localDay(), await localeTz(page), 0);
      if (entry.state.startsWith("reader-automatic"))
        await mirrorBlock(page, localDay(), await localeTz(page), 1);
      if (entry.state === "evening-step-2" && lastState === "evening-step-1") {
        await page
          .getByRole("dialog")
          .getByRole("radiogroup", { name: `${(m.tasks[2] as ParityTask).title}: plan` })
          .getByLabel("Tomorrow")
          .click();
      }
      if (entry.state === "evening-saved") {
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "Save tomorrow's plan" }).click();
        await expect(dialog).toContainText("Saved. The blocks are proposed for the morning.");
      }
      await driveState(page, entry.state, entry.viewport.w);
      lastState = entry.state;
      lastWidth = entry.viewport.w;
    }
    if (entry.state.startsWith("today-morning"))
      await readiness.waitForRoutePopulated(page, "today");
    if (entry.name === "evening-1440-opening.png" || entry.name === "evening-375-opening.png")
      await readiness.waitForRoutePopulated(page, "evening");
    if (entry.state === "today-morning-news" || entry.state === "today-morning-sports")
      await waitForStablePopulated(page);
    const r = await captureEntry(page, entry, MOCKROOT, OUT);
    console.log(
      `[parity] ${r.file} ${r.size} masked ${(r.maskedShare * 100).toFixed(1)}% diff ${r.diffPercent.toFixed(2)}%`
    );
    expect(r.maskedShare).toBeLessThanOrEqual(0.35);
    const declared = DECLARED_SIZE_MISMATCHES.find(({ name }) => name === entry.name);
    if (declared) {
      expect(r.size, `${entry.name} captured size`).toBe(declared.capturedSize);
      expect(r.sizeMatch, `${entry.name} declared mismatch`).toBe(false);
    } else {
      expect(r.sizeMatch, `${entry.name} unexpected mismatch`).toBe(true);
    }
    if (OWNED.has(entry.name)) expect(r.diffPercent).toBeLessThanOrEqual(0.5);
    lines.push(reportLine(r));
  }
  await closeDialogs(page);
  for (const [name, path] of GUARDS) {
    await page.goto(path);
    for (const w of [1440, 375]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await readiness.waitForRoutePopulated(page, name as RouteName);
      await guardCapture(page, `guard-${name}-${w}`, w, join(OUT, "guard"));
    }
  }
  if (process.env.PARITY_SHELL === "1") {
    const { runShellChecks } = await import("../visual-parity/shell-navigation.js");
    await runShellChecks(page, OUT, readiness);
  }
  writeFileSync(join(OUT, "report.md"), `# visual parity baseline\n\n${lines.join("\n")}\n`);
  expect(lines.length).toBe(34);
});
async function readinessRace(page: Page, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = waitForStablePopulated(page).then(() => "completed", String);
  const out = await Promise.race([
    run,
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    })
  ]);
  clearTimeout(timer);
  return out;
}
// Regression second (walk seeded once; this test writes nothing): replay the session
// into a fresh context and race readiness before first paint, while faces are held.
test("r10 delayed display font regression", async ({ browser }) => {
  test.skip(process.env.PARITY_BASE_SMOKE === "1", "covered by the smoke-only readiness run");
  test.setTimeout(600_000);
  const base = process.env.JARVIS_UAT_BASE_URL!;
  const ctxA = await browser.newContext({ baseURL: base });
  const pageA = await ctxA.newPage();
  await forceChrome(pageA);
  await signIn(pageA);
  await apiQuiescent(pageA);
  const ctxB = await browser.newContext({ baseURL: base });
  await ctxB.addCookies(await ctxA.cookies());
  const page = await ctxB.newPage();
  await forceChrome(page);
  const releasers: Array<() => void> = [];
  const heldUrls: string[] = [];
  // Context-level: the service worker serves later same-origin requests, which a
  // page-level route never sees (red4: request events fired, page.route held none).
  await ctxB.route("**/*.woff2", async (route) => {
    heldUrls.push(route.request().url());
    await new Promise<void>((resolve) => {
      releasers.push(() => resolve());
    });
    await route.continue();
  });
  try {
    // Commit-only navigation: returns before parse/paint, so no face has started
    // loading when readiness runs below. Any earlier paint would poison fonts.ready.
    await page.clock.setFixedTime(new Date(localIso(localDay(), "08:00")));
    await page.goto("/today", { waitUntil: "commit" });
    const me = await page.evaluate(async () => (await fetch("/api/me/locale")).status);
    expect(me, "parity: replayed session not authenticated").toBe(200);
    const before = await readinessRace(page, 60_000);
    const hole = await page.evaluate(() => {
      const el = document.querySelector(".nw-twlead__title") as HTMLElement | null;
      const text = (el?.innerText ?? "").slice(0, 120);
      let loading = false;
      document.fonts.forEach((face) => {
        if (face.status === "loading") loading = true;
      });
      const rects: number[][] = [];
      const walker = document.createTreeWalker(el ?? document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && rects.length < 4) {
        if ((node.textContent ?? "").trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of Array.from(range.getClientRects())) {
            if (rects.length >= 4) break;
            rects.push([r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10));
          }
        }
        node = walker.nextNode();
      }
      return JSON.stringify({ text: text.length > 0, faceLoading: loading, rects });
    });
    console.log(`[parity-regression] held=${heldUrls.length} before=${before} hole=${hole}`);
    expect(JSON.parse(hole)).toEqual(expect.objectContaining({ text: true, faceLoading: true }));
    expect(heldUrls.length, "parity: no font held while readiness ran").toBeGreaterThan(0);
    const heldReadinessRejected =
      before === "timeout" ||
      before.startsWith("Error: parity: display face or geometry did not stabilize: ");
    expect(
      heldReadinessRejected,
      `parity: readiness completed with faces held (hole=${hole})`
    ).toBe(true);
    for (const release of releasers) release();
    const deadline = Date.now() + 60_000;
    let loading = true;
    while (loading && Date.now() < deadline) {
      await page.waitForTimeout(500);
      loading = await page.evaluate(() => {
        let active = false;
        document.fonts.forEach((face) => {
          if (face.status === "loading") active = true;
        });
        return active;
      });
    }
    expect(loading, "parity: held faces never loaded after release").toBe(false);
    expect(await readinessRace(page, 90_000), "parity: readiness never completed").toBe(
      "completed"
    );
    const capture = (await import("../visual-parity/capture.js")) as unknown as {
      stableSample?: (page: Page) => Promise<string>;
    };
    if (!capture.stableSample) {
      console.log("[parity-regression] no stableSample export; skipping face gate");
    } else {
      const after = JSON.parse(await capture.stableSample(page)) as {
        faces?: Array<{ sel?: string; ready?: boolean; lines?: number[][] }>;
      };
      console.log(`[parity-regression] after=${JSON.stringify(after.faces)}`);
      expect((after.faces ?? []).length).toBeGreaterThan(0);
      for (const face of after.faces ?? []) {
        expect(face.ready, `parity: face not ready: ${face.sel}`).toBe(true);
        expect(face.lines?.length ?? 0, `parity: no line rects: ${face.sel}`).toBeGreaterThan(0);
      }
    }
  } finally {
    for (const release of releasers) release();
    await ctxB.close().catch(() => undefined);
    await ctxA.close().catch(() => undefined);
  }
});
