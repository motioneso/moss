// S1 probe: one collector run (or account learn) against a relayed DevTools endpoint.
// Prints only an outcome line. Never prints event content or the account address.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

import { collectOutlookCalendar } from "../src/outlook-calendar-browser.ts";
import { collectOutlookCalendar as collectWithMenu } from "./collector-menu.ts";
import { OutlookCalendarSourceError } from "../src/outlook-calendar-source.ts";

const [mode, endpoint, accountFile] = process.argv.slice(2) as [string, string, string];

async function learn(): Promise<void> {
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  try {
    const find = () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /outlook\.(office|cloud\.microsoft)/.test(new URL(p.url()).hostname));
    let page = find();
    for (let i = 0; !page && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      page = find();
    }
    if (!page) {
      console.error(
        browser.contexts().length,
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .map((p) => new URL(p.url()).hostname)
      );
      throw new Error("no-outlook-page");
    }
    page.setDefaultTimeout(10_000);
    const click = async (loc: ReturnType<typeof page.getByRole>) => {
      await loc.waitFor({ state: "visible" });
      await loc.evaluate((el) => {
        (el as HTMLElement).focus();
        (el as HTMLElement).click();
      });
    };
    if (
      !(await page
        .getByRole("button", { name: "Settings", exact: true })
        .or(page.getByRole("menuitem", { name: "Settings" }))
        .isVisible())
    ) {
      await click(page.getByRole("button", { name: "Access additional features", exact: true }));
    }
    await click(
      page
        .getByRole("button", { name: "Settings", exact: true })
        .or(page.getByRole("menuitem", { name: "Settings" }))
    );
    await click(page.getByRole("tab", { name: "Account", exact: true }));
    await click(page.getByRole("tab", { name: "Email account", exact: true }));
    const identity = page.locator('[role="tabpanel"] .fui-Persona__primaryText:visible');
    await identity.first().waitFor();
    const texts = (await identity.allInnerTexts()).map((s) => s.trim().toLowerCase());
    if (texts.length !== 1) throw new Error("identity-count");
    writeFileSync(accountFile, texts[0]!, { mode: 0o600 });
    chmodSync(accountFile, 0o600);
    await click(page.getByRole("button", { name: "Close settings", exact: true }));
    console.log("learn ok");
  } finally {
    await browser.close();
  }
}

async function scan(collect: typeof collectOutlookCalendar): Promise<void> {
  if (!existsSync(accountFile)) {
    console.log("fail code=no-account");
    return;
  }
  try {
    const result = await collect(
      { endpoint, accountAddress: readFileSync(accountFile, "utf8").trim() },
      new Date()
    );
    console.log(
      `ok complete=${result.complete} views=${result.views} events=${result.events.length}`
    );
  } catch (error) {
    if (error instanceof OutlookCalendarSourceError) {
      const e = error as unknown as { code?: string; stage?: string; message?: string };
      console.log(`fail code=${e.code ?? e.message ?? "unknown"} stage=${e.stage ?? "-"}`);
    } else {
      console.log("fail code=unexpected");
    }
  }
}

async function mail(): Promise<void> {
  // Opens the inbox in a throwaway tab and reports only a row count. No row text is read.
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
  try {
    const context = browser.contexts()[0];
    if (!context) {
      console.log("fail code=no-context");
      return;
    }
    const page = await context.newPage();
    try {
      await page.goto("https://outlook.office.com/mail/", { timeout: 30_000 }).catch(() => {});
      const rows = page.locator('[role="listbox"] [role="option"]');
      const found = await rows
        .first()
        .waitFor({ timeout: 30_000 })
        .then(
          () => true,
          () => false
        );
      const host = new URL(page.url()).hostname;
      if (found) {
        console.log(`ok messages=${await rows.count()}`);
      } else if (/login\.(microsoftonline|live)\.com/.test(host)) {
        console.log("fail code=sign-in-needed");
      } else {
        console.log("fail code=inbox-not-found");
      }
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

await (mode === "mail"
  ? mail()
  : mode === "learn"
    ? learn()
    : mode === "scan-menu"
      ? scan(collectWithMenu)
      : scan(collectOutlookCalendar));
process.exit(0);
