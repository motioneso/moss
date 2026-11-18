// The check-in dialog: pick a feeling, sensations, strength and a note.
import {
  EMOTIONS,
  MOOD_BAND_LABELS,
  coreLabel,
  emoVars,
  emotion as findEmotion,
  moodBand,
  moodIndex
} from "./core.mjs";
import { button, dialogHtml, esc, radioCards, signed } from "./html.mjs";

function pol(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function sector(cx, cy, ri, ro, a0, a1) {
  const [x0o, y0o] = pol(cx, cy, ro, a0);
  const [x1o, y1o] = pol(cx, cy, ro, a1);
  const [x0i, y0i] = pol(cx, cy, ri, a0);
  const [x1i, y1i] = pol(cx, cy, ri, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0o} ${y0o} A${ro} ${ro} 0 ${large} 1 ${x1o} ${y1o} L${x1i} ${y1i} A${ri} ${ri} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

export function dial(value) {
  const [cx, cy, ri, ro, pad] = [150, 150, 92, 130, 2.4];
  const n = EMOTIONS.length;
  const segs = EMOTIONS.map((e, i) => {
    const a0 = i * (360 / n) + pad;
    const a1 = (i + 1) * (360 / n) - pad;
    const [lx, ly] = pol(cx, cy, (ri + ro) / 2, (a0 + a1) / 2);
    const on = value === e.core;
    return `<g class="wl-dial__seg" data-act="pick-core" data-core="${e.core}" style="cursor:pointer"><path d="${sector(cx, cy, ri, ro, a0, a1)}" fill="var(--wellness-${e.core}-${on ? "tint" : "soft"})" stroke="var(--surface)" stroke-width="2.5"/>${on ? `<path d="${sector(cx, cy, ro + 3, ro + 5, a0, a1)}" fill="var(--wellness-${e.core}-tint)"/>` : ""}<text x="${lx}" y="${ly + 3.5}" text-anchor="middle" font-size="11" font-family="inherit" style="fill:var(--wellness-${e.core}-${on ? "on-tint" : "ink"});user-select:none;pointer-events:none">${coreLabel(e.core)}</text></g>`;
  }).join("");
  return `<div class="wl-dial" aria-hidden="true"><svg aria-hidden="true" focusable="false" viewBox="0 0 300 300" class="wl-dial__svg" style="width:100%;max-width:300px;height:auto;aspect-ratio:1">${segs}</svg>
    <div class="wl-dial__hub"><span style="font-size:11px;color:var(--text-subtle);display:block">${value ? "Feeling" : "Choose"}</span><span style="font-size:15px;font-weight:600;color:var(--text)">${value ? coreLabel(value) : "How do you feel?"}</span></div></div>
    <div class="wl-emotion-choices">${radioCards(
      "checkin-core",
      "Core emotion",
      EMOTIONS.map((e) => ({ value: e.core, label: coreLabel(e.core) })),
      value
    )}</div>`;
}

export function searchHits(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const e of EMOTIONS) {
    if (coreLabel(e.core).toLowerCase().includes(q))
      hits.push({ core: e.core, label: coreLabel(e.core), isCore: true });
    for (const f of e.feelings)
      if (f.label.toLowerCase().includes(q))
        hits.push({ core: e.core, label: f.label, isCore: false });
  }
  return hits.slice(0, 8);
}

export const orderedSensations = (emotion, feeling) => {
  const e = findEmotion(emotion);
  const out = [];
  e.feelings.find((f) => f.label === feeling)?.sensations.forEach((s) => out.push(s));
  e.feelings.forEach((f) =>
    f.sensations.forEach((s) => {
      if (!out.includes(s)) out.push(s);
    })
  );
  return out;
};

function detailFields(m) {
  const v = moodIndex(m.emotion, m.intensity);
  const chips = orderedSensations(m.emotion, m.feeling)
    .map((s) => {
      const on = m.sensations.includes(s);
      return `<button type="button" class="jds-btn jds-btn--chip jds-btn--sm${on ? " jds-btn--active" : ""}" aria-pressed="${on}" data-act="sensation" data-value="${esc(s)}">${esc(s)}</button>`;
    })
    .join("");
  return `<div style="${emoVars(m.emotion)}"><h3 tabindex="-1" class="wl-q" style="margin-top:4px" data-reveal>Where do you feel it?</h3>
    <div class="wl-qsub">Body sensations that come with &ldquo;${esc(m.feeling)}.&rdquo; Pick any that fit — or none.</div>
    <div class="wl-chipwrap">${chips}</div>
    <div class="wl-q" style="margin-top:22px">How strong is it?</div><div class="wl-qsub">This sets where the day lands on your mood trend.</div>
    ${radioCards(
      "checkin-intensity",
      "Intensity",
      [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) })),
      String(m.intensity)
    )}
    <div class="wl-intends"><span>Barely there</span><span>Overwhelming</span></div>
    <div class="wl-moodpreview"><span class="wl-moodpreview__k">Logs to your mood trend as</span><span class="wl-moodpreview__v"><span class="wl-moodpreview__num">${signed(v)}</span><span class="wl-moodpreview__band">${MOOD_BAND_LABELS[moodBand(v)]}</span></span></div>
    <textarea aria-label="Check-in note (optional)" class="wl-note-field" data-field="note" placeholder="Anything you want to remember about this — a trigger, a thought? Optional.">${esc(m.note)}</textarea></div>`;
}

export function checkinModalHtml(m) {
  let lower = "";
  if (m.emotion && m.feeling) {
    lower = `<div style="margin-top:22px;padding-top:20px;border-top:1px solid var(--border-subtle);${emoVars(m.emotion)}">${detailFields(m)}</div>`;
  } else if (m.emotion) {
    const feelings = findEmotion(m.emotion).feelings.map((f) => ({
      value: f.label,
      label: f.label
    }));
    lower = `<div style="margin-top:18px"><h3 tabindex="-1" class="wl-q wl-q--sub" data-reveal>Which shade of ${coreLabel(m.emotion)}?</h3>${radioCards("checkin-feeling", `Shade of ${coreLabel(m.emotion)}`, feelings, m.feeling)}</div>`;
  }
  const body = `<div><div class="wl-q">What are you feeling?</div><div class="wl-qsub">Search by name or choose your core emotion.</div>
    <div class="wl-search"><input type="text" class="wl-search__input" aria-label="Search feelings" placeholder="Search feelings…" value="${esc(m.search)}" autocomplete="off" data-field="search"><div class="wl-search__results" data-results hidden></div></div>
    <div class="wl-dial-wrap">${dial(m.emotion)}</div>${lower}</div>`;
  const footer = `${m.failed ? `<span role="alert">Couldn't save your check-in. Your note is still here, so try again.</span>` : ""}
    ${button("Cancel", { act: "modal-close", disabled: m.saving, size: "md" })}
    ${button(m.saving ? "Saving…" : m.editing ? "Update check-in" : "Save check-in", { act: "checkin-save", variant: "primary", size: "md", disabled: !(m.emotion && m.feeling) || m.saving })}`;
  return dialogHtml({
    title: "How are you feeling right now?",
    desc: m.editing ? "Edit check-in" : "Mental-health check-in",
    className: "wl-dialog wl-dialog--checkin",
    body,
    footer,
    closeLabel: "Close check-in",
    closeDisabled: m.saving
  });
}

export function resultsHtml(query) {
  return searchHits(query)
    .map(
      (hit, i) =>
        `<button type="button" class="wl-search__item" data-act="pick-hit" data-i="${i}"><span class="wl-search__core">${hit.isCore ? esc(hit.label) : coreLabel(hit.core)}</span>${hit.isCore ? "" : `<span class="wl-search__arrow">›</span><span class="wl-search__label">${esc(hit.label)}</span>`}</button>`
    )
    .join("");
}

export function newCheckinState({ initial, seed }) {
  return initial
    ? {
        editing: true,
        emotion: initial.feelingCore,
        feeling: initial.feelingSecondary ?? "",
        sensations: [...(initial.sensations ?? [])],
        intensity: initial.intensity ?? 3,
        note: initial.note ?? "",
        search: "",
        saving: false,
        failed: false
      }
    : {
        editing: false,
        emotion: seed ?? null,
        feeling: null,
        sensations: [],
        intensity: 3,
        note: "",
        search: "",
        saving: false,
        failed: false
      };
}

/** The request body for a save. A new check-in also says it came from the wheel. */
export function checkinBody(m) {
  const body = {
    feelingCore: m.emotion,
    feelingSecondary: m.feeling || null,
    feelingTertiary: null,
    sensations: m.sensations,
    intensity: m.intensity,
    note: m.note.trim() || null
  };
  return m.editing ? body : { ...body, identifiedVia: "wheel" };
}
