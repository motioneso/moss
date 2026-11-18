import assert from "node:assert/strict";
import test from "node:test";
import { daysBack, confirmation, esc, formatBytes, lastHourRange, screen } from "./view.mjs";
import { backtrackApi } from "./api.mjs";

const ui = (over = {}) => ({
  now: () => new Date("2026-11-17T12:00:00Z"),
  tz: { state: "ready", timezone: "Europe/London", date: "2026-11-17" },
  confirming: null,
  choosingDay: false,
  day: "",
  pending: false,
  pausing: false,
  result: null,
  ...over
});
const data = (over = {}) => ({
  storage: "on",
  paused: false,
  macs: 1,
  days: 3,
  bytes: 2048,
  lastReceivedAt: "2026-11-17T10:00:00Z",
  ...over
});

test("main screen shows the switch, Kept and Delete", () => {
  const html = screen(data(), ui());
  assert.ok(html.includes("On · 1 Mac"));
  assert.ok(html.includes("3 days") && html.includes("2.0 KB") && html.includes("Last received"));
  assert.ok(html.includes('aria-label="Recording" checked'));
  for (const label of ["Last hour", "Today", "Choose a day…", "Everything…"]) {
    assert.ok(html.includes(label), label);
  }
});

test("paused state, empty states and storage off", () => {
  assert.ok(screen(data({ paused: true }), ui()).includes("Paused from Moss"));
  assert.ok(screen(data({ macs: 0, days: 0, bytes: 0 }), ui()).includes("No Mac is linked"));
  const off = screen(data({ storage: "off", days: 0, bytes: 0 }), ui());
  assert.ok(off.includes("storage isn&#39;t available") && !off.includes("Delete recent history"));
  const offKept = screen(data({ storage: "off" }), ui());
  assert.ok(offKept.includes("Delete recent history"));
});

test("the last hour is one hour and days count back from the account's today", () => {
  const hour = lastHourRange(new Date("2026-11-17T12:00:00Z"));
  assert.equal(Date.parse(hour.to) - Date.parse(hour.from), 3600000);
  assert.equal(daysBack("2026-11-17", "2026-11-17"), 0);
  assert.equal(daysBack("2026-11-17", "2026-11-10"), 7);
  assert.equal(daysBack("2026-03-02", "2026-02-28"), 2);
  assert.equal(daysBack("2026-11-17", "2026-11-18"), undefined);
  assert.equal(daysBack("2026-11-17", "2026-02-31"), undefined);
  assert.equal(daysBack("2026-11-17", ""), undefined);
});

test("by-day deleting is off while the time zone loads and explains a failure", () => {
  const loading = screen(data(), ui({ tz: { state: "loading", timezone: null, date: null } }));
  assert.ok(
    /data-act="today" disabled/.test(loading) && /data-act="choose" disabled/.test(loading)
  );
  assert.ok(/data-act="hour"(?! disabled)/.test(loading));
  const failed = screen(data(), ui({ tz: { state: "failed", timezone: null, date: null } }));
  assert.ok(failed.includes("Could not load your time zone, so deleting by day is off."));
  assert.ok(failed.includes('data-act="retry-tz"'));
});

test("every delete states it cannot be undone", () => {
  const range = { from: "2026-11-17T00:00:00Z", to: "2026-11-18T00:00:00Z", timezone: "UTC" };
  for (const kind of ["hour", "today", "day", "all"]) {
    assert.ok(confirmation(kind, data(), range).description.includes("can't be undone"));
  }
  assert.ok(confirmation("day", data(), range).title.startsWith("Delete Tuesday"));
  assert.ok(confirmation("all", data({ days: 1 }), {}).description.includes("1 day of"));
});

test("text from the server is escaped and the confirmation is announced", () => {
  assert.equal(esc("<b>&"), "&lt;b&gt;&amp;");
  const html = screen(
    data(),
    ui({ confirming: { title: "<i>t</i>", description: "d", action: "Go" } })
  );
  assert.ok(!html.includes("<i>t") && html.includes('role="alertdialog"'));
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("api turns refusals into errors with a status", async () => {
  const api = backtrackApi({ request: async () => ({ status: 400, body: { error: "x" } }) });
  await assert.rejects(api.remove({}), (error) => error.status === 400);
  const ok = backtrackApi({ request: async (m, p, b) => ({ status: 200, body: { m, p, b } }) });
  assert.deepEqual(await ok.setPaused(true), { m: "PUT", p: "/preferences", b: { paused: true } });
});
