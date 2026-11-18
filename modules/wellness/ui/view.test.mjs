import assert from "node:assert/strict";
import test from "node:test";
import { moodIndex, moodBand, computeStreak, recentMoodAverage, checkinWindowSince, localDayOffset } from "./core.mjs";
import { emptyMedForm, withChoice, describeFormProblems, buildCreateRequest, medFormFromMedication } from "./meds-form.mjs";
import { medsModalHtml } from "./meds-view.mjs";
import { todaySection } from "./today.mjs";
import { historyRows, historyView } from "./history.mjs";
import { buildDays, trendsView } from "./trends.mjs";
import { checkinBody, newCheckinState, searchHits, checkinModalHtml } from "./checkin-modal.mjs";
import { heroStats } from "./hero.mjs";
import { wellnessApi } from "./api.mjs";

const TODAY = "2026-11-17";
const ck = (day, core = "happy", extra = {}) => ({ id: `${day}-${core}`, checkedInAt: `${day}T12:00:00.000Z`, feelingCore: core, feelingSecondary: "Peaceful", sensations: [], intensity: 3, note: null, ...extra });

test("mood index and band follow the core emotion and strength", () => {
  assert.ok(moodIndex("happy", 5) > 0);
  assert.ok(moodIndex("sad", 5) < 0);
  assert.equal(typeof moodBand(moodIndex("happy", 5)), "string");
});

test("streak counts completed days only, ending yesterday", () => {
  const list = [ck("2026-11-17"), ck("2026-11-16"), ck("2026-11-15"), ck("2026-11-13")];
  assert.equal(computeStreak(list, TODAY, "UTC"), 2);
  assert.equal(computeStreak([], TODAY, "UTC"), 0);
});

test("recent mood average ignores today and returns null with no data", () => {
  assert.equal(recentMoodAverage([ck(TODAY)], TODAY, "UTC"), null);
  assert.ok(recentMoodAverage([ck("2026-11-16", "happy")], TODAY, "UTC") > 0);
});

test("the window starts a day before the oldest day", () => {
  assert.equal(checkinWindowSince("2026-11-01"), "2026-10-31T00:00:00.000Z");
  assert.equal(localDayOffset(1, TODAY), "2026-11-16");
});

test("the medication form rejects what the old form rejected", () => {
  const f = emptyMedForm(TODAY);
  assert.deepEqual(describeFormProblems(f), ["Give the medication a name."]);
  assert.deepEqual(describeFormProblems({ ...f, name: "A", times: [] }), ["Add at least one time of day."]);
  assert.deepEqual(describeFormProblems({ ...f, name: "A", times: ["25:00"] }), ["Enter each time of day as a real clock time, like 08:00."]);
  assert.deepEqual(describeFormProblems({ ...withChoice({ ...f, name: "A" }, "selected_days", TODAY) }), ["Pick at least one day of the week."]);
  assert.deepEqual(describeFormProblems({ ...withChoice({ ...f, name: "A", startDate: "" }, "cycle", TODAY), startDate: "" }), ["Pick the date this starts, so the repeat has something to count from."]);
  assert.deepEqual(describeFormProblems({ ...f, name: "A", choice: "every_interval", intervalCount: 0 }), ["It has to repeat at least every one day, week or month."]);
});

test("each schedule choice builds the matching request", () => {
  const base = { ...emptyMedForm(TODAY), name: " Bupropion ", dose: "50 mg" };
  assert.deepEqual(buildCreateRequest(base), { name: "Bupropion", dosage: "50 mg", startDate: TODAY, frequencyType: "once_daily", scheduleTimes: ["08:00"], remindersEnabled: false });
  assert.equal(buildCreateRequest({ ...base, times: ["08:00", "20:00"] }).frequencyType, "times_per_day");
  assert.equal(buildCreateRequest(withChoice(base, "as_needed", TODAY)).frequencyType, "as_needed");
  const weekly = buildCreateRequest({ ...base, choice: "every_interval", intervalUnit: "weeks", weekdays: [5, 1] });
  assert.deepEqual(weekly.weekdays, [1, 5]);
  const monthly = buildCreateRequest({ ...base, choice: "monthly", monthDayIsLast: true });
  assert.equal(monthly.monthDay, null);
  assert.equal(monthly.monthDayIsLast, true);
  assert.equal(buildCreateRequest({ ...base, choice: "cycle" }).cycleAnchorDate, TODAY);
});

test("a stored medication fills the form back in", () => {
  const f = medFormFromMedication({ name: "A", dosage: "5", frequencyType: "times_per_day", scheduleTimes: ["08:00:00", "20:00:00"], scheduleStartDate: TODAY, remindersEnabled: true });
  assert.deepEqual(f.times, ["08:00", "20:00"]);
  assert.equal(f.choice, "daily");
  assert.equal(f.remindersEnabled, true);
});

test("the medications dialog escapes names and lists each medication", () => {
  const html = medsModalHtml({ loading: false, loadError: false, removeFailed: false, items: [{ id: "1", name: "<b>x</b>", dosage: null, frequencyType: "as_needed" }], form: emptyMedForm(TODAY), editingId: null, saving: false, formFailed: false });
  assert.ok(!html.includes("<b>x</b>"));
  assert.ok(html.includes("Manage medications"));
  assert.ok(html.includes("Add medication"));
});

const med = { schedule: { slots: [{ medicationId: "m", name: "Pill", status: "pending", asNeeded: false, localTime: "08:00", scheduledFor: "2026-11-17T08:00:00.000Z" }] }, scheduleError: false, saving: false, prn: { openFor: null, reason: "" }, unresolved: false, checking: false, checkFailed: false, failed: null, rechecked: false };
const base = { today: TODAY, timeZone: "UTC", checkins: [], checkinsError: false, streak: 0, med };

test("Today shows a dose row and an empty mood card", () => {
  const html = todaySection(base);
  assert.ok(html.includes("Pill"));
  assert.ok(html.includes('data-act="dose"'));
  assert.ok(html.includes("Start check-in"));
});

test("Today shows a retry when check-ins fail to load", () => {
  assert.ok(todaySection({ ...base, checkins: null, checkinsError: true }).includes("checkins-retry"));
});

test("history filters to noted sad or angry check-ins", () => {
  const items = [ck("2026-11-16", "sad", { note: "x" }), ck("2026-11-15", "happy", { note: "y" }), ck("2026-11-14", "sad")];
  assert.equal(historyRows(items, "notes").length, 1);
  assert.equal(historyRows(items, "").length, 3);
});

test("history shows loading, empty and error states", () => {
  const h = { pages: false, error: false, items: [], limit: 10, openId: null, next: null, loadingMore: false, moreError: false };
  assert.ok(historyView({ ...base, history: h, histFilter: "" }).includes("Loading check-in history"));
  assert.ok(historyView({ ...base, history: { ...h, error: true }, histFilter: "" }).includes("Could not load check-in history."));
  assert.ok(historyView({ ...base, history: { ...h, pages: true }, histFilter: "" }).includes("Your check-ins will appear here."));
});

test("trends build one entry per day with its medication share", () => {
  const days = buildDays({ range: 14, today: TODAY, timeZone: "UTC", checkins: [ck("2026-11-16")], adherence: { days: [{ date: "2026-11-16", scheduledCount: 2, takenCount: 1, doses: [] }] } });
  assert.equal(days.length, 14);
  assert.equal(days[12].medFrac, 0.5);
  assert.ok(days[13].isToday);
  const state = { ...base, trends: { range: 14, checkins: [], adherence: { days: [] }, loading: false, error: false, helpOpen: false }, chart: { hover: null, pinned: null, detailsOpen: false } };
  assert.ok(trendsView(state, days).includes("data-col"));
  assert.ok(trendsView({ ...state, trends: { ...state.trends, checkins: null, adherence: null, error: true } }, []).includes("Couldn't load trend data."));
});

test("a check-in saves the body the server expects", () => {
  const m = { ...newCheckinState({ initial: null, seed: "happy" }), feeling: "Peaceful", note: " hi " };
  assert.deepEqual(checkinBody(m), { feelingCore: "happy", feelingSecondary: "Peaceful", feelingTertiary: null, sensations: [], intensity: 3, note: "hi", identifiedVia: "wheel" });
  assert.equal(checkinBody({ ...m, editing: true }).identifiedVia, undefined);
  assert.ok(searchHits("peace").length > 0);
  assert.ok(checkinModalHtml(m).includes("Save check-in"));
});

test("the hero shows loading, no data and figures", () => {
  assert.ok(heroStats({ checkins: null, checkinsError: false }, null, 0).includes("Loading check-ins"));
  assert.ok(heroStats({ checkins: null, checkinsError: true }, null, 0).includes("Check-in statistics unavailable."));
  assert.ok(heroStats({ checkins: [] }, null, 1).includes("1<small title"));
});

test("the api follows the cursor and reports failures with a status", async () => {
  const calls = [];
  const pages = [{ checkins: [1], nextCursor: "c" }, { checkins: [2], nextCursor: null }];
  const api = wellnessApi({ request: async (m, p) => { calls.push(p); return { status: 200, body: pages.shift() }; } });
  assert.deepEqual(await api.checkinWindow("s"), [1, 2]);
  assert.equal(calls.length, 2);
  const failing = wellnessApi({ request: async () => { const e = new Error("x"); e.status = 500; e.body = {}; throw e; } });
  await assert.rejects(failing.medications(), (e) => e.status === 500);
});
