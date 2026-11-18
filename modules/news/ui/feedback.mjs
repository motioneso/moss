/* global document */
// The "..." menu on each story, with the reason form and the saved receipt.
import { ICONS, esc } from "./view.mjs";

const SAVED = "Preference saved. Manage or remove it in News settings.";

export function createFeedback({ api, onChange, onDismiss }) {
  const items = new Map();
  let focusNext = null;

  const stateFor = (id) => {
    if (!items.has(id)) {
      items.set(id, { open: false, reasonOpen: false, reason: "", error: null, phase: "idle" });
    }
    return items.get(id);
  };
  const closeOthers = (id) => {
    for (const [other, item] of items) if (other !== id) item.open = false;
  };

  function html(headline) {
    const id = headline.id;
    const s = stateFor(id);
    const busy = s.phase === "pending";
    const label = `Feedback for ${headline.title}`;
    const dis = busy ? " disabled" : "";
    const menu = s.open
      ? `<div class="jds-menu__list" role="menu" aria-label="${esc(label)}">` +
        `<button type="button" role="menuitem" tabindex="-1" data-fb-item="${esc(id)}" data-kind="more_like_this"${dis}>${ICONS.up}More like this</button>` +
        `<button type="button" role="menuitem" tabindex="-1" data-fb-item="${esc(id)}" data-kind="less_like_this"${dis}>${ICONS.down}Less like this</button></div>`
      : "";
    const form = s.reasonOpen
      ? `<form class="nw-feedback__form" data-fb-form="${esc(id)}"><label for="fb-${esc(id)}">Why less like this?</label>` +
        `<textarea id="fb-${esc(id)}" data-fb-reason="${esc(id)}" maxlength="500"${dis}>${esc(s.reason)}</textarea>` +
        (s.error ? `<span role="alert">${esc(s.error)}</span>` : "") +
        `<div class="nw-feedback__actions"><button type="button" class="jds-btn jds-btn--quiet jds-btn--sm" data-fb-cancel="${esc(id)}"${dis}>Cancel</button>` +
        `<button type="submit" class="jds-btn jds-btn--primary jds-btn--sm"${dis}>${busy ? "Saving..." : "Save"}</button></div></form>`
      : "";
    const receipt =
      s.phase === "idle"
        ? ""
        : `<div class="nw-feedback__receipt"><div class="jds-note jds-note--practical"><span role="${s.phase === "error" ? "alert" : "status"}">${
            s.phase === "pending"
              ? "Saving feedback…"
              : s.phase === "error"
                ? "Could not save that feedback. Try again."
                : SAVED
          }</span></div></div>`;
    return (
      `<div class="nw-feedback"><div class="jds-menu">` +
      `<button type="button" class="jds-menu__trigger" aria-label="${esc(label)}" aria-expanded="${s.open}" aria-haspopup="menu" data-fb-trigger="${esc(id)}">${ICONS.more}</button>` +
      `${menu}</div>${form}${receipt}</div>`
    );
  }

  async function save(id, kind, reason) {
    const s = stateFor(id);
    s.phase = "pending";
    onChange();
    try {
      await api.feedback(id, kind, reason);
    } catch {
      s.phase = "error";
      onChange();
      return;
    }
    s.reasonOpen = false;
    s.reason = "";
    s.phase = "success";
    if (kind === "less_like_this") onDismiss(id);
    else onChange();
  }

  function submit(id) {
    const s = stateFor(id);
    if (s.phase === "pending") return;
    const trimmed = s.reason.trim();
    if (!trimmed) {
      s.error = "Tell us why before saving.";
      focusNext = { id, part: "reason" };
      onChange();
      return;
    }
    s.error = null;
    void save(id, "less_like_this", trimmed);
  }

  const idOf = (target, attr) => target.closest(`[${attr}]`)?.getAttribute(attr) ?? null;

  return {
    html,
    // Returns true when the event belonged to the feedback controls.
    click(event) {
      const trigger = idOf(event.target, "data-fb-trigger");
      if (trigger !== null) {
        const s = stateFor(trigger);
        closeOthers(trigger);
        s.open = !s.open;
        focusNext = s.open ? { id: trigger, part: "firstItem" } : null;
        onChange();
        return true;
      }
      const item = event.target.closest("[data-fb-item]");
      if (item) {
        const id = item.getAttribute("data-fb-item");
        const s = stateFor(id);
        if (s.phase === "pending") return true;
        s.open = false;
        s.phase = "idle";
        if (item.getAttribute("data-kind") === "less_like_this") {
          s.reasonOpen = true;
          focusNext = { id, part: "reason" };
          onChange();
        } else void save(id, "more_like_this");
        return true;
      }
      const cancel = idOf(event.target, "data-fb-cancel");
      if (cancel !== null) {
        const s = stateFor(cancel);
        s.reasonOpen = false;
        s.error = null;
        onChange();
        return true;
      }
      // A click anywhere else closes an open menu.
      let closed = false;
      for (const s of items.values()) {
        if (s.open && !event.target.closest(".jds-menu")) {
          s.open = false;
          closed = true;
        }
      }
      if (closed) onChange();
      return event.target.closest(".nw-feedback") !== null;
    },
    submit(event) {
      const id = idOf(event.target, "data-fb-form");
      if (id === null) return false;
      event.preventDefault();
      submit(id);
      return true;
    },
    input(event) {
      const id = idOf(event.target, "data-fb-reason");
      if (id === null) return false;
      const s = stateFor(id);
      s.reason = event.target.value;
      s.error = null;
      return true;
    },
    key(event) {
      const root = event.target.closest(".nw-feedback");
      if (!root) return false;
      const id = root.querySelector("[data-fb-trigger]")?.getAttribute("data-fb-trigger") ?? null;
      if (id === null) return false;
      const s = stateFor(id);
      if (event.key === "Escape" && (s.open || s.reasonOpen)) {
        event.preventDefault();
        if (s.phase === "pending") return true;
        if (s.open) focusNext = { id, part: "trigger" };
        s.open = false;
        s.reasonOpen = false;
        s.error = null;
        onChange();
        return true;
      }
      if (s.open && event.key === "Tab") {
        s.open = false;
        onChange();
        return false;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const list = [...root.querySelectorAll('[role="menuitem"]:not(:disabled)')];
        if (!s.open && event.target.matches("[data-fb-trigger]") && event.key !== "Home") {
          event.preventDefault();
          closeOthers(id);
          s.open = true;
          focusNext = { id, part: event.key === "ArrowUp" ? "lastItem" : "firstItem" };
          onChange();
          return true;
        }
        if (list.length === 0) return false;
        event.preventDefault();
        const at = list.indexOf(document.activeElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? list.length - 1
              : (at + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        list[next].focus();
        return true;
      }
      return false;
    },
    // Puts the focus where the last action left it, once the page has been redrawn.
    afterRender(root) {
      if (!focusNext) return;
      const { id, part } = focusNext;
      focusNext = null;
      const host = [...root.querySelectorAll("[data-fb-trigger]")]
        .find((el) => el.getAttribute("data-fb-trigger") === id)
        ?.closest(".nw-feedback");
      if (!host) return;
      if (part === "trigger") host.querySelector("[data-fb-trigger]")?.focus();
      else if (part === "reason") host.querySelector("textarea")?.focus();
      else {
        const list = host.querySelectorAll('[role="menuitem"]');
        (part === "lastItem" ? list[list.length - 1] : list[0])?.focus();
      }
    }
  };
}
