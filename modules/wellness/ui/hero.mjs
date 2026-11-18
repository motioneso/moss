// The page header: title, mood and streak figures, and the Export and Settings controls.
import { esc, icons, signed, button } from "./html.mjs";
import { MOOD_BAND_LABELS, moodBand } from "./core.mjs";

/** Drawn once. The figures and the Export slot are filled in separately so a repaint of one never wipes the other. */
export const heroShell = () =>
  `<header class="wl-hero"><div class="wl-hero__main"><h1 class="wl-title">Mood and medication</h1>
    <p class="wl-lede">Log medication, record how you feel, and review changes over time.</p></div>
    <div class="wl-hero__stat"><span id="wl-herostats" style="display:contents"></span><span id="wl-export-slot" style="display:contents"></span>
      ${button("Settings", { act: "open-settings", variant: "quiet" })}</div></header>`;

export function heroStats(state, avgMood, streak) {
  if (!state.checkins) {
    return `<p role="status">${state.checkinsError ? "Check-in statistics unavailable." : "Loading check-ins…"}</p>`;
  }
  const mood =
    avgMood === null
      ? "<small>No check-ins in this period</small>"
      : `${signed(avgMood)}<small> ${MOOD_BAND_LABELS[moodBand(avgMood)] ?? ""}</small>`;
  return `<div class="wl-herostat"><div class="k">Mood &middot; 14 completed days</div><div class="v">${mood}</div></div>
    <div class="wl-herostat wl-herostat--streak"><div class="k">Streak &middot; through yesterday</div><div class="v">${icons.flame(15)}${streak}<small title="Consecutive completed days, up to 90"> ${streak === 1 ? "day" : "days"}</small></div></div>`;
}

export const errorLine = (state) =>
  state.checkinsError
    ? `<p role="status">${esc(state.checkins ? "Could not refresh check-ins. Showing the last loaded entries." : "Could not load check-ins. Your saved entries are unavailable right now.")} ${button("Try again", { act: "checkins-retry", variant: "link", size: "md" })}</p>`
    : "";
