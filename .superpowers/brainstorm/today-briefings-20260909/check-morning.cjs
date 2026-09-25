const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(path.resolve(__dirname, "../../../node_modules/@playwright/test"));
(async () => {
  const browser = await chromium.launch();
  const out = path.join(__dirname, "captures/morning-flow");
  fs.mkdirSync(out, { recursive: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    let views = 0;
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const blocks of ["automatic", "proposed"]) {
        await page.goto(`http://127.0.0.1:8767/?mode=morning&blocks=${blocks}&brief=open`);
        await page.evaluate(() => document.fonts.ready);
        for (const phase of ["read", "review"]) {
          await page.locator(`.morning-nav [data-morning="${phase}"]`).click();
          const bounds = await page.locator("#morning-briefing").evaluate((el) => ({
            width: el.scrollWidth,
            client: el.clientWidth,
            right: el.getBoundingClientRect().right,
            scroll: el.querySelector(".planning-scroll").scrollWidth,
            scrollClient: el.querySelector(".planning-scroll").clientWidth
          }));
          assert(
            bounds.width <= bounds.client + 1 && bounds.right <= width + 1,
            `Dialog overflow ${width}/${blocks}/${phase}`
          );
          assert(
            bounds.scroll <= bounds.scrollClient + 1,
            `Content overflow ${width}/${blocks}/${phase}`
          );
          const footer = await page.locator("#morning-briefing .planning-footer").boundingBox();
          assert(footer.y + footer.height <= 1000, "Footer stays visible");
          views++;
          if (width === 375 || width === 1440)
            await page
              .locator("#morning-briefing")
              .screenshot({ path: path.join(out, `${width}-${blocks}-${phase}.png`) });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("http://127.0.0.1:8767/?mode=morning&blocks=proposed&brief=open");
    await page.locator(".morning-change summary").click();
    assert.match(await page.locator(".morning-change details").innerText(), /6:12am/);
    await page.locator('[data-morning-doc="proposal"]').click();
    assert.match(await page.locator(".planning-conversation").innerText(), /Pricing comparison/i);
    await page.locator('[data-morning="read"]').last().click();
    await page.locator('.morning-nav [data-morning="review"]').click();
    await page.locator('[data-morning-status="0"]').selectOption("scheduled");
    await page.locator('[data-morning-time="0"]').selectOption("09:00");
    assert(await page.locator(".conflict-warning").isVisible());
    assert.equal(await page.locator('[data-morning="save"]').isEnabled(), false);
    await page.locator('[data-morning-time="2"]').selectOption("10:45");
    assert.equal(await page.locator(".conflict-warning").count(), 0);
    assert.match(await page.locator(".planning-side").innerText(), /To schedule/);
    await page.locator('[data-morning-status="6"]').selectOption("list");
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator('[data-action="briefing"]')
        .evaluate((el) => el === document.activeElement),
      true
    );
    assert.equal(
      await page.locator(".slot.proposal").count(),
      3,
      "Unapplied draft does not change Today"
    );
    await page.getByRole("button", { name: "Review task blocks", exact: true }).click();
    assert.equal(await page.locator('[data-morning-time="0"]').inputValue(), "09:00");
    await page.locator("#morning-scenario").selectOption("save-error");
    await page.locator('[data-morning="save"]').click();
    assert(await page.locator(".save-warning").isVisible());
    assert.equal(await page.locator('[data-morning-status="6"]').inputValue(), "list");
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    assert.equal(await page.locator("#morning-briefing[open]").count(), 0);
    assert.equal(await page.locator(".slot.task").count(), 2);
    assert.equal(await page.locator(".slot.proposal").count(), 1);
    assert.match(await page.locator(".plan-note").innerText(), /1 task block is on your calendar/);
    assert.match(await page.locator("main .morning-unscheduled").innerText(), /Capture notes/);
    assert.match(await page.locator(".masthead-summary").innerText(), /9:00am/);
    assert.match(await page.locator(".support-section>p").first().innerText(), /10:45am/);
    assert.match(await page.locator('[data-doc="Proposal outline"]').innerText(), /9:00am/);
    await page.locator('[data-slot="0"]').click();
    assert.match(await page.locator("#detail-content").innerText(), /09:00–10:30/);
    await page.keyboard.press("Escape");
    await page.locator('[data-action="briefing"]').click();
    assert.match(
      await page.locator(".planning-conversation").innerText(),
      /follow-up stays on your task list/
    );
    await page.locator("#morning-scenario").selectOption("unavailable");
    assert.match(await page.locator(".planning-conversation").innerText(), /briefing isn’t ready/);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    assert.match(await page.locator(".morning-lead").innerText(), /Last night/);
    await page.locator("#morning-scenario").selectOption("no-evening");
    assert.doesNotMatch(await page.locator(".morning-lead").innerText(), /Last night/);
    await page.locator("#morning-scenario").selectOption("email-delayed");
    assert.match(await page.locator(".planning-warning").innerText(), /hasn’t updated/);
    await page.getByRole("button", { name: "Refresh email", exact: true }).click();
    assert.equal(await page.locator(".planning-warning").count(), 0);
    await page.locator('.morning-nav [data-morning="review"]').click();
    await page.locator('[data-morning-status="0"]').selectOption("list");
    assert.match(await page.locator(".morning-diff").innerText(), /Remove the calendar block/);
    await page
      .locator("#morning-briefing")
      .screenshot({ path: path.join(out, "partial-review.png") });
    await page.locator('[data-morning="save"]').click();
    assert.match(await page.locator(".masthead-summary").innerText(), /due today/);
    assert.match(await page.locator("main .morning-unscheduled").innerText(), /Due today/);
    await page.locator("#scheduling").selectOption("automatic");
    assert.equal(
      await page.locator(".slot.proposal").count(),
      1,
      "Changing settings does not silently accept saved proposals"
    );
    await page.goto("http://127.0.0.1:8767/?mode=morning&blocks=automatic&brief=open");
    assert.equal(
      await page.locator(".morning-placement").count(),
      0,
      "Automatic plan needs no acceptance"
    );
    await page.locator('.morning-nav [data-morning="review"]').click();
    assert.equal(
      await page.locator('[data-morning="save"]').isEnabled(),
      false,
      "No-op save disabled"
    );
    await page.locator('[data-morning-time="6"]').selectOption("15:00");
    assert.match(await page.locator(".conflict-warning").innerText(), /Team check-in/);
    await page.getByRole("button", { name: "Use the prepared times", exact: true }).click();
    assert.equal(await page.locator(".conflict-warning").count(), 0);
    for (const id of [0, 2, 6])
      await page.locator(`[data-morning-status="${id}"]`).selectOption("list");
    await page.locator('[data-morning="save"]').click();
    assert.equal(await page.locator(".slot.task").count(), 0);
    assert.equal(await page.locator(".slot.event").count(), 5, "Fixed commitments preserved");
    await page.goto("http://127.0.0.1:8767/?mode=morning&blocks=automatic&brief=open");
    await page.locator('.morning-nav [data-morning="review"]').click();
    await page.locator('[data-morning-time="0"]').selectOption("09:00");
    await page.locator('[data-morning-time="2"]').selectOption("10:45");
    await page.keyboard.press("Escape");
    await page.locator("#scheduling").selectOption("proposed");
    await page.getByRole("button", { name: "Review task blocks", exact: true }).click();
    assert.equal(await page.locator('[data-morning-time="0"]').inputValue(), "09:00");
    assert.equal(await page.locator('[data-morning-status="0"]').inputValue(), "proposed");
    assert.match(await page.locator(".morning-diff").innerText(), /Keep .* proposed at 9:00am/);
    await page.goto("http://127.0.0.1:8767/?mode=morning&blocks=proposed&brief=open");
    assert.equal(await page.locator("#briefing-news").count(), 1);
    assert.equal(await page.locator("#briefing-sports").count(), 1);
    assert.match(await page.locator("#briefing-sports").innerText(), /Mariners.*5–3/s);
    assert.match(await page.locator("#briefing-sports").innerText(), /Storm.*84–79/s);
    assert.match(await page.locator(".morning-tonight").innerText(), /6:40pm/);
    await page.getByRole("button", { name: "Accept all time blocks", exact: true }).click();
    assert.equal(
      await page.locator("#morning-briefing[open]").count(),
      1,
      "Acceptance keeps the briefing open"
    );
    assert.equal(await page.locator("main .slot.proposal").count(), 0);
    assert.equal(await page.locator('#morning-briefing [data-morning="accept-all"]').count(), 0);
    await page.locator('[data-morning-jump="news"]').click();
    await page.locator("#briefing-news img").evaluate((img) => img.decode());
    await page.locator("#morning-briefing").screenshot({ path: path.join(out, "1440-news.png") });
    await page.locator('[data-morning-coverage="news"]').uncheck();
    assert.equal(await page.locator("#briefing-news").count(), 0);
    assert.equal(await page.locator("#briefing-sports").count(), 1);
    await page.locator('[data-morning-coverage="sports"]').uncheck();
    assert.equal(await page.locator(".morning-world").count(), 0);
    await page.keyboard.press("Escape");
    await page.locator('[data-action="briefing"]').click();
    assert.equal(
      await page.locator(".morning-world").count(),
      0,
      "Coverage choices survive reopening"
    );
    await page.locator('[data-morning-coverage="sports"]').check();
    await page.locator('[data-morning-coverage="news"]').check();
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.locator('[data-morning-jump="sports"]').click();
    await page.locator("#briefing-sports img").evaluate((img) => img.decode());
    await page.locator("#morning-briefing").screenshot({ path: path.join(out, "375-sports.png") });
    await page.locator('[data-morning-world="sports"]').click();
    assert.equal(await page.locator("#morning-briefing[open]").count(), 0);
    assert.equal(
      await page
        .locator("#sports button")
        .first()
        .evaluate((el) => el === document.activeElement),
      true
    );
    await page.goto("http://127.0.0.1:8767/?mode=morning&blocks=proposed&brief=open&night=quiet");
    assert.match(await page.locator(".morning-tonight").innerText(), /No games/);
    await page.locator("#morning-scenario").selectOption("save-error");
    await page.getByRole("button", { name: "Accept all time blocks", exact: true }).click();
    assert.equal(
      await page.locator("main .slot.proposal").count(),
      3,
      "Failed bulk acceptance changes nothing"
    );
    assert(await page.locator(".save-warning").isVisible());
    await page.getByRole("button", { name: "Retry save", exact: true }).click();
    assert.equal(await page.locator("main .slot.proposal").count(), 0);
    await page.goto("http://127.0.0.1:8767/?mode=morning&blocks=proposed&brief=open");
    await page.locator('.morning-nav [data-morning="review"]').click();
    await page.locator('[data-morning-status="6"]').selectOption("list");
    await page.locator('[data-morning-time="0"]').selectOption("09:00");
    assert.equal(
      await page.getByRole("button", { name: "Accept all time blocks", exact: true }).isEnabled(),
      false
    );
    await page.locator('[data-morning-time="2"]').selectOption("10:45");
    await page.getByRole("button", { name: "Accept all time blocks", exact: true }).click();
    assert.equal(
      await page.locator("main .slot.task").count(),
      2,
      "Bulk action preserves explicit unscheduling"
    );
    assert.equal(await page.locator("main .slot.proposal").count(), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, "checks.json"),
      JSON.stringify(
        {
          views,
          pageErrors: errors,
          checks: [
            "reading and sources",
            "preparation materials",
            "partial acceptance",
            "adjustment and conflicts",
            "retained draft",
            "save retry",
            "Today schedule and preparation update",
            "updated task details",
            "no evening plan",
            "unavailable briefing and retry",
            "delayed email",
            "unscheduled tasks keep deadlines",
            "automatic mode needs no approval",
            "one-click accept all and recovery",
            "bulk acceptance respects conflicts and unscheduled tasks",
            "news/sports default on and independent opt-outs",
            "photos and followed-team prose",
            "tonight and quiet night",
            "news/sports links return to Today sections",
            "draft times survive preference changes",
            "saved choices survive preference changes",
            "zero task blocks keeps calendar commitments"
          ]
        },
        null,
        2
      )
    );
    console.log(
      `PASS: ${views} responsive morning views and interaction/recovery scenarios. Crops: ${out}`
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
