/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { backtrackApi } from "./api.mjs";
import * as v from "./view.mjs";

const client = moduleClient();
const api = backtrackApi(client);
const root = document.getElementById("root");

const ui = {
  now: () => new Date(),
  tz: { state: "loading", timezone: null, date: null },
  confirming: null,
  choosingDay: false,
  day: "",
  pending: false,
  pausing: false,
  pauseFailed: false,
  deleteFailed: false,
  result: null
};
let phase = "loading";
let data = null;

function draw() {
  const focus = document.activeElement?.id;
  if (phase === "loading") root.innerHTML = v.loading();
  else if (phase === "broken") root.innerHTML = v.broken();
  else root.innerHTML = v.screen(data, ui);
  if (focus) document.getElementById(focus)?.focus();
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

async function load(quiet) {
  if (!quiet) {
    phase = "loading";
    draw();
  }
  try {
    data = await api.status();
    phase = "ready";
  } catch {
    if (!quiet || !data) phase = "broken";
  }
  draw();
}

async function loadZone() {
  ui.tz = { state: "loading", timezone: null, date: null };
  try {
    const day = await api.localDay(0);
    ui.tz = { state: "ready", timezone: day.timezone, date: day.date };
  } catch {
    ui.tz = { state: "failed", timezone: null, date: null };
  }
  draw();
}

// The account's own midnight-to-midnight range for a day the server names.
async function dayRange(offsetDays) {
  const day = await api.localDay(offsetDays);
  return { from: day.start, to: day.nextStart, timezone: day.timezone };
}

async function setPaused(paused) {
  ui.pausing = true;
  ui.pauseFailed = false;
  draw();
  try {
    await api.setPaused(paused);
  } catch {
    ui.pauseFailed = true;
  }
  ui.pausing = false;
  await load(true);
}

async function remove(range) {
  ui.pending = true;
  ui.deleteFailed = false;
  ui.result = null;
  draw();
  try {
    ui.result = await api.remove(range);
  } catch {
    ui.deleteFailed = true;
  }
  ui.pending = false;
  await load(true);
}

let range = null;
async function ask(kind) {
  try {
    if (kind === "hour") range = v.lastHourRange(ui.now());
    else if (kind === "today") range = await dayRange(0);
    else if (kind === "day") {
      const back = v.daysBack(ui.tz.date, ui.day);
      if (back === undefined) return;
      range = await dayRange(back);
    } else range = {};
  } catch {
    ui.deleteFailed = true;
    draw();
    return;
  }
  ui.deleteFailed = false;
  ui.confirming = { kind, ...v.confirmation(kind, data, range) };
  draw();
  document.getElementById("bt-cancel")?.focus();
}

const actions = {
  retry: () => {
    void loadZone();
    return load(false);
  },
  "retry-tz": () => loadZone(),
  choose: () => {
    ui.choosingDay = !ui.choosingDay;
    draw();
  },
  hour: () => ask("hour"),
  today: () => ask("today"),
  day: () => ask("day"),
  all: () => ask("all"),
  cancel: () => {
    ui.confirming = null;
    draw();
  },
  confirm: async () => {
    const { kind } = ui.confirming;
    ui.confirming = null;
    try {
      // "Last hour" and "Today" mean the span before the person pressed Delete.
      if (kind === "hour") range = v.lastHourRange(ui.now());
      else if (kind === "today") range = await dayRange(0);
    } catch {
      ui.deleteFailed = true;
      draw();
      return;
    }
    const { from, to } = range;
    await remove(kind === "all" ? {} : { from, to });
  }
};

root.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-act]");
  if (target && !target.disabled) actions[target.dataset.act]?.();
});
root.addEventListener("change", (event) => {
  if (event.target.id === "bt-recording") void setPaused(!event.target.checked);
  if (event.target.id === "bt-day") {
    ui.day = event.target.value;
    draw();
  }
});

void loadZone();
void load(false);
