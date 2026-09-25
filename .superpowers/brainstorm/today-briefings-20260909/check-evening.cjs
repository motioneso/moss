const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(path.resolve(__dirname, "../../../node_modules/@playwright/test"));

(async () => {
  const browser = await chromium.launch();
  const out = path.join(__dirname, "captures/evening-flow");
  fs.mkdirSync(out, { recursive: true });
  const errors = [];
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    let views = 0;
    for (const width of [320, 375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const placement of ["automatic", "proposed"]) {
        await page.goto(`http://127.0.0.1:8767/?mode=evening&blocks=${placement}&plan=open`);
        await page.evaluate(() => document.fonts.ready);
        for (let phase = 0; phase < 4; phase++) {
          await page.locator(`[data-phase="${phase}"]`).click();
          const dimensions = await page.locator("#evening-planning").evaluate((el) => ({
            width: el.scrollWidth,
            client: el.clientWidth,
            right: el.getBoundingClientRect().right,
            viewport: innerWidth,
            scroll: el.querySelector(".planning-scroll").scrollWidth,
            scrollClient: el.querySelector(".planning-scroll").clientWidth
          }));
          assert(
            dimensions.width <= dimensions.client + 1 && dimensions.right <= width + 1,
            `Dialog overflows at ${width}, phase ${phase}: ${JSON.stringify(dimensions)}`
          );
          assert(
            dimensions.scroll <= dimensions.scrollClient + 1,
            `Content overflows at ${width}/${phase}`
          );
          const footer = await page.locator(".planning-footer").boundingBox();
          assert(footer.y + footer.height <= 1000, "Primary action must remain on screen");
          views++;
          if ((width === 375 || width === 1440) && placement === "automatic") {
            await page
              .locator("#evening-planning")
              .screenshot({ path: path.join(out, `${width}-${phase}.png`) });
          }
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const placement of ["automatic", "proposed"]) {
      await page.goto(`http://127.0.0.1:8767/?mode=evening&blocks=${placement}`);
      await page.getByRole("button", { name: "Tomorrow", exact: true }).click();
      await page.getByRole("button", { name: /Prepare tomorrow with Moss/ }).click();
      await page.locator('[data-reflection="correction"]').click();
      await page.locator('[data-phase="1"]').click();
      assert.match(await page.locator(".already-decided").innerText(), /Moved to tomorrow/);
      assert.equal(
        await page.locator('[data-bike="tomorrow"]').getAttribute("aria-pressed"),
        "true"
      );
      await page.locator('[data-phase="2"]').click();
      await page.locator("#planning-focus").selectOption("followup");
      await page.locator('[data-pace="light"]').click();
      assert.equal(await page.locator(".planning-side .draft-entry").count(), 1);
      assert.match(
        await page.locator(".planning-side .draft-entry").innerText(),
        /review follow-up/
      );
      await page.locator("#planning-note").fill("<script>bad()</script> Keep the afternoon light.");
      await page.getByRole("button", { name: "Add note", exact: true }).click();
      await page.getByRole("button", { name: "Leave for now", exact: true }).click();
      assert.equal(await page.locator("#evening-planning[open]").count(), 0);
      await page.getByRole("button", { name: /Continue preparing tomorrow/ }).click();
      assert.equal(await page.locator("#planning-focus").inputValue(), "followup");
      await page.locator('[data-phase="3"]').click();
      assert.equal(await page.locator('[data-include="timeline"]').isChecked(), false);
      assert.match(await page.locator(".saved-notes").innerText(), /<script>bad/);
      assert.equal(await page.locator(".review-notes script").count(), 0);
      await page.locator("#planning-scenario").selectOption("calendar");
      assert(await page.locator(".conflict-warning").isVisible());
      assert.equal(await page.locator('[data-planning-action="save"]').isEnabled(), false);
      await page.getByRole("button", { name: "Move task time to 2:30pm", exact: true }).click();
      assert.equal(await page.locator(".conflict-warning").count(), 0);
      await page.locator("#planning-scenario").selectOption("save-error");
      await page.locator('[data-planning-action="save"]').click();
      assert(await page.locator(".save-warning").isVisible());
      assert.equal(await page.locator('[data-include="timeline"]').isChecked(), false);
      await page.getByRole("button", { name: "Retry save", exact: true }).click();
      assert.match(await page.locator(".planning-conversation").innerText(), /Tomorrow is ready/);
      assert.match(
        await page.locator(".planning-side .draft-entry").innerText(),
        placement === "automatic" ? /Scheduled by Moss/ : /Proposed · not on calendar/
      );
      await page
        .getByRole("button", { name: "Preview the morning handoff ↗", exact: true })
        .click();
      assert.match(await page.locator(".planning-conversation").innerText(), /review follow-up/);
      assert.match(await page.locator(".planning-conversation").innerText(), /deliberately light/);
      await page.getByRole("button", { name: "Back to Today", exact: true }).click();
      assert.match(await page.locator(".evening-support").innerText(), /Send the review follow-up/);
      assert.match(await page.locator(".done-item").nth(1).innerText(), /still open/);
      assert.equal(
        await page
          .locator('[data-action="prepare"]')
          .evaluate((el) => el === document.activeElement),
        true
      );
    }
    await page.goto("http://127.0.0.1:8767/?mode=evening&plan=open");
    await page.locator("#planning-scenario").selectOption("no-review");
    assert.match(await page.locator(".planning-conversation").innerText(), /isn’t available/);
    await page.locator('[data-phase="3"]').click();
    await page.locator('[data-include="timeline"]').uncheck();
    await page.locator('[data-planning-action="save"]').click();
    assert.equal(await page.locator(".planning-side .draft-entry").count(), 0);
    await page.getByRole("button", { name: "Adjust this plan", exact: true }).click();
    await page.locator("#planning-start").selectOption("15:00");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /Review tomorrow’s plan/ }).click();
    assert.equal(await page.locator("#planning-start").inputValue(), "15:00");
    await page.goto("http://127.0.0.1:8767/?mode=evening&blocks=automatic&plan=open");
    await page.locator("#planning-note").fill("Keep this unsent note.");
    await page.keyboard.press("Escape");
    await page.locator("#scheduling").selectOption("proposed");
    await page.getByRole("button", { name: /Continue preparing tomorrow/ }).click();
    assert.equal(await page.locator("#planning-note").inputValue(), "Keep this unsent note.");
    await page.locator('[data-phase="3"]').click();
    assert.equal(await page.locator("#planning-note").inputValue(), "Keep this unsent note.");
    await page.getByRole("button", { name: "Save proposed plan", exact: true }).click();
    assert.match(await page.locator(".planning-side .draft-entry").innerText(), /not on calendar/);
    await page.getByRole("button", { name: "Adjust this plan", exact: true }).click();
    await page.locator('[data-phase="3"]').click();
    assert.match(await page.locator(".saved-notes").innerText(), /Keep this unsent note/);
    await page.goto("http://127.0.0.1:8767/?mode=evening&blocks=automatic&plan=open");
    await page.locator('[data-phase="3"]').click();
    await page.locator('[data-planning-action="save"]').click();
    await page.getByRole("button", { name: "Back to Today", exact: true }).click();
    await page.locator("#scheduling").selectOption("proposed");
    await page.getByRole("button", { name: /Review tomorrow’s plan/ }).click();
    await page.getByRole("button", { name: "Adjust this plan", exact: true }).click();
    await page.locator("#planning-start").selectOption("15:00");
    await page.locator('[data-phase="3"]').click();
    assert.match(await page.locator(".review-notes").innerText(), /from 1:00pm to 3:00pm/);
    assert.match(await page.locator(".planning-side .existing-plan").textContent(), /1:00pm/);
    await page
      .locator("#evening-planning")
      .screenshot({ path: path.join(out, "changed-plan-review.png") });
    await page.getByRole("button", { name: "Save proposed plan", exact: true }).click();
    assert.match(await page.locator(".planning-side .draft-entry").innerText(), /3:00pm/);
    assert.match(await page.locator(".planning-side .existing-plan").textContent(), /1:00pm/);
    await page
      .locator("#evening-planning")
      .screenshot({ path: path.join(out, "changed-plan-saved.png") });
    await page.getByRole("button", { name: "Adjust this plan", exact: true }).click();
    await page.locator('[data-phase="3"]').click();
    await page.locator('[data-include="timeline"]').uncheck();
    assert.match(await page.locator(".review-notes").innerText(), /Remove the 1:00pm block/);
    await page.getByRole("button", { name: "Save proposed plan", exact: true }).click();
    await page.getByRole("button", { name: "Preview the morning handoff ↗", exact: true }).click();
    assert.match(
      await page.locator(".planning-conversation").innerText(),
      /Existing calendar task blocks remain/
    );
    assert.doesNotMatch(await page.locator(".planning-side").innerText(), /afternoon stays open/);
    await page.setViewportSize({ width: 375, height: 1000 });
    await page
      .locator("#evening-planning")
      .screenshot({ path: path.join(out, "changed-plan-handoff-phone.png") });
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(out, "checks.json"),
      JSON.stringify(
        {
          views,
          pageErrors: errors,
          checks: [
            "draft resume",
            "prior decisions carried in",
            "reflection correction",
            "lighter day and focus",
            "partial selection",
            "calendar conflict",
            "save failure and retry",
            "both placement settings",
            "morning handoff",
            "unavailable briefing",
            "zero selected blocks",
            "literal notes",
            "Escape/focus return",
            "unsent note retained",
            "current scheduling settings honored on resume",
            "proposed moves and removals preserve existing calendar blocks"
          ]
        },
        null,
        2
      )
    );
    console.log(
      `PASS: ${views} responsive conversation views; end-to-end evening planning and recovery scenarios. Crops: ${out}`
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
