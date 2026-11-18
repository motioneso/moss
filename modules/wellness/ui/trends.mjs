// Section 03: the mood and medication chart.
import { EMOTIONS, MOOD_BAND_LABELS, coreLabel, localDay, localDayOffset, moodBand, moodIndex } from "./core.mjs";
import { button, esc, icons, sectionHead, signed } from "./html.mjs";

const VW = 760;
const LEFT = 44;
const RIGHT = 12;
const MOOD_TOP = 16;
const MOOD_H = 148;
const MOOD_BOT = MOOD_TOP + MOOD_H;
const DIVIDER = MOOD_BOT + 16;
const MARK_TOP = DIVIDER + 9;
const MARK_H = 22;
const MARK_MID = MARK_TOP + MARK_H / 2;
const H = MARK_TOP + MARK_H + 18;
const PLOT_W = VW - LEFT - RIGHT;

export const avgMood = (cks) =>
  cks.length === 0 ? null : Math.round((cks.reduce((s, c) => s + moodIndex(c.feelingCore, c.intensity ?? 3), 0) / cks.length) * 10) / 10;

function shortLabel(day, locale) {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

/** One point per day in the window, oldest first. */
export function buildDays({ range, today, timeZone, checkins, adherence, locale }) {
  const byDay = new Map();
  for (const c of checkins) {
    const d = localDay(c.checkedInAt ?? c.createdAt ?? "", timeZone);
    if (d) byDay.set(d, [...(byDay.get(d) ?? []), c]);
  }
  const summary = new Map((adherence?.days ?? []).map((d) => [d.date, d]));
  return Array.from({ length: range }, (_, i) => {
    const date = localDayOffset(range - 1 - i, today);
    const s = summary.get(date);
    const list = byDay.get(date) ?? [];
    return {
      date, label: shortLabel(date, locale), isToday: date === today,
      checkin: list[0] ?? null, checkins: list,
      medFrac: s && s.scheduledCount > 0 ? s.takenCount / s.scheduledCount : 0,
      medTaken: s?.takenCount ?? 0, medDenom: s?.scheduledCount ?? 0, doses: s?.doses ?? []
    };
  });
}

export function dayDescription(day) {
  const mood = avgMood(day.checkins);
  const moodText = mood === null ? "No check-in" : `Mood index ${mood}. ${day.checkin?.feelingCore ?? ""}${day.checkin?.feelingSecondary ? `, ${day.checkin.feelingSecondary}` : ""}`;
  const doses = (day.doses ?? []).filter((d) => !d.prn).map((d) => `${d.name}: ${d.status}`).join(". ");
  return `${day.date}. ${moodText}. Medication: ${day.medTaken} of ${day.medDenom} taken${day.isToday ? " so far" : ""}.${doses ? ` ${doses}.` : ""}`;
}

const xOf = (i, n) => LEFT + ((i + 0.5) / n) * PLOT_W;
const moodY = (v) => MOOD_TOP + (1 - (v + 5) / 10) * MOOD_H;

function tooltip(d, pinned) {
  const v = avgMood(d.checkins);
  const top = d.checkin && v !== null
    ? `<div class="big" style="display:flex;align-items:center;gap:7px"><span class="sw" style="width:9px;height:9px;border-radius:9px;background:var(--wellness-${d.checkin.feelingCore}-tint)"></span>${coreLabel(d.checkin.feelingCore)}${d.checkin.feelingSecondary ? ` · ${esc(d.checkin.feelingSecondary)}` : ""}</div>
       <div class="wl-tiprow" style="justify-content:space-between"><span>Mood index</span><strong style="font-variant-numeric:tabular-nums">${signed(v)} · ${MOOD_BAND_LABELS[moodBand(v)]}</strong></div>`
    : `<div class="big">${d.isToday ? "No check-in yet" : "No check-in"}</div>`;
  const doses = (d.doses ?? []).filter((x) => !x.prn).map((x) => `<div class="wl-tiprow" style="opacity:${x.status === "taken" ? 1 : 0.5}"><span>${esc(x.name)}</span><span style="text-transform:capitalize">${esc(x.status)}</span></div>`).join("");
  return `<div aria-hidden="true" class="wl-chart__tip is-on${pinned ? " is-pinned" : ""}" data-tip>
    <div class="d">${d.isToday ? `Today · ${esc(d.label)}` : esc(d.label)}</div>${top}<div class="wl-tipdiv"></div>
    <div class="wl-tiprow" style="justify-content:space-between"><span style="opacity:.75">Medication</span><strong style="font-variant-numeric:tabular-nums">${d.medTaken}/${d.medDenom}${d.isToday ? " so far" : " taken"}</strong></div>
    ${doses}${pinned ? `<div class="wl-tiprow wl-tiprow--more">Click the day again to dismiss</div>` : ""}</div>`;
}

export function chartView(days, chart) {
  const n = days.length;
  const colW = PLOT_W / n;
  const active = chart.pinned ?? chart.hover;
  const step = n <= 16 ? 2 : 5;
  const guides = [5, 2.5, 0, -2.5, -5].map((g) => `<line x1="${LEFT}" y1="${moodY(g)}" x2="${VW - RIGHT}" y2="${moodY(g)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="${g === 0 ? "0" : "2 4"}" opacity="${g === 0 ? 1 : 0.7}"/>`).join("");
  const pts = days.map((d, i) => ({ i, d, v: avgMood(d.checkins) })).filter((p) => p.v !== null);
  const line = pts.map((p, k) => `${k ? "L" : "M"}${xOf(p.i, n)} ${moodY(p.v)}`).join(" ");
  const dots = pts.map((p) => `<circle cx="${xOf(p.i, n)}" cy="${moodY(p.v)}" r="${active === p.i ? 6 : 4.4}" fill="var(--wellness-${p.d.checkin.feelingCore}-tint)" stroke="var(--surface)" stroke-width="1.5" opacity="${active == null || active === p.i ? 1 : 0.45}"/>`).join("");
  const marks = days.map((d, i) => {
    const op = d.isToday ? 0.5 : 1;
    const mark = d.medFrac <= 0 ? "" : d.medFrac >= 0.999
      ? `<circle cx="${xOf(i, n)}" cy="${MARK_MID}" r="3.7" fill="var(--accent-fg)" opacity="${op}"/>`
      : `<circle cx="${xOf(i, n)}" cy="${MARK_MID}" r="3.3" fill="var(--accent-fg)" opacity="${(0.34 + 0.4 * d.medFrac) * op}"/>`;
    return `<g opacity="${active != null && active !== i ? 0.34 : 1}">${mark}</g>`;
  }).join("");
  const labels = days.map((d, i) => (i % step === 0 || d.isToday ? `<text x="${xOf(i, n)}" y="${H - 3}" text-anchor="middle" class="wl-axislbl">${d.isToday ? "Today" : esc(d.label)}</text>` : "")).join("");
  const cols = days.map((_, i) => `<rect x="${xOf(i, n) - colW / 2}" y="0" width="${colW}" height="${H}" fill="transparent" style="cursor:pointer" data-col="${i}"/>`).join("");
  const band = active != null ? `<rect x="${xOf(active, n) - colW / 2}" y="${MOOD_TOP - 6}" width="${colW}" height="${H - MOOD_TOP}" rx="5" fill="var(--surface-2)"/>` : "";
  const options = days.map((d, i) => `<option value="${i}"${chart.pinned === i ? " selected" : ""}>${d.date}${d.isToday ? " · Today" : ""}</option>`).join("");
  const rows = days.map((d) => `<tr><th scope="row">${d.date}</th><td>${avgMood(d.checkins) ?? "No check-in"}</td><td>${d.medTaken} of ${d.medDenom}</td></tr>`).join("");
  return `<div class="wl-chart__plot" role="region" aria-label="Mood and medication chart" tabindex="0"><div class="wl-chart__canvas">
      <svg viewBox="0 0 ${VW} ${H}" role="img" aria-label="Mood trend with daily medication adherence">
        ${guides}
        <text x="${LEFT - 8}" y="${moodY(5) + 3}" text-anchor="end" class="wl-axislbl">Bright</text>
        <text x="${LEFT - 8}" y="${moodY(0) + 3}" text-anchor="end" class="wl-axislbl">Even</text>
        <text x="${LEFT - 8}" y="${moodY(-5) + 3}" text-anchor="end" class="wl-axislbl">Heavy</text>
        ${band}<path d="${line}" fill="none" stroke="var(--text-faint)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}
        <line x1="${LEFT}" y1="${DIVIDER}" x2="${VW - RIGHT}" y2="${DIVIDER}" stroke="var(--border)" stroke-width="1"/>
        <text x="${LEFT - 8}" y="${MARK_MID + 3}" text-anchor="end" class="wl-axislbl wl-axislbl--med">Meds</text>
        ${marks}${labels}${cols}
      </svg>${active != null && days[active] ? tooltip(days[active], chart.pinned === active) : ""}</div></div>
    <div class="wl-chart-data"><label for="wl-inspect">Inspect a day</label>
      <select id="wl-inspect" class="jds-select" data-field="inspect"><option value="">Choose a day</option>${options}</select>
      ${chart.pinned != null && days[chart.pinned] ? `<p role="status">${esc(dayDescription(days[chart.pinned]))}</p>` : ""}
      <details data-details${chart.detailsOpen ? " open" : ""}><summary>View daily values</summary><table><caption>Mood and medication observations</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Mood index</th><th scope="col">Medication taken</th></tr></thead><tbody>${rows}</tbody></table></details></div>`;
}

/** Puts the tooltip beside its day, clamped to the chart, after the markup is in place. */
export function placeTooltip(root, index, count, days) {
  const tip = root.querySelector("[data-tip]");
  const canvas = root.querySelector(".wl-chart__canvas");
  if (!tip || !canvas || index == null) return;
  const scale = canvas.clientWidth / VW;
  const px = xOf(index, count) * scale;
  const mood = avgMood(days[index].checkins);
  const py = (mood === null ? MOOD_TOP + 10 : moodY(mood)) * scale;
  tip.style.left = `${Math.max(0, Math.min(canvas.clientWidth - tip.offsetWidth, px - tip.offsetWidth / 2))}px`;
  tip.style.top = `${Math.max(0, Math.min(canvas.clientHeight - tip.offsetHeight, py - tip.offsetHeight))}px`;
}

export function trendsView(state, days) {
  const t = state.trends;
  const has = Boolean(t.checkins && t.adherence);
  const retry = button("Try again", { act: "trends-retry", variant: "link", size: "md" });
  const status = t.error
    ? `<p role="status">${has ? "Couldn't refresh trend data. Showing the last loaded data." : "Couldn't load trend data."} ${retry}</p>`
    : !has && t.loading ? `<p role="status">Loading trend data…</p>`
    : !has ? `<p role="status">Trend data unavailable. ${retry}</p>` : "";
  const seg = `<div class="jds-segmented" role="group" aria-label="Chart range">${[14, 30].map((r) => `<button type="button" class="jds-segmented__opt" aria-pressed="${t.range === r}" data-act="range" data-range="${r}">${r} days</button>`).join("")}</div>`;
  const help = t.helpOpen
    ? `<div class="wl-help__scrim" data-act="help-toggle"></div><div class="wl-help__pop" role="dialog">
        <div class="wl-help__row"><span class="wl-help__k">Mood line</span><span class="wl-help__v">Each check-in becomes a number from <strong>Heavy</strong> (−5) to <strong>Bright</strong> (+5). The dot's color is the emotion you logged.</span></div>
        <div class="wl-help__row"><span class="wl-help__k">Meds dots</span><span class="wl-help__v">One dot per day for how much of your regimen you logged. Hover any day for the full list.</span></div></div>`
    : "";
  const card = has
    ? `<div class="wl-chartcard"><div class="wl-chart__hd"><div><div class="wl-chart__title"><span class="ic">${icons.trend()}</span>Mood &amp; medication
        <span class="wl-help"><button type="button" class="wl-help__btn${t.helpOpen ? " is-on" : ""}" aria-label="How to read this chart" aria-expanded="${t.helpOpen}" data-act="help-toggle">${icons.help()}</button>${help}</span></div></div>
        <div class="wl-chart__legend">${EMOTIONS.map((e) => `<span class="wl-leg"><span class="wl-leg__dot" style="--em-tint:var(--wellness-${e.core}-tint)"></span>${coreLabel(e.core)}</span>`).join("")}</div></div>
        ${chartView(days, state.chart)}</div>`
    : "";
  return `<section class="wl-sec">${sectionHead("03", "Trends", seg)}${status}${card}</section>`;
}
