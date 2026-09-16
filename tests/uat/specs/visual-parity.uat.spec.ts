// tests/uat/specs/visual-parity.uat.spec.ts
//
// VP-P0 parity ruler: one shared seed, 32 study-region captures with masked
// diffs and a report. P0 owns no threshold (PARITY_OWNED empty), so the run
// is green when every capture, diff and report line exists. PARITY_GUARD_ONLY=1
// captures only the shared-page guards (base/head comparison runs).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { captureEntry, guardCapture, reportLine } from "../visual-parity/capture.js";
import { MOCKUPS } from "../visual-parity/mockups.js";
import {
  addDay,
  armCalendar,
  closeDialogs,
  createBriefingRun,
  createDayPlan,
  createTask,
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

export const uatLevel = {
  level: "admin+data",
  without: [],
  withJobSearchFixture: true,
  withSportsPublicSourceFixtures: true
} as const;
const OUT =
  process.env.JARVIS_PARITY_OUT ??
  "/home/ben/.viberoom/rooms/moss-design-update/workspace/evidence/visual-parity/p0-baseline";
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
async function seedAll(
  page: Page
): Promise<{ day: string; timeZone: string; ids: Record<string, string> }> {
  const m = manifest() as unknown as ParityManifest;
  const day = localDay();
  await signIn(page);
  const timeZone = ((await json(page, "/api/me/locale")).body as { locale: { timezone: string } })
    .locale.timezone;
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
  await createBriefingRun(
    page,
    "morning",
    "Parity morning",
    ["tasks.list", "calendar.listVisibleEvents", "news.topHeadlinesToday"],
    localIso(day, "08:00")
  );
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
  await expect(page.getByRole("listitem").filter({ hasText: "Arsenal" }).first()).toBeVisible({
    timeout: 60000
  });
  await expect(page.locator("#weather")).toContainText(/\S/, { timeout: 60000 });
  console.log(
    `[parity] populated: timeline, weather, news lead "${((news["topStories"] as Array<{ title: string }>)[0] as { title: string }).title}", sports scores`
  );
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
test("visual parity walk: 32 captures, diffs and report", async ({ page }) => {
  test.setTimeout(900_000);
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
  const lines = ["| file | size | masked | diff | size |", "|---|---|---|---|---|"];
  let lastState = "";
  let lastWidth = 0;
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
        await mirrorBlock(
          page,
          localDay(),
          ((await json(page, "/api/me/locale")).body as { locale: { timezone: string } }).locale
            .timezone,
          0
        );
      if (entry.state.startsWith("reader-automatic"))
        await mirrorBlock(
          page,
          localDay(),
          ((await json(page, "/api/me/locale")).body as { locale: { timezone: string } }).locale
            .timezone,
          1
        );
      if (entry.state === "evening-step-2" && lastState === "evening-step-1") {
        const dialog = page.getByRole("dialog");
        await dialog
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
    const r = await captureEntry(page, entry, MOCKROOT, OUT);
    console.log(
      `[parity] ${r.file} ${r.size} masked ${(r.maskedShare * 100).toFixed(1)}% diff ${r.diffPercent.toFixed(2)}%`
    );
    expect(r.maskedShare).toBeLessThanOrEqual(0.35);
    if (OWNED.has(entry.name)) expect(r.diffPercent).toBeLessThanOrEqual(0.5);
    lines.push(reportLine(r));
  }
  await closeDialogs(page);
  for (const [name, path] of GUARDS) {
    await page.goto(path);
    for (const w of [1440, 375])
      await guardCapture(page, `guard-${name}-${w}`, w, join(OUT, "guard"));
  }
  writeFileSync(join(OUT, "report.md"), `# visual parity baseline\n\n${lines.join("\n")}\n`);
  expect(lines.length).toBe(34);
});
