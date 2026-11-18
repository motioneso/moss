/* global document */
import { moduleClient } from "./guest-bridge.mjs";
import { backtrackApi } from "./api.mjs";
import * as v from "./view.mjs";

const client = moduleClient();
const api = backtrackApi(client);
const root = document.getElementById("root");

const ui = {
  now: () => new Date(),
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
function ask(kind) {
  const now = ui.now();
  if (kind === "hour") range = v.lastHourRange(now);
  else if (kind === "today") range = v.todayRange(now);
  else if (kind === "day") range = v.chosenDayRange(ui.day);
  else range = {};
  if (!range) return;
  ui.confirming = { kind, ...v.confirmation(kind, data, range) };
  draw();
}

const actions = {
  retry: () => load(false),
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
  confirm: () => {
    const { kind } = ui.confirming;
    ui.confirming = null;
    // "Last hour" means the hour before the person pressed Delete.
    const now = ui.now();
    if (kind === "hour") range = v.lastHourRange(now);
    else if (kind === "today") range = v.todayRange(now);
    void remove(range);
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

void load(false);
