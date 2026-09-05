// Run from the repo root with the preview server already listening (see README).
/* global document, innerWidth */
// This checks only the disposable prototype; it does not contact Moss or its database.
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const origin = process.env.WORKSHOP_PREVIEW_ORIGIN || "http://127.0.0.1:8769";
const url = `${origin}/docs/superpowers/specs/assets/2026-09-04-workshop/`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
const click = (name) => page.getByRole("button", { name, exact: true }).first().click();
const state = (value) => page.getByLabel("Try a state").selectOption(value);
const heading = (name) => expect(page.getByRole("heading", { name, exact: true })).toBeVisible();

try {
  await page.goto(url);
  await heading("Your Workshop");
  await state("empty");
  await heading("A small idea is a good start.");
  await click("New project");
  await click("Create project");
  await heading("Let’s shape your idea");
  await click("Same word all day");
  await click("Prepare plan + mockup");
  await heading("Preparing your plan");
  await expect(page.getByRole("button", { name: /Approve plan/ })).toHaveCount(0);
  await click("Complete plan");
  await heading("Review plan 1");
  // Revision approval and draft mutation stay distinct.
  await click("Add saved words");
  await click("Complete plan");
  await heading("Review plan 2");
  await click("Saved words");
  await expect(page.getByRole("region", { name: "Saved words mockup" })).toBeVisible();
  await click("Today’s word");
  await expect(page.getByRole("button", { name: "Approve plan 1 & build" })).toHaveCount(0);
  await page.locator(".artifact").screenshot({ path: "/tmp/workshop-review-desktop.png" });
  await click("Approve plan 2 & build");
  await heading("Building your draft");
  await state("question");
  await click("Yes, use my local date");
  await click("Stop build");
  await heading("Stopping the build");
  await expect(page.getByRole("button", { name: "Retry build", exact: true })).toHaveCount(0);
  await click("Confirm builder stopped");
  await heading("Build stopped");
  await click("Retry build");
  await state("failed");
  await heading("A check failed");
  await click("Retry build");
  await click("Complete build");
  await heading("Try your draft");
  await click("Save word");
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
  await click("Saved words");
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await click("Remove");
  await expect(
    page.getByText("No saved words yet. Save a word you’d like to remember.")
  ).toBeVisible();
  await click("Today’s word");
  await click("Finish privately");
  await expect(page.getByText("Finished, and still private", { exact: true })).toBeVisible();
  await click("Share with everyone…");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Share with everyone…" })).toBeFocused();
  await click("Share with everyone…");
  await click("Share module");
  await expect(page.getByText("Available to everyone in Moss", { exact: true })).toBeVisible();

  // Failed refinement must retain the earlier usable version.
  await state("draft");
  await click("Let me save words");
  await click("Complete plan");
  await click("Approve plan 2 & build");
  await state("failed");
  await heading("Previous draft · still usable");
  await expect(page.getByRole("button", { name: "Save word", exact: true })).toHaveCount(0);
  await click("Retry build");
  await click("Complete build");
  await click("Save word");
  await page.getByLabel("Message your project assistant").fill("Keep my unsent thought");
  await page.getByRole("link", { name: "← Your projects", exact: true }).click();
  await page.locator(".project-row").click();
  await expect(page.getByLabel("Message your project assistant")).toHaveValue(
    "Keep my unsent thought"
  );

  await state("handoff");
  await expect(page.getByText(/you don’t need to brief me again/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Same word all day" })).toHaveCount(0);
  await state("model");
  await heading("A reasoning model is unavailable");
  await click("Retry planning");
  await click("Complete plan");
  await heading("Review plan 1");

  // User input must be rendered as text, including when the project title is used in a link.
  await state("empty");
  await click("New project");
  await page.getByLabel("Project name").fill("<img src=x onerror=alert(1)>");
  await click("Create project");
  await expect(page.locator(".project-header img")).toHaveCount(0);

  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const value of [
      "list",
      "empty",
      "brief",
      "review",
      "building",
      "question",
      "failed",
      "stopped",
      "draft",
      "finished",
      "model"
    ]) {
      await state(value);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${value} overflows at ${width}px`
      );
      if (!["list", "empty"].includes(value)) {
        await click("Conversation");
        await expect(
          page.getByRole("region", { name: "Project conversation", exact: true })
        ).toBeVisible();
        await click(value === "review" ? "Plan + mockup" : "Project work");
        await expect(page.getByRole("region", { name: "Project work", exact: true })).toBeVisible();
      }
      // Visible interactive controls must not exceed the viewport, even with overflow clipping.
      const overflow = await page
        .locator("button, input, textarea, select")
        .evaluateAll((elements) =>
          elements
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
            })
            .map((el) => el.textContent || el.id)
        );
      assert.deepEqual(overflow, [], `${value} clipped controls at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await state("review");
  await page.locator(".artifact").screenshot({ path: "/tmp/workshop-review-mobile.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await state("draft");
  await click("Conversation");
  await page.getByLabel("Message your project assistant").focus();
  await page.keyboard.type("A keyboard-only message");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("A keyboard-only message", { exact: true })).toBeVisible();

  // Supplementary state sheet: every reviewed state renders at target widths without clipped controls.
  const statesUrl = `${origin}/docs/superpowers/specs/assets/2026-09-04-workshop/states.html`;
  await page.goto(statesUrl);
  await expect(page.getByRole("heading", { name: "Your Workshop", exact: true })).toBeVisible();
  const stateValues = await page
    .locator("#state-select option")
    .evaluateAll((options) => options.map((option) => option.value));
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    for (const value of stateValues) {
      await page.locator("#state-select").selectOption(value);
      await expect(page.locator(".state-card")).toBeVisible();
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `state ${value} overflows at ${width}px`
      );
      const overflow = await page
        .locator("button, input, textarea, select")
        .evaluateAll((elements) =>
          elements
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
            })
            .map((el) => el.textContent || el.id)
        );
      assert.deepEqual(overflow, [], `state ${value} clipped controls at ${width}px`);
    }
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await page.locator("#state-select").selectOption("send-failure");
  await page.getByLabel("Message your project assistant").fill("Retain this while I reconnect");
  await page.getByRole("button", { name: "Try sending again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Word of the Day", exact: true })).toBeVisible();
  await page.locator("#state-select").selectOption("mockup-ready");
  await page.getByRole("tab", { name: /Saved words/ }).click();
  await expect(page.getByText("No saved words yet.", { exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: full scripted journey plus ${stateValues.length} supplementary states at 320/375/414/768, retained text, MockupV1 navigation, and reduced-motion checks.`
  );
} finally {
  await browser.close();
}
