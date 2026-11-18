// Today section: the medication card and the mood card.
import { EMOTIONS, MOOD_BAND_LABELS, coreLabel, emoVars, moodBand, moodIndex, stamp, localDay } from "./core.mjs";
import { esc, icons, signed } from "./html.mjs";

export const PRN_REASONS = ["Pain", "Anxiety", "Nausea", "Headache", "Trouble sleeping"];

export const slotClock = (slot) => slot.localTime ?? (slot.scheduledFor ? slot.scheduledFor.slice(11, 16) : "");

export function todaysCheckins(checkins, today, timeZone) {
  return checkins
    .filter((c) => stamp(c) && localDay(stamp(c), timeZone) === today)
    .sort((a, b) => (stamp(b) < stamp(a) ? -1 : 1));
}

const STATUS_TEXT = { taken: "Taken", skipped: "Skipped", pending: "Pending" };

function medicationRows(state) {
  const { schedule, saving, prn } = state.med;
  const blocked = state.med.scheduleError || saving;
  const slots = schedule.slots;
  const hour = (s) => parseInt(slotClock(s).slice(0, 2), 10);
  const groups = [
    { label: "Morning", icon: icons.sunrise(), rows: slots.filter((s) => slotClock(s) && hour(s) < 12) },
    { label: "Evening", icon: icons.moon(), rows: slots.filter((s) => (slotClock(s) ? hour(s) >= 12 : s.asNeeded)) }
  ];
  return groups
    .filter((g) => g.rows.length)
    .map((g) => {
      const rows = g.rows
        .map((slot, i) => {
          if (slot.asNeeded) {
            const open = prn.openFor === slot.medicationId;
            const panel = open
              ? `<div class="wl-prn__panel">
                  <div class="wl-prn__chips">${PRN_REASONS.map(
                    (r) => `<button type="button" class="wl-prn__chip${prn.reason === r ? " is-on" : ""}" data-act="prn-reason" data-reason="${esc(r)}"${saving ? " disabled" : ""}>${esc(r)}</button>`
                  ).join("")}</div>
                  <input class="wl-prn__input" type="text" value="${esc(prn.reason)}" placeholder="Reason for this dose (optional)" aria-label="Reason for this dose" maxlength="120" data-field="prn-reason"${saving ? " disabled" : ""}>
                  <div class="wl-prn__actions">
                    <button type="button" class="ghost-button wl-fs12" style="padding:5px 12px;min-height:unset" data-act="prn-cancel"${saving ? " disabled" : ""}>Cancel</button>
                    <button type="button" class="primary-button wl-fs12" style="padding:5px 12px;min-height:unset" data-act="prn-log" data-med="${esc(slot.medicationId)}"${blocked || state.med.unresolved ? " disabled" : ""}>Log dose</button>
                  </div>
                </div>`
              : "";
            return `<div class="wl-prn"><div class="wl-prn__row">
                <span class="wl-medrow__name">${esc(slot.name)}<span class="wl-medrow__prn">as needed</span></span>
                <span class="wl-prn__count">${slot.prnCount ?? 0} logged today</span>
                <button type="button" class="wl-prn__log" data-act="prn-open" data-med="${esc(slot.medicationId)}" aria-expanded="${open}"${blocked ? " disabled" : ""}>${icons.plus()}Log a dose</button>
              </div>${panel}</div>`;
          }
          const on = slot.status === "taken";
          const clock = slotClock(slot);
          const next = on ? "skipped" : "taken";
          return `<div class="wl-medrow wl-medrow--tight${on ? " is-on" : ""}" role="button" tabindex="0" data-act="dose" data-med="${esc(slot.medicationId)}" data-next="${next}" data-slot="${esc(slot.scheduledFor ?? "")}" aria-disabled="${Boolean(blocked)}" aria-label="${esc(`${slot.name}, ${clock}, ${slot.status}. ${on ? "Mark skipped (replaces taken)" : "Mark taken"}`)}">
              <span class="wl-medrow__box">${on ? icons.check(14) : ""}</span>
              <span class="wl-medrow__main"><span class="wl-medrow__name">${esc(slot.name)}</span></span>
              <span class="wl-medrow__taken">${on ? icons.check(12) : ""}${STATUS_TEXT[slot.status] ?? "Pending"}</span>
              <span class="wl-medrow__time">${esc(clock)}</span>
            </div>`;
        })
        .join("");
      return `<div class="wl-medgrp"><div class="wl-medgrp__lbl"><span class="ic">${g.icon}</span>${g.label}</div>${rows}</div>`;
    })
    .join("");
}

export function medCard(state) {
  const m = state.med;
  const slots = m.schedule?.slots ?? [];
  const scheduled = slots.filter((s) => !s.asNeeded);
  const taken = scheduled.filter((s) => s.status === "taken").length;
  const pct = scheduled.length ? Math.round((taken / scheduled.length) * 100) : 0;
  const parts = [];
  if (m.saving) parts.push(`<p role="status">Saving dose…</p>`);
  if (m.unresolved) {
    parts.push(`<div role="alert"><p>We could not confirm whether this as-needed dose saved.</p>${m.checkFailed ? "<p>Could not check saved doses.</p>" : ""}<button type="button" class="jds-btn jds-btn--link" data-act="prn-check"${m.checking ? " disabled" : ""}>Check saved doses</button></div>`);
  }
  if (m.failed) {
    const what = m.failed.status === "prn" ? "an as-needed dose" : m.failed.status;
    parts.push(`<div role="alert"><p>Could not save this dose as ${esc(what)}.</p><button type="button" class="jds-btn jds-btn--link" data-act="dose-retry"${m.scheduleError || m.saving ? " disabled" : ""}>Retry dose</button></div>`);
  }
  if (m.rechecked) parts.push(`<p role="status">Saved doses checked.</p>`);
  if (!m.schedule && !m.scheduleError) parts.push(`<p class="wl-subtle-text" role="status">Loading medication schedule…</p>`);
  if (m.scheduleError) {
    parts.push(`<p class="wl-subtle-text" role="status">${m.schedule ? "Could not refresh the schedule. Showing the last loaded doses." : "Could not load the medication schedule."} <button type="button" class="jds-btn jds-btn--link" data-act="schedule-retry">Try again</button></p>`);
  }
  if (m.schedule) parts.push(medicationRows(state));
  if (m.schedule && slots.length === 0) parts.push(`<p class="wl-subtle-text" style="padding:4px 0">No medications scheduled.</p>`);
  const foot = m.schedule && scheduled.length
    ? `<div class="wl-medfoot"><span class="wl-medfoot__bar"><span class="wl-medfoot__track"><span class="wl-medfoot__fill" style="width:${pct}%"></span></span></span><span class="wl-medfoot__ct"><b>${taken}</b> of ${scheduled.length} taken</span></div>`
    : "";
  return `<div class="wl-card">
    <div class="wl-card__hd"><span class="ic">${icons.pill()}</span><span class="t">Today's medication</span>
      <span class="r"><button type="button" class="ghost-button wl-fs12" style="padding:4px 10px;min-height:unset;gap:5px" data-act="manage-open">${icons.sliders()}Manage</button></span></div>
    <div class="wl-medlist">${parts.join("")}</div>${foot}</div>`;
}

const ghost = (act, icon, label) =>
  `<button type="button" class="ghost-button wl-fs12" style="padding:4px 10px;min-height:unset;gap:5px" data-act="${act}">${icon}${label}</button>`;

export function moodCard(state) {
  const header = (right = "") => `<div class="wl-card__hd"><span class="ic">${icons.pulse()}</span><span class="t">Today's mood</span>${right}</div>`;
  if (!state.checkins) {
    return `<div class="wl-card wl-checkin"><div class="wl-card__hd"><span class="t">Today's mood</span></div>
      <p role="status">${state.checkinsError ? "Could not load your check-ins." : "Loading check-ins…"}</p>
      ${state.checkinsError ? `<button type="button" class="jds-btn jds-btn--link" data-act="checkins-retry">Try again</button>` : ""}</div>`;
  }
  const list = todaysCheckins(state.checkins, state.today, state.timeZone);
  const latest = list[0];
  const streak = state.streak;
  const chip = streak > 0 ? `<span class="wl-streakchip" title="${streak}-day check-in streak">${icons.flame(13)}${streak}</span>` : "";
  if (!latest) {
    const hint = streak > 0
      ? `You're on a <strong>${streak}-day streak</strong> — check in to keep it going.`
      : "A 20-second read on how you're feeling — it shapes your trend.";
    const strip = EMOTIONS.map((em) => `<button type="button" class="wl-emostrip__b" title="Start with ${coreLabel(em.core)}" style="${emoVars(em.core)}" data-act="checkin-seed" data-core="${em.core}"><span class="wl-emostrip__dot"></span><span class="wl-emostrip__name">${coreLabel(em.core)}</span></button>`).join("");
    return `<div class="wl-card wl-checkin">${header(chip ? `<span class="r">${chip}</span>` : "")}
      <div class="wl-checkin__prompt"><div class="wl-checkin__q">You haven't checked in yet today.</div>
        <div class="wl-checkin__hint">${hint}</div>
        <div class="wl-emostrip">${strip}</div>
        <div class="wl-checkin__cta"><button type="button" class="primary-button" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px" data-act="checkin-open">${icons.clipboard()}Start check-in</button></div>
      </div></div>`;
  }
  const many = list.length > 1;
  const v = moodIndex(latest.feelingCore, latest.intensity ?? 3);
  const avg = many ? Math.round((list.reduce((s, c) => s + moodIndex(c.feelingCore, c.intensity ?? 3), 0) / list.length) * 10) / 10 : v;
  const tags = latest.sensations?.length ? `<div class="wl-senrow">${latest.sensations.map((s) => `<span class="wl-sentag">${esc(s)}</span>`).join("")}</div>` : "";
  const pips = [1, 2, 3, 4, 5].map((n) => `<span class="wl-intens__pip${n <= (latest.intensity ?? 0) ? " wl-intens__pip--filled" : ""}"></span>`).join("");
  return `<div class="wl-card wl-checkin" style="${emoVars(latest.feelingCore)}">
    ${header(`<span class="r" style="display:flex;align-items:center;gap:8px">${chip}${ghost("checkin-open", icons.plus(), "Check in again")}${ghost("checkin-edit-today", icons.pencil(), "Edit")}</span>`)}
    <div class="wl-done"><p class="wl-fs12 wl-text-subtle">Saved today</p>
      <div class="wl-done__top"><span class="wl-done__chip"><span class="d"></span>${coreLabel(latest.feelingCore)}</span>
        <span class="wl-done__feeling">${esc(latest.feelingSecondary ?? "")}</span>
        <span class="wl-done__mood"><span class="k">${many ? "Now" : "Mood"}</span><span class="v">${signed(v)}</span></span>
        ${many ? `<span class="wl-done__mood"><span class="k">Avg</span><span class="v">${signed(avg)}</span><span class="k">${moodBand(avg)}</span></span>` : ""}
      </div>${tags}
      <div class="wl-intens"><span class="wl-intens__lbl">Intensity</span><span class="wl-intens__track">${pips}</span></div>
      ${latest.note ? `<div class="wl-hdetail__note">${esc(latest.note)}</div>` : ""}
    </div>
    ${many ? `<div class="wl-fs12 wl-text-subtle" style="padding:4px 16px 12px">${list.length} check-ins today</div>` : ""}</div>`;
}

export const todaySection = (state) => `<div class="wl-today">${medCard(state)}${moodCard(state)}</div>`;
export { MOOD_BAND_LABELS };
