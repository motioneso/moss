/** Exercise the installed settings contract from the real signed-in browser page. */
import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";

export async function checkSettingsContract(tab: Page) {
  for (const prefix of ["/api/calendar", "/api/m/calendar"]) {
    const results = await tab.evaluate(async (prefix) => {
      const path = `${prefix}/briefing-settings`;
      const responses = [];
      for (const body of [
        {
          lookaheadDays: "1",
          prepTaskMode: ["suggest"],
          timeBlockMode: ["off"],
          blockTime: null,
          ownerUserId: "foreign",
          extra: { timeBlockMode: "auto" }
        },
        { lookaheadDays: 3, timeBlockMode: "auto" }
      ]) {
        const response = await fetch(path, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        responses.push({ status: response.status, body: await response.json() });
      }
      const [accepted, rejected] = responses;
      const persisted = await (await fetch(path)).json();
      return { accepted, rejected, persisted };
    }, prefix);
    assert.ok(results.accepted, "Missing accepted-request response");
    assert.ok(results.rejected, "Missing rejected-request response");
    assert.equal(results.accepted.status, 200);
    assert.deepEqual(results.accepted.body, {
      settings: {
        lookaheadDays: 1,
        prepTaskMode: "suggest",
        timeBlockMode: "off",
        suggestTasks: true,
        createTasks: false,
        suggestTimeBlocks: false,
        blockTime: false
      }
    });
    assert.deepEqual(results.rejected, {
      status: 400,
      body: { error: "body/lookaheadDays must be equal to one of the allowed values" }
    });
    assert.deepEqual(
      results.persisted,
      results.accepted.body,
      "Invalid PATCH changed confirmed settings"
    );
  }
  await tab.reload();
  const frame = tab.frameLocator("#calendar");
  await expect(frame.getByLabel("Look ahead", { exact: true })).toHaveValue("1");
  await expect(frame.getByLabel("Prep tasks", { exact: true })).toHaveValue("suggest");
  await expect(frame.getByLabel("Time blocks", { exact: true })).toHaveValue("off");
  console.log(
    "PASS browser settings coercion, ignored owner/extra fields, validation errors, rejection retention and reloaded controls through both URL prefixes"
  );
}
