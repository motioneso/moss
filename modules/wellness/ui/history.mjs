// Section 04: check-in history.
import { MOOD_BAND_LABELS, coreLabel, localDay, moodBand, moodIndex, stamp } from "./core.mjs";
import { button, esc, icons, sectionHead, signed } from "./html.mjs";

const notebook = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="m21.378 3.626-1.004-1.004a2.121 2.121 0 0 0-3 0l-5.37 5.374 2 2 5.37-5.374"/></svg>`;

export function historyRows(history, filter) {
  let rows = history.slice().sort((a, b) => (stamp(b) < stamp(a) ? -1 : 1));
  if (filter === "notes")
    rows = rows.filter((c) => c.note && (c.feelingCore === "sad" || c.feelingCore === "anger"));
  return rows;
}

export function historyView(state) {
  const h = state.history;
  const { today, timeZone } = state;
  if (!h.pages) {
    return `<section class="wl-sec" aria-label="Check-in history"><p role="status">${h.error ? "Could not load check-in history." : "Loading check-in history…"}</p>${h.error ? button("Try again", { act: "history-retry", variant: "link", size: "md" }) : ""}</section>`;
  }
  const rows = historyRows(h.items, state.histFilter);
  const shown = rows.slice(0, h.limit);
  const meta =
    state.histFilter === "notes"
      ? `<span class="wl-filter-pill">Noted sad / angry check-ins<button type="button" class="jds-iconbtn" aria-label="Clear filter" data-act="hist-clear">${icons.x()}</button></span>`
      : `<span class="wl-sec__note">Tap a row to read &amp; edit</span>`;
  const empty =
    shown.length === 0
      ? `<div class="wl-history__empty">${state.histFilter ? (h.next ? "No matching check-ins in the loaded entries. Load older entries to keep looking." : "No check-ins match.") : "Your check-ins will appear here."}</div>`
      : "";
  const rowHtml = shown
    .map((ck) => {
      const full = stamp(ck);
      const day = full ? localDay(full, timeZone) : "";
      const isToday = day === today;
      const anchor = new Date(`${day}T12:00:00Z`);
      const fmt = (o) =>
        new Intl.DateTimeFormat(undefined, { ...o, timeZone: "UTC" }).format(anchor);
      const dow = isToday ? "Today" : fmt({ weekday: "long" });
      const when =
        isToday && full.length > 10
          ? new Intl.DateTimeFormat(undefined, {
              hour: "numeric",
              minute: "2-digit",
              timeZone
            }).format(new Date(full))
          : `${fmt({ month: "short" })} ${fmt({ day: "numeric" })}`;
      const v = moodIndex(ck.feelingCore, ck.intensity ?? 3);
      const open = h.openId === ck.id;
      const detail = open
        ? `<div id="checkin-${esc(ck.id)}" class="wl-hdetail" style="--em-tint:var(--wellness-${ck.feelingCore}-tint)">
          ${ck.sensations?.length ? `<div class="wl-hdetail__sens"><span class="wl-hdetail__lbl">Sensations</span>${ck.sensations.map((s) => `<span class="wl-sentag">${esc(s)}</span>`).join("")}</div>` : ""}
          ${ck.note ? `<div class="wl-hdetail__note">${esc(ck.note)}</div>` : `<div class="wl-hdetail__empty">No note on this one.</div>`}
          <div class="wl-hdetail__foot"><span class="wl-hdetail__time">Intensity ${ck.intensity ?? "—"}/5 &middot; mood ${signed(v)} &middot; ${MOOD_BAND_LABELS[moodBand(v)]}</span><span style="flex:1"></span>
          ${button(`${icons.pencil()}Edit`, { act: "history-edit", extra: ` data-id="${esc(ck.id)}"` })}</div></div>`
        : "";
      const sign = v > 0 ? "pos" : v < 0 ? "neg" : "neutral";
      return `<div class="wl-hrow${open ? " is-open" : ""}"><button type="button" class="jds-disclosure wl-hrow__head" aria-expanded="${open}" aria-controls="checkin-${esc(ck.id)}" data-act="history-toggle" data-id="${esc(ck.id)}">
        <span class="wl-hrow__date"><span class="dow">${esc(dow)}</span><span class="md"> ${esc(when)}</span></span>
        <span class="wl-hrow__emo" style="--em-tint:var(--wellness-${ck.feelingCore}-tint);--em-ink:var(--wellness-${ck.feelingCore}-ink)"><span class="d"></span><span class="nm">${coreLabel(ck.feelingCore)}</span></span>
        <span class="wl-hrow__feel">${esc(ck.feelingSecondary ?? "")}</span>
        <span class="wl-hrow__meta">${ck.note ? `<span class="wl-hrow__note" title="Has a note">${notebook}</span>` : ""}<span class="wl-hrow__mood wl-hrow__mood--${sign}">${signed(v)}</span><span class="wl-hrow__chev">${icons.chevron()}</span></span>
      </button>${detail}</div>`;
    })
    .join("");
  const more =
    rows.length > h.limit || h.next || h.moreError
      ? `<div class="wl-history__more">${button(h.loadingMore ? "Loading older check-ins…" : h.moreError ? "Retry older entries" : rows.length > h.limit ? `Show ${Math.min(10, rows.length - h.limit)} more` : "Load older check-ins", { act: "history-more", disabled: h.loadingMore })}</div>`
      : "";
  const refresh = h.error
    ? `<p role="status">Could not refresh check-in history. Showing the last loaded entries. ${button("Try again", { act: "history-retry", variant: "link", size: "md" })}</p>`
    : "";
  return `${refresh}<section class="wl-sec">${sectionHead("04", "Check-in history", meta)}<div class="wl-history">${empty}${rowHtml}</div>${h.moreError ? `<p role="alert">Could not load older check-ins. Your loaded entries are still here.</p>` : ""}${more}</section>`;
}
