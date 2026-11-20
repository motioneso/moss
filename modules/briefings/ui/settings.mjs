/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { briefingsApi } from "./api.mjs";
import {
  MORNING_NEWS_TOOL,
  MORNING_SPORTS_TOOL,
  findDefinition,
  targetTimeFor,
  toggleToolName,
  createRequest,
  updateRequest,
  sourceLabels,
  sourceListDescription
} from "./view.mjs";

const api = briefingsApi(moduleClient());
const root = document.getElementById("root");

const state = {
  phase: "loading",
  definitions: [],
  externalSources: [],
  signals: {},
  busy: false,
  error: ""
};

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

const SIGNALS = [
  {
    key: "email",
    label: "Include email signal",
    desc: "Surface important threads in scheduled briefings."
  },
  {
    key: "calendar",
    label: "Include calendar signal",
    desc: "Use calendar-derived readiness signals in scheduled briefings."
  }
];

const toggle = (name, label, desc, checked, disabled) => `
  <div class="set-row">
    <div class="set-row__main"><div class="set-row__name">${esc(label)}</div>${desc ? `<div class="set-row__desc">${esc(desc)}</div>` : ""}</div>
    <div class="set-row__control"><label class="jds-switch"><input type="checkbox" aria-label="${esc(label)}" data-switch="${esc(name)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} /><span class="jds-switch__track"><span class="jds-switch__thumb"></span></span></label></div>
  </div>`;

const timeField = (label, id, value, hint, disabled) => `
  <div class="fld">
    <label class="fld__lbl" for="${id}">${esc(label)}</label>
    <div class="fld__row"><input class="jds-input" type="time" id="${id}" value="${esc(value)}" aria-label="${esc(label)}" ${disabled ? "disabled" : ""} /></div>
    ${hint ? `<div class="fld__hint">${esc(hint)}</div>` : ""}
  </div>`;

function render() {
  if (state.phase === "loading") {
    root.innerHTML = `<section class="pane__card" aria-busy="true"><p class="pane__carddesc" role="status">Loading briefing settings…</p></section>`;
    return;
  }
  if (state.phase === "error") {
    root.innerHTML = `<section class="pane__card"><header class="pane__cardhead"><div class="pane__cardheadmain"><h3 class="pane__cardtitle">Briefings</h3></div></header>
      <p class="pane__carddesc" role="status">Briefing settings couldn't load.</p>
      <button type="button" class="jds-btn jds-btn--sm" id="retry">Try again</button></section>`;
    document.getElementById("retry").onclick = load;
    return;
  }
  const morning = findDefinition(state.definitions, "morning");
  const evening = findDefinition(state.definitions, "evening");
  const d = state.busy;
  const morningTools = morning?.selectedToolNames ?? [];
  const labels = sourceLabels(morningTools);
  const external = state.externalSources
    .map((s) =>
      toggle(
        `ext:${s.toolName}`,
        s.label,
        `Include ${s.label} in the morning briefing.`,
        morningTools.includes(s.toolName),
        d || !morning
      )
    )
    .join("");
  const signalRows = SIGNALS.filter((x) => x.key in state.signals)
    .map((x) => toggle(`sig:${x.key}`, x.label, x.desc, state.signals[x.key], d))
    .join("");
  root.innerHTML = `
  ${state.error ? `<p class="briefings-note briefings-note--drift" role="status">${esc(state.error)}</p>` : ""}
  <section class="pane__card">
    <header class="pane__cardhead"><div class="pane__cardheadmain">
      <h3 class="pane__cardtitle">Cadence</h3>
      <div class="pane__carddesc">When Moss prepares your reading. It waits for you, nothing is pushed before this.</div>
    </div></header>
    <div class="pane__cardbody">
      ${timeField("Morning briefing time", "morning-time", targetTimeFor(morning, "morning"), "Ready when you wake. Tone follows your assistant persona.", d)}
      ${toggle("evening", "Evening wind-down", "A short look back, and a glance at tomorrow.", evening?.enabled ?? false, d)}
      ${evening?.enabled ? timeField("Evening time", "evening-time", targetTimeFor(evening, "evening"), "", d) : ""}
    </div>
  </section>
  <section class="pane__card">
    <header class="pane__cardhead"><div class="pane__cardheadmain"><h3 class="pane__cardtitle">Sources</h3></div></header>
    <div class="pane__cardbody">
      <div class="set-row"><div class="set-row__main"><div class="set-row__name">Read tools</div><div class="set-row__desc">${esc(sourceListDescription(labels))}</div></div></div>
      ${toggle("news", "Morning news", "Include today's top headlines in the morning briefing.", morningTools.includes(MORNING_NEWS_TOOL), d || !morning)}
      ${toggle("sports", "Morning sports", "Include today's followed-team facts in the morning briefing.", morningTools.includes(MORNING_SPORTS_TOOL), d || !morning)}
      ${external}
      ${signalRows}
    </div>
  </section>`;
  for (const input of root.querySelectorAll("[data-switch]")) {
    input.onchange = () => onSwitch(input.dataset.switch, input.checked);
  }
  const mt = document.getElementById("morning-time");
  if (mt) mt.onchange = () => save("morning", { targetTime: mt.value });
  const et = document.getElementById("evening-time");
  if (et) et.onchange = () => save("evening", { targetTime: et.value });
}

function onSwitch(name, checked) {
  if (name === "evening") return save("evening", { enabled: checked });
  if (name.startsWith("sig:")) return saveSignal(name.slice(4), checked);
  const tool =
    name === "news" ? MORNING_NEWS_TOOL : name === "sports" ? MORNING_SPORTS_TOOL : name.slice(4);
  const morning = findDefinition(state.definitions, "morning");
  return save("morning", {
    selectedToolNames: toggleToolName(morning?.selectedToolNames ?? [], tool)
  });
}

async function save(type, patch) {
  if (state.busy) return;
  state.busy = true;
  state.error = "";
  render();
  try {
    const current = findDefinition(state.definitions, type);
    if (current) await api.update(current.id, updateRequest(current, patch));
    else {
      await api.create(
        createRequest({
          briefingType: type,
          enabled: patch.enabled,
          targetTime: patch.targetTime,
          timezone: localZone()
        })
      );
    }
    await refresh();
  } catch (error) {
    state.error = error instanceof Error && error.message ? error.message : "Save failed";
  }
  state.busy = false;
  render();
}

async function saveSignal(key, enabled) {
  if (state.busy) return;
  state.busy = true;
  state.error = "";
  render();
  try {
    state.signals = await api.setSourceSignals({ [key]: enabled });
  } catch (error) {
    state.error = error instanceof Error && error.message ? error.message : "Save failed";
  }
  state.busy = false;
  render();
}

async function refresh() {
  const data = await api.definitions();
  state.definitions = data.definitions ?? [];
  state.externalSources = data.externalSources ?? [];
  state.signals = await api.sourceSignals().catch(() => ({}));
}

async function load() {
  state.phase = "loading";
  render();
  try {
    await refresh();
    state.phase = "ready";
  } catch {
    state.phase = "error";
  }
  render();
}

load();
