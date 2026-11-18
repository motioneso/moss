/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { weatherApi } from "./api.mjs";
import { forecastPresentation, conditionIcon, updatedTime } from "./view.mjs";
import { icon } from "./icons.mjs";

const api = weatherApi(moduleClient());
const root = document.getElementById("root");
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const unavailable = (text) => `<div class="weather-forecast" role="status">
  <div class="jds-empty"><div class="jds-empty__icon">${icon("cloud", 24)}</div>
  <div class="jds-empty__title">Hourly forecast unavailable</div>
  <div class="jds-empty__desc">${esc(text)}</div></div>
  <hr class="jds-divider" /><footer class="weather-forecast__source">Open-Meteo · Hourly forecast unavailable</footer></div>`;

export function card(v) {
  const p = forecastPresentation(v);
  const degree = v.unit === "imperial" ? "°F" : "°C";
  const first = Date.parse(v.intervals[0].startsAt);
  const x = (i) => 50 + i * 100;
  const y = (t) => 20 + ((p.max - t) / Math.max(5, p.max - p.min)) * 60;
  const partial = v.coverage === "partial";
  const lines = p.hours
    .map((h, i) => {
      const n = p.hours[i + 1];
      return h.temperature !== null && n && n.temperature !== null
        ? `<path class="weather-forecast__line" d="M ${x(i)} ${y(h.temperature)} L ${x(i + 1)} ${y(n.temperature)}"></path>`
        : "";
    })
    .join("");
  const dots = p.hours
    .map((h, i) =>
      h.temperature !== null
        ? `<circle class="weather-forecast__dot" cx="${x(i)}" cy="${y(h.temperature)}" r="4"></circle>`
        : ""
    )
    .join("");
  const items = p.hours
    .map((h) => {
      const it = h.item;
      const label = `${h.label}: ${it ? `${h.temperature}${degree}, ${it.condition}; rain ${it.rainProbability === null ? "unknown" : `${Math.round(it.rainProbability)}%`}; wind ${it.windSpeed === null ? "unknown" : `${Math.round(it.windSpeed)} ${v.windUnit}`}` : "unavailable"}`;
      return `<li aria-label="${esc(label)}"><strong>${h.temperature === null ? "—" : `${h.temperature}°`}</strong>${
        it
          ? icon(conditionIcon(it.condition, Date.parse(it.startsAt), v.timeZone))
          : `<span aria-hidden="true">—</span>`
      }<small><time datetime="${new Date(h.at).toISOString()}">${esc(h.label)}</time></small></li>`;
    })
    .join("");
  return `<section class="weather-forecast" aria-label="${esc(v.place)} hourly forecast">
  <header class="weather-forecast__head"><div>
    <span class="jds-eyebrow jds-eyebrow--accent">${partial ? "Available hours" : esc(p.day)}</span>
    <h3>${esc(v.place)}</h3>
    <p>${esc(p.window)}${v.approximate ? " · Approximate location" : ""}</p>
    ${v.approximate ? "<p>Name another city and region in chat to correct it without saving Settings.</p>" : ""}
  </div>${icon(conditionIcon(p.condition, first, v.timeZone), 36)}</header>
  ${
    partial
      ? `<div class="weather-forecast__coverage" role="status"><span class="jds-badge jds-badge--amber">Partial forecast</span><span>${esc(
          p.hours
            .filter((h) => !h.item)
            .map((h) => h.label)
            .join(", ")
        )} unavailable</span></div>`
      : ""
  }
  <div class="weather-forecast__summary"><strong>${p.min}–${p.max}<span>${degree}</span></strong><span>${esc(p.condition)}</span></div>
  <div class="weather-forecast__scroll" role="region" aria-label="Hourly forecast" tabindex="0">
    <div class="weather-forecast__curve" style="--weather-hours:${p.hours.length}">
      <svg viewBox="0 0 ${p.hours.length * 100} 110" preserveAspectRatio="none" aria-hidden="true"><path class="weather-forecast__baseline" d="M 50 95 H ${x(p.hours.length - 1)}"></path>${lines}${dots}</svg>
      <ul class="weather-forecast__hours">${items}</ul>
    </div>
  </div>
  <dl class="weather-forecast__facts">
    <div>${icon("droplets")}<div><dt>Rain chance · ${partial ? "known hours" : "peak"}</dt><dd>${p.peak(
      v.intervals.map((i) => i.rainProbability),
      "%"
    )}</dd></div></div>
    <div>${icon("wind")}<div><dt>Wind · ${partial ? "known hours" : "peak"}</dt><dd>${p.peak(
      v.intervals.map((i) => i.windSpeed),
      ` ${v.windUnit}`
    )}</dd></div></div>
  </dl>
  <hr class="jds-divider" />
  <footer class="weather-forecast__source">Open-Meteo · Updated <time datetime="${esc(v.retrievedAt)}">${esc(updatedTime(v))}</time>${v.stale ? " · Stale forecast" : ""}${v.observedAt === null ? " · Observation unavailable" : ""}</footer>
</section>`;
}

async function load() {
  root.innerHTML = `<div class="weather-forecast" aria-busy="true"><p class="weather-forecast__source" role="status">Loading the forecast…</p></div>`;
  try {
    const reply = await api.forecast({});
    if (reply.status === "forecast" && reply.forecast?.intervals?.length) {
      root.innerHTML = card(reply.forecast);
      return;
    }
    root.innerHTML = unavailable(
      reply.status === "ambiguous" || reply.status === "unresolved"
        ? "Set a weather place in Profile, or name the city and region in the conversation."
        : "Try again in a moment."
    );
  } catch {
    root.innerHTML = unavailable("Try again in a moment.");
  }
}
load();
