/* global document, window */
import { moduleClient } from "./guest-bridge.mjs";
import { mealsApi } from "./api.mjs";
import { esc } from "./format.mjs";
import { eatersScreen, moveScreen, textScreen } from "./arrange.mjs";
import { householdScreen } from "./household.mjs";
import { caption, segmented } from "./kit.mjs";
import { listScreen } from "./list.mjs";
import { logScreen } from "./log.mjs";
import { pantryScreen } from "./pantry.mjs";
import { planScreen } from "./plan.mjs";
import { planNewScreen } from "./plan-new.mjs";
import { recipeScreen } from "./recipe.mjs";
import { swapScreen } from "./swap.mjs";

const client = moduleClient();
const api = mealsApi(client);
const root = document.getElementById("root");

const TABS = [
  ["plan", "Plan"],
  ["list", "Shopping list"],
  ["pantry", "Pantry"],
  ["household", "Household"],
  ["log", "Log"]
];

// Views reached from the Plan highlight the Plan tab.
const PLAN_VIEWS = ["recipe", "swap", "move", "eaters", "text", "new"];

let route = { view: "plan" };
let pendingFocus = null;
let notice = null;

function draw() {
  const active = document.activeElement;
  const keep = pendingFocus ?? (active && active !== document.body ? active.id : null);
  const caret = !pendingFocus && active ? caretOf(active) : null;
  const tab = PLAN_VIEWS.includes(route.view) ? "plan" : route.view;
  root.innerHTML = `<div class="mls-tabs">${segmented("Meals areas", TABS, tab)}</div>${
    notice ? caption(esc(notice), ' role="status"') : ""
  }${screen().render()}`;
  const next = keep ? document.getElementById(keep) : null;
  if (next) next.focus({ preventScroll: true });
  if (next && caret && caret.start !== null) next.setSelectionRange?.(caret.start, caret.end);
  pendingFocus = null;
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

function caretOf(node) {
  try {
    return { start: node.selectionStart, end: node.selectionEnd };
  } catch {
    return null;
  }
}

function go(next) {
  screen().stop?.();
  route = next;
  notice = null;
  screen().start(next.id);
  draw();
  window.scrollTo?.(0, 0);
}

const ctx = {
  api,
  draw,
  go,
  focus: (id) => {
    pendingFocus = id;
  },
  current: () => route.view,
  // The screen has no chat of its own, so a refused request points the person to Moss chat.
  chat: async (prompt) => {
    try {
      await client.chat(prompt);
    } catch {
      notice = "Open the Moss chat from the main window and ask there.";
      draw();
    }
  }
};

const screens = {
  plan: planScreen(ctx),
  list: listScreen(ctx),
  pantry: pantryScreen(ctx),
  household: householdScreen(ctx),
  log: logScreen(ctx),
  recipe: recipeScreen(ctx),
  swap: swapScreen(ctx),
  move: moveScreen(ctx),
  eaters: eatersScreen(ctx),
  text: textScreen(ctx),
  new: planNewScreen(ctx)
};
const screen = () => screens[route.view];

root.addEventListener("click", (event) => {
  const scrim = event.target.dataset?.scrim;
  if (scrim) {
    screen().acts[scrim]?.(event.target);
    return;
  }
  const target = event.target.closest?.("[data-act]");
  if (!target || target.disabled) return;
  if (target.tagName === "A") event.preventDefault();
  const act = target.dataset.act;
  if (act === "tab") {
    if (target.dataset.tab !== route.view) go({ view: target.dataset.tab });
    return;
  }
  screen().acts[act]?.(target);
});

root.addEventListener("change", (event) => {
  const target = event.target;
  const name = target.dataset?.in;
  if (name && target.tagName === "SELECT") screen().input(name, target.value);
});

root.addEventListener("input", (event) => {
  const name = event.target.dataset?.in;
  if (!name || event.target.tagName === "SELECT") return;
  screen().input(name, event.target.value);
  if (name === "find" || name === "f-staple") draw();
});

root.addEventListener("keydown", (event) => {
  const enter = event.target.dataset?.enter;
  if (event.key === "Enter" && enter) {
    event.preventDefault();
    screen().acts[enter]?.(event.target);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && root.querySelector(".jds-dialog")) {
    screen().acts["dialog-close"]?.(event.target);
  }
});

screens.plan.start();
draw();
