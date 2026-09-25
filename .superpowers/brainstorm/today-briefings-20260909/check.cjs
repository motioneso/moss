const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(path.resolve(__dirname, "../../../node_modules/@playwright/test"));

(async () => {
  const browser = await chromium.launch();
  const out = path.join(__dirname, "captures");
  fs.mkdirSync(out, { recursive: true });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    let views = 0;
    for (const width of [320, 375, 414, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const mode of ["morning", "day", "evening"]) {
        for (const blocks of ["automatic", "proposed"]) {
          await page.goto(`http://127.0.0.1:8767/?mode=${mode}&blocks=${blocks}`);
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await page.locator("h1").count(), 1);
          const layout = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            planEnd: document.querySelector(".briefing-grid").getBoundingClientRect().bottom,
            newsStart: document.querySelector("#news").getBoundingClientRect().top,
            sportsStart: document.querySelector("#sports").getBoundingClientRect().top
          }));
          assert(layout.width <= width, `${mode}/${blocks} overflows at ${width}: ${layout.width}`);
          assert(layout.newsStart >= layout.planEnd, "News must follow the complete day plan");
          assert(layout.sportsStart > layout.newsStart, "Sports follows news");
          assert.equal(await page.locator(".score-game").count(), 4);
          assert.equal(
            await page
              .locator(".score-game")
              .first()
              .evaluate((el) => el.classList.contains("followed-game")),
            true
          );
          assert.equal(await page.locator(".tonight-games>button").count(), 3);
          assert(await page.getByRole("button", { name: "Check in", exact: true }).isVisible());
          if (mode !== "evening") assert.equal(await page.locator(".slot.task").count(), 3);
          views++;
          if ((width === 1440 || width === 375) && blocks === "automatic") {
            // Bounded viewport crops only. Full-page captures are unnecessary here.
            await page.screenshot({
              path: path.join(out, `${mode}-${width}-opening.png`),
              clip:
                width === 1440
                  ? { x: 194, y: 64, width: 1246, height: 850 }
                  : { x: 0, y: 0, width, height: 850 }
            });
            await page.locator("#news").scrollIntoViewIfNeeded();
            await page.locator("#news img").evaluate((img) => img.decode());
            await page.screenshot({
              path: path.join(out, `${mode}-${width}-news.png`),
              clip: { x: 0, y: 0, width, height: 850 }
            });
            await page
              .locator("#sports")
              .evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
            await page.locator("#sports img").evaluate((img) => img.decode());
            await page.screenshot({
              path: path.join(out, `${mode}-${width}-sports.png`),
              clip:
                width === 1440
                  ? { x: 194, y: 0, width: 1246, height: 850 }
                  : { x: 0, y: 0, width, height: 850 }
            });
          }
        }
      }
      await page.goto("http://127.0.0.1:8767/?mode=morning&night=quiet");
      assert.equal(await page.locator(".tonight-games>button").count(), 0);
      assert.match(await page.locator(".quiet-night").innerText(), /No games/);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("http://127.0.0.1:8767/?mode=morning&blocks=proposed");
    await page.locator(".medication-details summary").click();
    await page.getByRole("checkbox", { name: /Morning medication/ }).check();
    assert.equal(await page.locator(".med-count").innerText(), "1 of 2 logged");
    await page.getByRole("checkbox", { name: /Morning medication/ }).uncheck();
    assert.equal(await page.locator(".med-count").innerText(), "0 of 2 logged");
    await page.getByRole("checkbox", { name: /Daily supplement/ }).check();
    await page.getByRole("button", { name: "Check in", exact: true }).click();
    await page.getByLabel("Choose a feeling").selectOption("Calm");
    await page.getByRole("button", { name: "Save check-in", exact: true }).click();
    assert.equal(await page.locator("#checkin-status").innerText(), "Check-in recorded today.");
    assert.equal(await page.locator(".slot.proposal").count(), 3);
    await page.getByRole("button", { name: "Review task blocks", exact: true }).click();
    await page.getByRole("button", { name: "Accept all time blocks", exact: true }).click();
    assert.equal(await page.locator(".slot.proposal").count(), 0);
    await page.getByRole("button", { name: /Finish the partnership proposal/ }).click();
    assert(await page.getByRole("dialog").isVisible());
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await page.getByRole("button", { name: "Evening", exact: true }).click();
    assert.equal(await page.locator(".med-count").innerText(), "1 of 2 logged");
    assert(await page.getByRole("button", { name: "Check in again", exact: true }).isVisible());
    await page.getByRole("button", { name: "Tomorrow", exact: true }).click();
    assert.match(await page.locator("#bike-loop").innerText(), /Moved to tomorrow/);
    assert.match(await page.locator(".evening-support").innerText(), /Book the bike service/);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Choose a day", exact: true }).click();
    await page.locator("#new-date").fill("2026-09-14");
    await page.getByRole("button", { name: "Move task", exact: true }).click();
    assert.match(await page.locator("#bike-loop").innerText(), /September 14/);
    await page.getByRole("button", { name: /Prepare tomorrow with Moss/ }).click();
    await page.locator('[data-phase="2"]').click();
    await page.locator('[data-pace="light"]').click();
    await page.locator('[data-phase="3"]').click();
    await page.locator("#planning-note").fill('<img src=x onerror="throw Error(1)">');
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    assert.equal(await page.locator(".review-notes img").count(), 0);
    await page.getByRole("button", { name: "Save proposed plan", exact: true }).click();
    await page.getByRole("button", { name: "Back to Today", exact: true }).click();
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert(await page.getByRole("button", { name: /Review tomorrow’s plan/ }).isVisible());
    await page.reload();
    assert.equal(await page.locator(".med-count").innerText(), "0 of 2 logged");
    assert(await page.getByRole("button", { name: "Tomorrow", exact: true }).isVisible());
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, "checks.json"),
      JSON.stringify(
        {
          views,
          pageErrors: errors,
          checked: [
            "no horizontal overflow",
            "day plan before news and sports",
            "placed/proposed blocks",
            "details and Escape",
            "carry/reschedule/undo",
            "planning conversation",
            "literal user text",
            "reload resets",
            "multiple scores with followed teams first",
            "tonight and quiet-night states",
            "loaded news and sports photos",
            "medication logging and correction",
            "check-in and state retained across day modes"
          ]
        },
        null,
        2
      )
    );
    console.log(
      `PASS: ${views} responsive states, 6 quiet-night states, photos, wellness actions, and core preview interactions. Crops in ${out}`
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
