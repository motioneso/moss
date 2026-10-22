import { chromium, type Locator, type Page } from "playwright-core";
import { localDayKey, localDayRange } from "@moss/module-sdk";

import {
  addCalendarDays,
  normalizeOutlookCalendarLabel,
  outlookDisplayTimeZone,
  OutlookCalendarSourceError,
  parseOutlookWeekHeader,
  type OutlookCalendarObservation
} from "./outlook-calendar-source.js";

export interface OutlookBrowserBinding {
  readonly endpoint: string;
  readonly accountAddress: string;
}

export interface OutlookCalendarScan {
  readonly calendarKey: "primary";
  readonly timeZone: string;
  readonly observedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly complete: boolean;
  readonly views: number;
  readonly events: readonly OutlookCalendarObservation[];
}

const HOSTS = new Set(["outlook.office.com", "outlook.cloud.microsoft"]);
const HEADER = 'button[aria-label*="Jump to a specific date or date range."]';

/** Operator configuration only. This function is never fed a request body or job URL. */
export function validateOutlookBrowserEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new OutlookCalendarSourceError("source-changed");
  }
}

async function click(control: Locator): Promise<void> {
  await control.waitFor({ state: "visible" });
  await control.evaluate((element) => {
    if (!(element instanceof HTMLElement)) throw new Error("unsupported-control");
    element.focus();
    element.click();
  });
}

async function verifyAccount(page: Page, expected: string): Promise<void> {
  await click(page.getByRole("button", { name: "Settings", exact: true }));
  try {
    await click(page.getByRole("tab", { name: "Account", exact: true }));
    await click(page.getByRole("tab", { name: "Email account", exact: true }));
    const identity = page.locator('[role="tabpanel"] .fui-Persona__primaryText:visible');
    await identity.first().waitFor();
    const addresses = (await identity.allInnerTexts()).map((s) => s.trim().toLowerCase());
    if (addresses.length !== 1 || addresses[0] !== expected.trim().toLowerCase()) {
      throw new OutlookCalendarSourceError("source-changed");
    }
  } finally {
    const close = page.getByRole("button", { name: "Close settings", exact: true });
    await click(close);
    await close.waitFor({ state: "hidden" });
  }
}

async function displayTimeZone(page: Page): Promise<string> {
  await click(page.getByRole("button", { name: "Settings", exact: true }));
  try {
    await click(page.getByRole("tab", { name: "Calendar", exact: true }));
    const view = page.getByRole("tab", { name: "View", exact: true });
    // The ribbon may also have a View tab. The settings sub-tab is the last one.
    await click(view.last());
    const field = page.getByRole("combobox", {
      name: "Display my calendar in time zone:",
      exact: true
    });
    await field.waitFor();
    if (
      !(
        await page.getByRole("combobox", { name: "Select a language:", exact: true }).innerText()
      ).startsWith("English") ||
      !(
        await page
          .getByRole("combobox", { name: "Select a calendar type:", exact: true })
          .innerText()
      ).startsWith("Gregorian")
    ) {
      throw new OutlookCalendarSourceError("source-changed");
    }
    return outlookDisplayTimeZone(await field.inputValue());
  } finally {
    const close = page.getByRole("button", { name: "Close settings", exact: true });
    await click(close);
    await close.waitFor({ state: "hidden" });
  }
}

async function requirePrimaryCalendar(page: Page): Promise<void> {
  const open = page.getByRole("button", { name: "Show navigation pane", exact: true });
  if (await open.isVisible()) await click(open);
  const calendars = page.locator('button[role="option"][aria-selected="true"]:visible');
  await calendars.first().waitFor();
  if (
    (await calendars.count()) !== 1 ||
    !(await calendars
      .first()
      .evaluate((e) =>
        [...e.querySelectorAll("*")].some(
          (n) => n.children.length === 0 && n.textContent?.trim() === "Calendar"
        )
      ))
  ) {
    throw new OutlookCalendarSourceError("source-changed");
  }
}

interface RenderedEvent {
  readonly id: string;
  readonly label: string;
}

async function snapshot(page: Page): Promise<RenderedEvent[]> {
  return page.locator("[data-calitemid]").evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-calitemid") ?? "",
      label: node.querySelector('[role="button"]')?.getAttribute("aria-label") ?? ""
    }))
  );
}

async function readWeek(page: Page, check: () => Promise<void>): Promise<RenderedEvent[]> {
  const rows = new Map<string, RenderedEvent>();
  if (await page.locator('[role="dialog"][aria-modal="true"]:visible').count()) {
    throw new OutlookCalendarSourceError("partial");
  }
  // A supported week must expose a main region and no loading/overflow controls.
  const main = page.locator('main:visible, [role="main"]:visible');
  if ((await main.count()) !== 1) throw new OutlookCalendarSourceError("partial");
  if (await page.locator('[aria-busy="true"]:visible').count())
    throw new OutlookCalendarSourceError("partial");
  if (await main.locator('[aria-label*="more event" i]:visible').count())
    throw new OutlookCalendarSourceError("partial");
  // Traverse rendered vertical scroll areas, including hours outside the viewport.
  const scrolls = await main.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>("*")]
      .filter(
        (e) =>
          e.clientHeight > 100 &&
          e.scrollHeight > e.clientHeight + 5 &&
          /auto|scroll/.test(getComputedStyle(e).overflowY)
      )
      .map((e, i) => {
        e.setAttribute("data-moss-calendar-scroll", String(i));
        return { key: String(i), height: e.scrollHeight, viewport: e.clientHeight };
      })
  );
  if (scrolls.length > 3) throw new OutlookCalendarSourceError("partial");
  const collect = async () => {
    await check();
    const first = await snapshot(page);
    await page.waitForTimeout(350);
    const second = await snapshot(page);
    if (JSON.stringify(first) !== JSON.stringify(second))
      throw new OutlookCalendarSourceError("partial");
    for (const event of second) {
      if (
        !event.id ||
        !event.label ||
        (rows.get(event.id)?.label && rows.get(event.id)?.label !== event.label)
      ) {
        throw new OutlookCalendarSourceError("partial");
      }
      rows.set(event.id, event);
    }
    if (rows.size > 200) throw new OutlookCalendarSourceError("partial");
  };
  try {
    await collect();
    for (const scroll of scrolls) {
      const steps = Math.ceil(scroll.height / (scroll.viewport * 0.75));
      if (steps > 36) throw new OutlookCalendarSourceError("partial");
      const element = main.locator(`[data-moss-calendar-scroll="${scroll.key}"]`);
      for (let step = 0; step <= steps; step++) {
        await element.evaluate(
          (e, top) => {
            e.scrollTop = top;
          },
          step * scroll.viewport * 0.75
        );
        await collect();
      }
    }
    return [...rows.values()];
  } finally {
    await main
      .locator("[data-moss-calendar-scroll]")
      .evaluateAll((nodes) => nodes.forEach((e) => e.removeAttribute("data-moss-calendar-scroll")));
  }
}

export async function collectOutlookCalendar(
  binding: OutlookBrowserBinding,
  now: Date
): Promise<OutlookCalendarScan> {
  const endpoint = validateOutlookBrowserEndpoint(binding.endpoint);
  let activePage: Page | undefined;
  let stage: "account" | "timezone" | "calendar" | "coverage" = "account";
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 }).catch(() => {
    throw new OutlookCalendarSourceError("partial", "account");
  });
  try {
    const pages = browser
      .contexts()
      .flatMap((c) => c.pages())
      .filter((p) => {
        const url = new URL(p.url());
        return HOSTS.has(url.hostname) && url.pathname.startsWith("/calendar/");
      });
    if (pages.length !== 1) {
      if (
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .some((p) =>
            ["login.microsoftonline.com", "login.live.com"].includes(new URL(p.url()).hostname)
          )
      )
        throw new OutlookCalendarSourceError("sign-in-needed");
      throw new OutlookCalendarSourceError("source-changed");
    }
    const page = pages[0]!;
    activePage = page;
    page.setDefaultTimeout(10_000);
    // Narrow Outlook windows turn the calendar navigation into an occluding modal.
    // This collector supports the desktop layout in its dedicated browser only.
    await page.setViewportSize({ width: 1280, height: 1800 });
    // A reload discards optimistic client-only event IDs; verify the source again afterward.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(HEADER).waitFor();
    const session = await page.context().newCDPSession(page);
    await session.send("Page.enable");
    const frame = (await session.send("Page.getFrameTree")).frameTree.frame.id;
    const world = await session.send("Page.createIsolatedWorld", {
      frameId: frame,
      worldName: "moss-calendar-input-guard"
    });
    await session.send("Runtime.evaluate", {
      contextId: world.executionContextId,
      expression: `(() => {
      globalThis.__mossCalendarInterrupted = false;
      globalThis.__mossCalendarInput = event => { if (event.isTrusted) globalThis.__mossCalendarInterrupted = true; };
      for (const type of ['pointerdown','keydown','wheel','touchstart']) document.addEventListener(type, globalThis.__mossCalendarInput, true);
    })()`
    });
    const route = page.url();
    const check = async () => {
      const status = await session.send("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression: "globalThis.__mossCalendarInterrupted",
        returnByValue: true
      });
      if (status.exceptionDetails || status.result.value !== false || page.url() !== route)
        throw new OutlookCalendarSourceError("partial");
    };
    try {
      await verifyAccount(page, binding.accountAddress);
      await click(page.getByRole("button", { name: "Week", exact: true }));
      stage = "timezone";
      const timeZone = await displayTimeZone(page);
      stage = "calendar";
      await requirePrimaryCalendar(page);
      stage = "coverage";
      const today = localDayKey(now, timeZone);
      const windowStart = addCalendarDays(today, -1);
      const windowEnd = addCalendarDays(today, 31);
      const events = new Map<string, OutlookCalendarObservation>();
      let views = 0;
      let complete = false;
      let priorEnd: string | null = null;
      // A prior refresh leaves the tab at the final covered week. Allow up to
      // six backward steps plus six collected views on the next refresh.
      for (let navigation = 0; navigation < 12; navigation++) {
        const label = await page.locator(HEADER).getAttribute("aria-label");
        const week = parseOutlookWeekHeader(label ?? "");
        if (week.start > windowStart && views === 0) {
          await click(page.locator('button[aria-label^="Go to previous week"]'));
          await page.waitForFunction(
            ({ selector, prior }) =>
              document.querySelector(selector)?.getAttribute("aria-label") !== prior,
            { selector: HEADER, prior: label }
          );
          continue;
        }
        if (week.end <= windowStart || (priorEnd && week.start !== priorEnd) || views >= 6) {
          throw new OutlookCalendarSourceError("partial");
        }
        for (const row of await readWeek(page, check)) {
          const event = normalizeOutlookCalendarLabel(row.id, row.label, timeZone);
          const inView = event.allDay
            ? event.endsAt.slice(0, 10) > week.start && event.startsAt.slice(0, 10) < week.end
            : new Date(event.endsAt) > localDayRange(week.start, timeZone).start &&
              new Date(event.startsAt) < localDayRange(week.end, timeZone).start;
          if (!inView) throw new OutlookCalendarSourceError("partial");
          const afterStart = event.allDay
            ? event.endsAt.slice(0, 10) > windowStart
            : new Date(event.endsAt) > localDayRange(windowStart, timeZone).start;
          const beforeEnd = event.allDay
            ? event.startsAt.slice(0, 10) < windowEnd
            : new Date(event.startsAt) < localDayRange(windowEnd, timeZone).start;
          if (!afterStart || !beforeEnd) continue;
          const prior = events.get(event.occurrenceKey);
          if (prior && JSON.stringify(prior) !== JSON.stringify(event))
            throw new OutlookCalendarSourceError("partial");
          events.set(event.occurrenceKey, event);
        }
        if (events.size > 1000 || (await page.locator(HEADER).getAttribute("aria-label")) !== label)
          throw new OutlookCalendarSourceError("partial");
        views++;
        priorEnd = week.end;
        if (week.end >= windowEnd) {
          complete = true;
          break;
        }
        await click(page.locator('button[aria-label^="Go to next week"]'));
        await page.waitForFunction(
          ({ selector, prior }) =>
            document.querySelector(selector)?.getAttribute("aria-label") !== prior,
          { selector: HEADER, prior: label }
        );
        await page.waitForTimeout(750);
      }
      stage = "account";
      await verifyAccount(page, binding.accountAddress);
      stage = "calendar";
      await requirePrimaryCalendar(page);
      stage = "timezone";
      if ((await displayTimeZone(page)) !== timeZone)
        throw new OutlookCalendarSourceError("partial");
      stage = "coverage";
      await check();
      return {
        calendarKey: "primary",
        timeZone,
        observedAt: now.toISOString(),
        windowStart,
        windowEnd,
        complete,
        views,
        events: [...events.values()]
      };
    } finally {
      await session
        .send("Runtime.evaluate", {
          contextId: world.executionContextId,
          expression: `(() => {
        for (const type of ['pointerdown','keydown','wheel','touchstart']) document.removeEventListener(type, globalThis.__mossCalendarInput, true);
        delete globalThis.__mossCalendarInput; delete globalThis.__mossCalendarInterrupted;
      })()`
        })
        .catch(() => undefined);
      await session.detach().catch(() => undefined);
    }
  } catch (error) {
    if (
      activePage &&
      ["login.microsoftonline.com", "login.live.com"].includes(new URL(activePage.url()).hostname)
    )
      throw new OutlookCalendarSourceError("sign-in-needed", stage);
    if (error instanceof OutlookCalendarSourceError)
      throw new OutlookCalendarSourceError(error.code, stage);
    throw new OutlookCalendarSourceError("partial", stage);
  } finally {
    // For a CDP connection this disconnects the client; the signed-in browser remains open.
    await browser.close().catch(() => undefined);
  }
}
