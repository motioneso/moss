/* global document, window, navigator */
import { moduleClient } from "./guest-bridge.mjs";
import { wellnessApi } from "./api.mjs";
import { localDayOffset, computeStreak, recentMoodAverage, checkinWindowSince } from "./core.mjs";
import { sectionHead } from "./html.mjs";
import { heroShell, heroStats, errorLine } from "./hero.mjs";
import { todaySection, todaysCheckins } from "./today.mjs";
import { historyRows, historyView } from "./history.mjs";
import { buildDays, trendsView, placeTooltip } from "./trends.mjs";
import { checkinModalHtml, newCheckinState, checkinBody, searchHits, resultsHtml } from "./checkin-modal.mjs";
import { medsModalHtml, listView, formView } from "./meds-view.mjs";
import { emptyMedForm, withChoice, medFormFromMedication, buildCreateRequest, describeFormProblems } from "./meds-form.mjs";

const client = moduleClient();
const api = wellnessApi(client);
const root = document.getElementById("root");

const state = {
  today: "",
  timeZone: "UTC",
  checkins: null,
  checkinsError: false,
  streak: 0,
  med: { schedule: null, scheduleError: false, saving: false, prn: { openFor: null, reason: "" }, unresolved: false, checking: false, checkFailed: false, failed: null, rechecked: false },
  history: { pages: false, error: false, items: [], limit: 10, openId: null, next: null, loadingMore: false, moreError: false },
  histFilter: "",
  trends: { range: 14, checkins: null, adherence: null, loading: false, error: false, helpOpen: false },
  chart: { hover: null, pinned: null, detailsOpen: false },
  modal: null
};

root.innerHTML = `<div class="wl-wrap">${heroShell()}<div id="wl-errline"></div>
  <section class="wl-sec" id="wl-today">${sectionHead("01", "Today")}<div id="wl-today-body"></div></section>
  <section class="wl-sec" id="wl-insights"></section>
  <div id="wl-trends"></div><div id="wl-history"></div>
  <section class="wl-sec" id="wl-notes"></section></div><div id="wl-modal"></div>`;
const $ = (id) => document.getElementById(id);
const tick = () => client.resize?.(document.documentElement.scrollHeight);

/* ---------- painting ---------- */

function paintHero() {
  state.streak = state.checkins ? computeStreak(state.checkins, state.today, state.timeZone) : 0;
  const avg = state.checkins ? recentMoodAverage(state.checkins, state.today, state.timeZone) : null;
  $("wl-herostats").innerHTML = heroStats(state, avg, state.streak);
  $("wl-errline").innerHTML = errorLine(state);
}
const paintToday = () => { $("wl-today-body").innerHTML = todaySection(state); };
const paintHistory = () => { $("wl-history").innerHTML = state.today ? historyView(state) : ""; };

function trendDays() {
  const t = state.trends;
  return t.checkins && t.adherence
    ? buildDays({ range: t.range, today: state.today, timeZone: state.timeZone, checkins: t.checkins, adherence: t.adherence, locale: navigator.language })
    : [];
}

function paintTrends() {
  if (!state.today) return;
  const host = $("wl-trends");
  const plot = host.querySelector(".wl-chart__plot");
  const left = plot?.scrollLeft ?? 0;
  const focusedSelect = document.activeElement?.matches?.("[data-field=inspect]");
  const days = trendDays();
  host.innerHTML = trendsView(state, days);
  const again = host.querySelector(".wl-chart__plot");
  if (again) again.scrollLeft = left;
  const active = state.chart.pinned ?? state.chart.hover;
  if (active != null && days[active]) placeTooltip(host, active, days.length, days);
  if (focusedSelect) host.querySelector("[data-field=inspect]")?.focus();
}

function paintModal() {
  const host = $("wl-modal");
  if (!state.modal) { host.innerHTML = ""; return; }
  host.innerHTML = state.modal.kind === "checkin" ? checkinModalHtml(state.modal.m) : medsModalHtml(state.modal.m);
  host.querySelector(".jds-dialog")?.focus();
}

function paintAll() { paintHero(); paintToday(); paintHistory(); paintTrends(); paintModal(); tick(); }

/* ---------- loading ---------- */

const windowSince = (days) => checkinWindowSince(localDayOffset(days, state.today));

async function loadSummary() {
  try {
    state.checkins = await api.checkinWindow(windowSince(90));
    state.checkinsError = false;
  } catch { state.checkinsError = true; }
  paintHero(); paintToday(); tick();
}

async function loadHistory(more = false) {
  const h = state.history;
  if (more) { h.loadingMore = true; h.moreError = false; } else h.error = false;
  paintHistory();
  try {
    const body = await api.checkinsPage({ limit: 50, cursor: more ? h.next : undefined });
    h.items = more ? [...h.items, ...(body.checkins ?? [])] : body.checkins ?? [];
    h.next = body.nextCursor ?? null;
    h.pages = true;
    if (more) h.limit += 10;
  } catch { if (more) h.moreError = true; else h.error = true; }
  h.loadingMore = false;
  paintHistory(); tick();
}

async function loadSchedule() {
  state.med.scheduleError = false;
  try { state.med.schedule = await api.schedule(state.today); } catch { state.med.scheduleError = true; }
  paintToday(); tick();
}

let trendRun = 0;
async function loadTrends() {
  const t = state.trends;
  const run = ++trendRun;
  t.loading = true; t.error = false;
  paintTrends();
  try {
    const [checkins, adherence] = await Promise.all([api.checkinWindow(windowSince(t.range)), api.adherence(t.range)]);
    if (run !== trendRun) return;
    t.checkins = checkins; t.adherence = adherence;
  } catch { if (run === trendRun) t.error = true; }
  if (run !== trendRun) return;
  t.loading = false;
  paintTrends(); tick();
}

const refreshAfterCheckin = () => Promise.all([loadSummary(), loadHistory(), loadTrends(), loadSchedule()]);

/* ---------- doses ---------- */

async function saveDose(input) {
  const m = state.med;
  m.saving = true; m.failed = null; m.rechecked = false;
  paintToday();
  const body = { status: input.status };
  if (input.scheduledFor) body.scheduledFor = input.scheduledFor;
  if (input.status === "prn") body.prnReason = input.prnReason || null;
  try {
    await api.logDose(input.medicationId, body);
    m.prn = { openFor: null, reason: "" };
    m.unresolved = false;
  } catch (error) {
    m.failed = input;
    if (input.status === "prn" && !Number.isInteger(error?.status)) m.unresolved = true;
  }
  m.saving = false;
  paintToday();
  await Promise.all([loadSchedule(), loadTrends()]);
}

async function recheckDoses() {
  const m = state.med;
  m.checking = true; m.checkFailed = false; paintToday();
  try {
    m.schedule = await api.schedule(state.today);
    m.unresolved = false; m.failed = null; m.rechecked = true;
  } catch { m.checkFailed = true; }
  m.checking = false; paintToday();
}

/* ---------- check-in modal ---------- */

function openCheckin({ initial = null, seed = null } = {}) {
  state.modal = { kind: "checkin", m: newCheckinState({ initial, seed }), id: initial?.id ?? null };
  paintModal();
}

async function saveCheckin() {
  const m = state.modal?.m;
  if (!m || m.saving || !(m.emotion && m.feeling)) return;
  m.saving = true; m.failed = false; paintModal();
  try {
    const body = checkinBody(m);
    if (state.modal.id) await api.changeCheckin(state.modal.id, body); else await api.createCheckin(body);
    state.modal = null; paintModal();
    await refreshAfterCheckin();
  } catch {
    if (state.modal) { m.saving = false; m.failed = true; paintModal(); }
  }
}

function pickEmotion(core, feeling = null) {
  const m = state.modal.m;
  if (m.emotion !== core) m.sensations = [];
  m.emotion = core; m.feeling = feeling;
  paintModal();
  document.querySelector("#wl-modal [data-reveal]")?.focus();
}

/* ---------- medications modal ---------- */

async function openMeds() {
  state.modal = { kind: "meds", m: { loading: true, loadError: false, removeFailed: false, items: [], form: emptyMedForm(state.today), editingId: null, saving: false, formFailed: false } };
  paintModal();
  await reloadMeds();
}

async function reloadMeds() {
  const m = state.modal?.m;
  if (!m || !("items" in m)) return;
  m.loading = true; m.loadError = false;
  repaintMedList();
  try { m.items = (await api.medications()).medications.filter((x) => x.active); } catch { m.loadError = true; }
  m.loading = false;
  repaintMedList();
}

function repaintMedList() {
  const m = state.modal?.m;
  const host = document.querySelector("[data-meds-list]");
  if (host && m) host.innerHTML = listView(m);
}
function repaintMedForm() {
  const m = state.modal?.m;
  const host = document.querySelector("[data-meds-form]");
  if (host && m) host.innerHTML = formView(m);
}

async function saveMed() {
  const m = state.modal?.m;
  if (!m || m.saving || describeFormProblems(m.form).length > 0) return;
  m.saving = true; m.formFailed = false; repaintMedForm();
  try {
    const body = buildCreateRequest(m.form);
    if (m.editingId) await api.changeMedication(m.editingId, body); else await api.createMedication(body);
    m.form = emptyMedForm(state.today); m.editingId = null;
    m.saving = false;
    repaintMedForm();
    await reloadMeds();
    loadSchedule(); loadTrends();
  } catch { m.saving = false; m.formFailed = true; repaintMedForm(); }
}

async function removeMed(id) {
  const m = state.modal?.m;
  if (!m) return;
  m.removeFailed = false;
  try {
    await api.changeMedication(id, { active: false });
    if (m.editingId === id) { m.editingId = null; m.form = emptyMedForm(state.today); repaintMedForm(); }
    await reloadMeds();
    loadSchedule(); loadTrends();
  } catch { m.removeFailed = true; repaintMedList(); }
}

/* ---------- clicks ---------- */

const closeModal = () => {
  if (!state.modal || state.modal.m.saving) return;
  state.modal = null; paintModal();
};

const toggle = (list, value) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

function medAct(act, el) {
  const m = state.modal?.m;
  if (!m || !m.form) return false;
  const f = m.form;
  const value = el.dataset.value;
  const set = (patch) => { m.form = { ...f, ...patch }; m.formFailed = false; repaintMedForm(); };
  switch (act) {
    case "med-choice": m.form = withChoice(f, value, state.today); repaintMedForm(); return true;
    case "med-unit": set({ intervalUnit: value }); return true;
    case "med-month-kind": set({ monthKind: value }); return true;
    case "med-month-pos": set({ monthWeekdayPosition: value }); return true;
    case "med-month-weekday": set({ monthWeekday: Number(value) }); return true;
    case "med-weekday": set({ weekdays: toggle(f.weekdays, Number(value)) }); return true;
    case "med-time-add": set({ times: [...f.times, ""] }); return true;
    case "med-time-remove": set({ times: f.times.filter((_, i) => i !== Number(el.dataset.i)) }); return true;
    case "med-save": void saveMed(); return true;
    case "med-cancel-edit": m.editingId = null; m.form = emptyMedForm(state.today); repaintMedForm(); return true;
    case "med-edit": {
      const med = m.items.find((x) => x.id === el.dataset.id);
      if (med) { m.editingId = med.id; m.form = medFormFromMedication(med); m.formFailed = false; repaintMedForm(); }
      return true;
    }
    case "med-remove": void removeMed(el.dataset.id); return true;
    case "med-reload": void reloadMeds(); return true;
    default: return false;
  }
}

const todayCheckinIds = () => todaysCheckins(state.checkins ?? [], state.today, state.timeZone);

function onAct(act, el) {
  const t = state.trends, h = state.history, med = state.med;
  switch (act) {
    case "open-settings": void client.navigate("/settings/wellness").catch(() => {}); return;
    case "checkins-retry": void loadSummary(); if (h.error) void loadHistory(); return;
    case "manage-open": void openMeds(); return;
    case "checkin-open": openCheckin(); return;
    case "checkin-seed": openCheckin({ seed: el.dataset.core }); return;
    case "checkin-edit-today": { const latest = todayCheckinIds()[0]; if (latest) openCheckin({ initial: latest }); return; }
    case "history-edit": { const ck = h.items.find((c) => c.id === el.dataset.id); if (ck) openCheckin({ initial: ck }); return; }
    case "history-toggle": h.openId = h.openId === el.dataset.id ? null : el.dataset.id; paintHistory(); return;
    case "history-more": {
      if (historyRows(h.items, state.histFilter).length > h.limit) { h.limit += 10; paintHistory(); } else void loadHistory(true);
      return;
    }
    case "history-retry": void loadHistory(); return;
    case "hist-clear": state.histFilter = ""; paintHistory(); return;
    case "trends-retry": void loadTrends(); return;
    case "range": t.range = Number(el.dataset.range); state.chart = { hover: null, pinned: null, detailsOpen: false }; void loadTrends(); return;
    case "help-toggle": t.helpOpen = !t.helpOpen; paintTrends(); return;
    case "schedule-retry": void loadSchedule(); return;
    case "prn-open": med.prn = { openFor: med.prn.openFor === el.dataset.med ? null : el.dataset.med, reason: "" }; paintToday(); return;
    case "prn-cancel": med.prn = { openFor: null, reason: "" }; paintToday(); return;
    case "prn-reason": med.prn.reason = el.dataset.reason; paintToday(); return;
    case "prn-log": void saveDose({ medicationId: el.dataset.med, status: "prn", prnReason: med.prn.reason.trim() }); return;
    case "prn-check": void recheckDoses(); return;
    case "dose-retry": if (med.failed) void saveDose(med.failed); return;
    case "dose": {
      if (med.saving || med.scheduleError) return;
      void saveDose({ medicationId: el.dataset.med, status: el.dataset.next, scheduledFor: el.dataset.slot || null });
      return;
    }
    case "modal-close": closeModal(); return;
    case "pick-core": if (state.modal?.kind === "checkin") pickEmotion(el.dataset.core); return;
    case "sensation": { const m = state.modal?.m; if (m) { m.sensations = toggle(m.sensations, el.dataset.value); paintModal(); } return; }
    case "pick-hit": { const hit = searchHits(state.modal.m.search)[Number(el.dataset.i)]; if (hit) { state.modal.m.search = ""; hit.isCore ? pickEmotion(hit.core) : pickEmotion(hit.core, hit.label); } return; }
    case "checkin-save": void saveCheckin(); return;
    default: medAct(act, el);
  }
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.matches("[data-scrim]") && state.modal) { closeModal(); return; }
  const col = target.closest("[data-col]");
  if (col) {
    const i = Number(col.dataset.col);
    state.chart.pinned = state.chart.pinned === i ? null : i;
    paintTrends();
    return;
  }
  if (state.chart.pinned != null && !target.closest(".wl-chart__canvas, .wl-chart-data")) {
    state.chart.pinned = null; paintTrends();
  }
  const el = target.closest("[data-act]");
  if (el && !el.hasAttribute("disabled")) onAct(el.dataset.act, el);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.modal) { closeModal(); return; }
  const row = event.target instanceof Element ? event.target.closest('[role="button"][data-act="dose"]') : null;
  if (row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onAct("dose", row); }
});

document.addEventListener("pointerover", (event) => {
  const col = event.target instanceof Element ? event.target.closest("[data-col]") : null;
  const i = col ? Number(col.dataset.col) : null;
  if (i !== state.chart.hover && event.pointerType !== "touch") { state.chart.hover = i; if (state.chart.pinned == null) paintTrends(); }
});
document.addEventListener("pointerout", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-col]") && state.chart.hover != null && event.pointerType !== "touch") {
    state.chart.hover = null; if (state.chart.pinned == null) paintTrends();
  }
});

document.addEventListener("input", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLElement)) return;
  const field = el.dataset.field;
  if (field === "note" && state.modal?.kind === "checkin") state.modal.m.note = el.value;
  else if (field === "search" && state.modal?.kind === "checkin") {
    state.modal.m.search = el.value;
    const results = document.querySelector("[data-results]");
    if (results) { results.innerHTML = resultsHtml(el.value); results.hidden = el.value.trim() === ""; }
  } else if (field === "prn-reason") state.med.prn.reason = el.value;
  else if (el.dataset.mfield && state.modal?.m?.form) {
    const f = state.modal.m.form;
    const key = el.dataset.mfield;
    const asNumber = () => (el.value === "" ? NaN : Number(el.value));
    if (key === "time") f.times = f.times.map((t, i) => (i === Number(el.dataset.i) ? el.value : t));
    else if (["intervalCount", "monthDay", "cycleDaysOn", "cycleDaysOff"].includes(key)) f[key] = asNumber();
    else if (key === "monthDayIsLast" || key === "remindersEnabled") f[key] = el.checked;
    else f[key] = el.value;
    state.modal.m.formFailed = false;
    if (key === "monthDayIsLast") repaintMedForm();
    else refreshFormActions();
  }
});

function refreshFormActions() {
  const m = state.modal?.m;
  const save = document.querySelector('[data-act="med-save"]');
  if (!m || !save) return;
  const problems = describeFormProblems(m.form);
  save.disabled = problems.length > 0 || m.saving;
  let message = document.querySelector(".wl-medmodal__error");
  if (problems[0]) {
    if (!message) { message = document.createElement("span"); message.className = "wl-medmodal__error"; message.setAttribute("role", "alert"); save.parentElement.append(message); }
    message.textContent = problems[0];
  } else message?.remove();
}

document.addEventListener("change", (event) => {
  const el = event.target;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return;
  if (el.matches("[data-field=inspect]")) {
    state.chart.pinned = el.value === "" ? null : Number(el.value); paintTrends(); return;
  }
  if (state.modal?.kind !== "checkin") return;
  const m = state.modal.m;
  if (el.name === "checkin-core") pickEmotion(el.value);
  else if (el.name === "checkin-feeling") { m.feeling = el.value; paintModal(); document.querySelector("#wl-modal [data-reveal]")?.focus(); }
  else if (el.name === "checkin-intensity") { m.intensity = Number(el.value); paintModal(); }
});

document.addEventListener("toggle", (event) => {
  if (event.target instanceof Element && event.target.matches("[data-details]")) state.chart.detailsOpen = event.target.open;
}, true);

/* ---------- optional neighbours (insights, notes, export) ---------- */

async function mountNeighbours() {
  const optional = (name) => import(name).catch(() => null);
  const [insights, notes, exporter] = await Promise.all([optional("./insights.mjs"), optional("./notes.mjs"), optional("./export.mjs")]);
  if (insights) {
    insights.renderInsights($("wl-insights"), {
      api,
      onReviewNotes: () => { state.histFilter = "notes"; paintHistory(); $("wl-history").scrollIntoView?.({ block: "start" }); }
    });
  }
  if (notes) notes.renderTherapyNotes($("wl-notes"), { api, locale: {} });
  if (exporter) {
    const slot = $("wl-export-slot");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "jds-btn jds-btn--quiet jds-btn--sm";
    button.textContent = "Export";
    button.addEventListener("click", () => exporter.openExportDialog({ api, save: client.save, today: state.today, returnFocus: button }));
    slot.append(button);
  }
  tick();
}

/* ---------- start ---------- */

async function start() {
  paintHero(); paintToday();
  try {
    const day = await api.localDay();
    state.today = day.date; state.timeZone = day.timezone || "UTC";
  } catch {
    state.checkinsError = true; paintHero(); paintToday();
    $("wl-today-body").insertAdjacentHTML("beforeend", `<p role="alert">Could not reach Wellness. <button type="button" class="jds-btn jds-btn--link" data-act="reload-page">Try again</button></p>`);
    return;
  }
  void mountNeighbours();
  await Promise.all([loadSummary(), loadHistory(), loadSchedule(), loadTrends()]);
}
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest('[data-act="reload-page"]')) window.location.reload();
});

new ResizeObserver(tick).observe(document.body);
void start();
