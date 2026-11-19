/* global document, window */
import { moduleClient } from "./guest-bridge.mjs";
import { meetingsApi } from "./api.mjs";
import { homeScreen } from "./home.mjs";
import { manualScreen } from "./manual.mjs";
import { recordScreen } from "./record.mjs";
import { linkDialog } from "./link.mjs";
import { codeFromHash } from "./devices-logic.mjs";

const client = moduleClient();
const api = meetingsApi(client);
const root = document.getElementById("root");

let route = { view: "home" };
let pendingFocus = null;
let drawing = false;

function focus(id) {
  pendingFocus = id;
}

function go(next) {
  if (route.view === "record" && next.view !== "record") record.leave();
  route = next;
  screen().start(next.id);
  draw();
  window.scrollTo?.(0, 0);
}

let admin = false;
const ctx = {
  api,
  draw,
  go,
  focus,
  isAdmin: () => admin,
  navigate: (path) => void client.navigate(path)
};
// The host tells the screen whether the viewer is an instance admin.
void client
  .theme()
  .then((theme) => {
    admin = theme?.isAdmin === true;
    // A Mac or phone that asks to link opens Moss at this screen with its code in the address.
    const code = codeFromHash(`#code=${theme?.linkCode ?? ""}`);
    if (code)
      void linkDialog({
        api,
        onLinked: () => void client.navigate("/settings/meetings?focus=linked")
      }).open(code);
    draw();
  })
  .catch(() => {});
const home = homeScreen(ctx);
const manual = manualScreen(ctx);
const record = recordScreen(ctx);
const screens = { home, manual, record };
const screen = () => screens[route.view];

function caretOf(node) {
  try {
    return { start: node.selectionStart, end: node.selectionEnd };
  } catch {
    return null;
  }
}

function draw() {
  const active = document.activeElement;
  const keep = pendingFocus ?? (active && active !== document.body ? active.id : null);
  const caret = !pendingFocus && active ? caretOf(active) : null;
  drawing = true;
  root.innerHTML = screen().render();
  drawing = false;
  const next = keep ? document.getElementById(keep) : null;
  if (next) next.focus({ preventScroll: true });
  else if (keep?.endsWith("-list")) root.querySelector(`#${keep} button:not(:disabled)`)?.focus();
  if (next && caret && caret.start !== null) next.setSelectionRange?.(caret.start, caret.end);
  pendingFocus = null;
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

function menuNav(event) {
  const list = event.target.closest?.('[role="menu"]');
  if (!list) return false;
  const items = [...list.querySelectorAll("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement);
  const next = {
    ArrowDown: (at + 1) % items.length,
    ArrowUp: (at + items.length - 1) % items.length,
    Home: 0,
    End: items.length - 1
  }[event.key];
  if (next === undefined) return false;
  event.preventDefault();
  items[next]?.focus();
  return true;
}

root.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-act]");
  if (!target) {
    if (route.view === "record" && !event.target.closest?.("[data-menu-root]")) record.closeMenu();
    return;
  }
  if (target.disabled) return;
  const act = target.dataset.act;
  if (act === "menu-toggle") {
    record.toggleMenu(target.dataset.menu);
    return;
  }
  if (route.view === "record" && !target.closest?.("[data-menu-root]")) record.ws.menuOpen = null;
  const handler = screen().acts[act];
  if (handler) handler(target);
});

root.addEventListener("input", (event) => {
  const name = event.target.dataset?.in;
  if (!name || event.target.tagName === "SELECT") return;
  screen().input(name, event.target.value);
});
root.addEventListener("change", (event) => {
  const name = event.target.dataset?.in;
  if (name && event.target.tagName === "SELECT") screen().input(name, event.target.value);
});
root.addEventListener("submit", (event) => {
  event.preventDefault();
  if (route.view === "manual") void manual.submit();
});
root.addEventListener("keydown", (event) => {
  if (route.view !== "record") return;
  if (menuNav(event)) return;
  if (event.key === "Escape" && record.ws.menuOpen) {
    const trigger = `${record.ws.menuOpen}-trigger`;
    record.closeMenu();
    document.getElementById(trigger)?.focus();
    event.preventDefault();
    return;
  }
  if (event.key === "Tab" && record.ws.menuOpen) record.closeMenu();
  record.key(event, event.target);
});
root.addEventListener("focusout", (event) => {
  if (drawing || route.view !== "record") return;
  record.blur(event.target);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && route.view === "record" && record.closeMenu())
    event.preventDefault();
});
document.addEventListener("pointerdown", (event) => {
  if (route.view === "record" && !event.target.closest?.("[data-menu-root]")) record.closeMenu();
});
window.matchMedia?.("(max-width: 760px)").addEventListener?.("change", (event) => {
  record.narrow(event.matches);
});

home.start();
draw();
