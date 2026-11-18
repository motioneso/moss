// The Manage medications dialog.
import { esc, icons, dialogHtml } from "./html.mjs";
import {
  SCHEDULE_CHOICES,
  WEEKDAY_LABELS,
  MONTH_POSITION_LABELS,
  MAX_DOSES_PER_DAY,
  startDateRequired,
  supportsReminders,
  usesClockTimes,
  usesWeekdays,
  describeFormProblems,
  isValidClockTime
} from "./meds-form.mjs";

const medTint = (index) => `var(--wellness-med-${(index % 7) + 1}-tint)`;
const sel = (on) => (on ? " wl-freqbtn--active" : "");
const pressed = (on) => ` aria-pressed="${on ? "true" : "false"}"`;

function medRow(m, index) {
  const freq = m.frequencyType ? String(m.frequencyType).replace(/_/g, " ") : "as needed";
  const dose = m.dosage ? `<span class="dose">${esc(m.dosage)}</span> &middot; ` : "";
  const edit =
    m.frequencyType === "every_n_hours"
      ? ""
      : `<button type="button" class="wl-tnote__x" style="opacity:1" aria-label="Edit ${esc(m.name)}" data-act="med-edit" data-id="${esc(m.id)}">${icons.pencil()}</button>`;
  return `<div class="wl-medrow" style="--em-tint:${medTint(index)};cursor:default"><span class="wl-medrow__dot"></span>
    <span class="wl-medrow__main">${esc(m.name)}<span class="wl-medrow__sub">${dose}${esc(freq)}</span></span>
    ${edit}<button type="button" class="wl-tnote__x" style="opacity:1" aria-label="Remove ${esc(m.name)}" data-act="med-remove" data-id="${esc(m.id)}">${icons.trash()}</button></div>`;
}

const num = (field, value, attrs, label) =>
  `<input type="number" class="wl-medmodal__input wl-medform__num" data-mfield="${field}" value="${value}" ${attrs} aria-label="${esc(label)}">`;

function scheduleFields(f) {
  let html = "";
  if (f.choice === "every_interval") {
    html += `<div class="wl-medform__field"><label class="wl-hdetail__lbl">How often it repeats</label><div class="wl-medform__inline"><span class="wl-fs13">Every</span>
      ${num("intervalCount", Number.isFinite(f.intervalCount) ? f.intervalCount : "", 'min="1"', "Repeat every")}
      ${["days", "weeks", "months"].map((u) => `<button type="button" class="wl-freqbtn${sel(f.intervalUnit === u)}" data-act="med-unit" data-value="${u}"${pressed(f.intervalUnit === u)}>${u}</button>`).join("")}</div></div>`;
  }
  if (f.choice === "monthly") {
    html += `<div class="wl-medform__field"><label class="wl-hdetail__lbl">Which day of the month</label><div class="wl-medform__choices">
      ${[
        ["date", "On a date"],
        ["weekdayPosition", "On a weekday"]
      ]
        .map(
          ([v, l]) =>
            `<button type="button" class="wl-freqbtn${sel(f.monthKind === v)}" data-act="med-month-kind" data-value="${v}"${pressed(f.monthKind === v)}>${l}</button>`
        )
        .join("")}</div>`;
    if (f.monthKind === "date") {
      html += `<div class="wl-medform__inline">${num("monthDay", Number.isFinite(f.monthDay) ? f.monthDay : "", `min="1" max="31"${f.monthDayIsLast ? " disabled" : ""}`, "Day of the month")}
        <label class="wl-medform__check"><input type="checkbox" data-mfield="monthDayIsLast"${f.monthDayIsLast ? " checked" : ""}> Last day of the month</label></div>`;
    } else {
      html += `<div class="wl-medform__stack"><div class="wl-medform__choices">${MONTH_POSITION_LABELS.map((p) => `<button type="button" class="wl-freqbtn${sel(f.monthWeekdayPosition === p.value)}" data-act="med-month-pos" data-value="${p.value}"${pressed(f.monthWeekdayPosition === p.value)}>${p.label}</button>`).join("")}</div>
        <div class="wl-medform__choices">${WEEKDAY_LABELS.map((d) => `<button type="button" class="wl-freqbtn${sel(f.monthWeekday === d.value)}" data-act="med-month-weekday" data-value="${d.value}" aria-label="${d.long}"${pressed(f.monthWeekday === d.value)}>${d.short}</button>`).join("")}</div></div>`;
    }
    html += "</div>";
  }
  if (f.choice === "cycle") {
    html += `<div class="wl-medform__field"><label class="wl-hdetail__lbl">Days on, then days off</label><div class="wl-medform__inline">
      ${num("cycleDaysOn", Number.isFinite(f.cycleDaysOn) ? f.cycleDaysOn : "", 'min="1"', "Days on")}<span class="wl-fs13">days on, then</span>
      ${num("cycleDaysOff", Number.isFinite(f.cycleDaysOff) ? f.cycleDaysOff : "", 'min="0"', "Days off")}<span class="wl-fs13">days off</span></div></div>`;
  }
  if (usesWeekdays(f)) {
    html += `<div class="wl-medform__field"><label class="wl-hdetail__lbl">Days of the week</label><div class="wl-medform__choices">
      ${WEEKDAY_LABELS.map((d) => {
        const on = f.weekdays.includes(d.value);
        return `<button type="button" class="wl-freqbtn${sel(on)}" data-act="med-weekday" data-value="${d.value}" aria-label="${d.long}"${pressed(on)}>${d.short}</button>`;
      }).join("")}</div></div>`;
  }
  return html;
}

function timesField(f) {
  if (!usesClockTimes(f.choice))
    return `<div class="wl-medform__field"><p class="wl-subtle-text" style="font-style:italic;margin-top:10px">As-needed medications have no fixed schedule.</p></div>`;
  const many = f.times.length > 1;
  const rows = f.times
    .map((t, i) => {
      const bad = t !== "" && !isValidClockTime(t);
      return `<div class="wl-medform__timerow"><input type="time" class="wl-medmodal__input wl-medmodal__timeinput${bad ? " wl-medmodal__timeinput--invalid" : ""}" data-mfield="time" data-i="${i}" value="${esc(t)}" aria-label="Dose time ${i + 1}">
      ${many ? `<button type="button" class="wl-tnote__x" style="opacity:1" aria-label="Remove dose time ${i + 1}" data-act="med-time-remove" data-i="${i}">${icons.x()}</button>` : ""}</div>`;
    })
    .join("");
  const add =
    f.times.length < MAX_DOSES_PER_DAY
      ? `<button type="button" class="ghost-button wl-fs13" data-act="med-time-add">${icons.plus()} Add another time</button>`
      : "";
  return `<div class="wl-medform__field"><label class="wl-hdetail__lbl">${many ? "Times of day" : "Time of day"}</label><div class="wl-medform__times">${rows}</div>${add}</div>`;
}

export function formView(m) {
  const f = m.form;
  const problems = describeFormProblems(f);
  const hint = SCHEDULE_CHOICES.find((c) => c.value === f.choice)?.hint ?? "";
  const error = m.formFailed
    ? "That did not save. Check the details and try again."
    : (problems[0] ?? "");
  return `<div class="wl-medmodal__addsection" style="padding-top:14px;margin-top:4px">
    <div class="wl-hdetail__lbl">${m.editingId ? "Edit medication" : "Add a medication"}</div>
    <div class="wl-medform__row2">
      <input class="wl-medmodal__input" data-mfield="name" placeholder="Name (e.g. Bupropion)" aria-label="Medication name" value="${esc(f.name)}">
      <input class="wl-medmodal__input" data-mfield="dose" placeholder="Dose (e.g. 50 mg)" aria-label="Dose" value="${esc(f.dose)}"></div>
    <div class="wl-medform__field"><label class="wl-hdetail__lbl">Schedule</label>
      <div class="wl-medform__choices">${SCHEDULE_CHOICES.map((c) => `<button type="button" class="wl-freqbtn${sel(f.choice === c.value)}" data-act="med-choice" data-value="${c.value}"${pressed(f.choice === c.value)}>${c.label}</button>`).join("")}</div>
      <p class="wl-medform__hint">${esc(hint)}</p></div>
    ${scheduleFields(f)}${timesField(f)}
    <div class="wl-medform__field"><label class="wl-hdetail__lbl">${startDateRequired(f.choice) ? "Starts on" : "Starts on (optional)"}</label>
      <input type="date" class="wl-medmodal__input wl-medform__date" data-mfield="startDate" value="${esc(f.startDate)}" aria-label="Start date"></div>
    ${
      supportsReminders(f.choice)
        ? `<div class="wl-medform__field wl-medform__switchrow"><span class="wl-hdetail__lbl">Remind me when a dose is due</span>
      <label class="jds-switch"><input type="checkbox" role="switch" data-mfield="remindersEnabled" aria-label="Remind me when a dose is due"${f.remindersEnabled ? " checked" : ""}><span class="jds-switch__track"><span class="jds-switch__thumb"></span></span></label></div>`
        : ""
    }
    <div class="wl-medform__preview"><div class="wl-hdetail__lbl">What this means</div><p class="wl-fs13">Finish filling this in to see what the schedule works out to.</p></div>
    <div class="wl-medform__actions">
      <button type="button" class="secondary-button wl-fs13" data-act="med-save"${problems.length > 0 || m.saving ? " disabled" : ""}>${icons.plus()} ${m.editingId ? "Save changes" : "Add medication"}</button>
      ${m.editingId ? `<button type="button" class="ghost-button wl-fs13" data-act="med-cancel-edit">Cancel</button>` : ""}
      ${error ? `<span class="wl-medmodal__error" role="alert">${esc(error)}</span>` : ""}</div></div>`;
}

export function listView(m) {
  if (m.loading) return `<p class="wl-subtle-text" role="status">Loading medications&hellip;</p>`;
  if (m.loadError)
    return `<p class="wl-subtle-text" role="alert">Could not load medications. <button type="button" class="jds-btn jds-btn--link" data-act="med-reload">Try again</button></p>`;
  return `${m.removeFailed ? `<p class="wl-medmodal__error" role="alert">Could not remove that medication. Try again.</p>` : ""}<div class="wl-medlist">${m.items.map(medRow).join("")}</div>`;
}

export const medsModalHtml = (m) =>
  dialogHtml({
    title: "Manage medications",
    desc: "Settings",
    className: "wl-dialog wl-dialog--medications",
    closeLabel: "Close medications",
    body: `<div data-meds-list>${listView(m)}</div><div data-meds-form>${formView(m)}</div>`,
    footer: `<button type="button" class="jds-btn jds-btn--primary" data-act="modal-close">Done</button>`
  });
