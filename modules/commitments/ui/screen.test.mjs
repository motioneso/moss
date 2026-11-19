import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewController } from "./controller.mjs";
import { sectionHtml, snoozeUntil } from "./view.mjs";
import { commitmentsApi } from "./api.mjs";
import { reviewCardHtml } from "./review-card.mjs";

const candidate = {
  id: "candidate-one",
  title: '<img src=x onerror="bad()">',
  counterpartyLabel: "Priya & Alex",
  evidence: [{ sourceKind: "email" }]
};

test("a failed write preserves the suggestion; a confirmed write removes it", async () => {
  let fail = true;
  const calls = [];
  const api = {
    pending: async () => [candidate],
    change: async (...args) => {
      calls.push(args);
      if (fail) throw new Error();
    }
  };
  const controller = reviewController(api, () => {});
  await controller.load();
  await controller.act(candidate.id, "accepted");
  assert.equal(controller.state.rows.length, 1);
  assert.match(controller.state.error, /still here/);
  fail = false;
  await controller.act(candidate.id, "accepted");
  assert.deepEqual(calls.at(-1), [candidate.id, "accepted", undefined]);
  assert.equal(sectionHtml(controller.state), "");
});

test("snoozing uses local calendar days, not a fixed twenty-four hours", () => {
  process.env.TZ = "America/Los_Angeles";
  const now = new Date("2026-03-08T00:30:00-08:00");
  assert.equal(snoozeUntil("tomorrow", now), "2026-03-09T07:00:00.000Z");
  assert.equal(snoozeUntil("week", now), "2026-03-15T07:00:00.000Z");
  assert.equal(snoozeUntil("date", now, "2026-04-01"), "2026-04-01T07:00:00.000Z");
  assert.throws(() => snoozeUntil("date", now, "2026-02-31"));
  assert.throws(() => snoozeUntil("date", now, "2026-03-07"));
});

test("empty, loading, broken and escaped content are distinct", () => {
  assert.equal(sectionHtml({ phase: "ready" }), "");
  assert.match(sectionHtml({ phase: "loading" }), /aria-busy="true"/);
  const broken = sectionHtml({ phase: "error", error: "Unavailable" });
  assert.match(broken, /role="alert"/);
  assert.match(broken, /Try again/);
  const html = sectionHtml({ phase: "ready", rows: [candidate] });
  assert.ok(!html.includes("<img"));
  assert.match(html, /Priya &amp; Alex/);
  assert.match(html, /Email/);
  assert.doesNotMatch(html, /Settings|Details|Peek/);
});

test("detail requests remain below the bridge's pending-call limit", async () => {
  let active = 0,
    peak = 0;
  const rows = Array.from({ length: 65 }, (_, id) => ({ id: String(id) }));
  const api = commitmentsApi({
    request: async (_, path) => {
      if (path.includes("?")) return rows;
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { id: path.split("/").at(-1) };
    }
  });
  assert.equal((await api.pending()).length, 65);
  assert.ok(peak <= 8);
});

test("the review card escapes stored content and exposes only approval decisions", () => {
  const html = reviewCardHtml(
    {
      target: candidate.title,
      version: "stored-version",
      fields: [{ label: "Snooze until", value: "2026-12-01" }]
    },
    "snooze"
  );
  assert.ok(!html.includes("<img"));
  assert.match(html, /Snooze commitment/);
  assert.match(html, /2026-12-01/);
  assert.match(html, /data-decision="approve"/);
});

test("a suggestion removed during loading does not hide the remaining suggestions", async () => {
  const api = commitmentsApi({
    request: async (_, path) => {
      if (path.includes("?")) return [{ id: "removed" }, { id: "reviewed" }, { id: "pending" }];
      if (path.endsWith("removed")) throw Object.assign(new Error(), { status: 404 });
      return {
        id: path.split("/").at(-1),
        status: path.endsWith("reviewed") ? "accepted" : "pending_review"
      };
    }
  });
  assert.deepEqual(await api.pending(), [{ id: "pending", status: "pending_review" }]);
});

test("a failed chosen-date save retains the date and future-date limit", async () => {
  const controller = reviewController(
    {
      pending: async () => [candidate],
      change: async () => {
        throw new Error();
      }
    },
    () => {},
    () => new Date("2026-11-18T12:00:00")
  );
  await controller.load();
  await controller.act(candidate.id, "pick");
  await controller.act(candidate.id, "date", "2026-12-01");
  assert.equal(controller.state.pickerDate, "2026-12-01");
  assert.equal(controller.state.minimumDate, "2026-11-19");
  assert.match(sectionHtml(controller.state), /value="2026-12-01" min="2026-11-19"/);
  assert.match(sectionHtml(controller.state), /Reload suggestions/);
});
