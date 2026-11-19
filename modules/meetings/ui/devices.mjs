import { esc } from "./format.mjs";
import { btn, empty, field, input, sectionHead, status } from "./kit.mjs";
import { APP_LINKS, detailLine, isAndroid, presence, renameCheck } from "./devices-logic.mjs";

const mac = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>`;
const phone = `<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/></svg>`;
const icon = (device) => `<span class="pair-icon">${isAndroid(device) ? phone : mac}</span>`;

const denied = (error) => error?.status === 401 || error?.status === 403;

/** The Devices list behind the Meetings cog: rename, unlink and the dialogs that follow. */
export function devicesSection({ api, draw, linked = false }) {
  const s = {
    phase: "loading",
    list: [],
    renaming: null,
    unlinking: null,
    notice: "",
    focus: null,
    justLinked: linked
  };

  async function load() {
    s.phase = s.list.length ? "ready" : "loading";
    draw();
    try {
      s.list = (await api.deviceList()).devices ?? [];
      s.phase = "ready";
      if (s.justLinked) {
        const newest = [...s.list].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
        )[0];
        s.notice = newest ? `${newest.displayName} is linked.` : "";
        s.newId = newest?.id;
      }
    } catch (error) {
      s.phase = denied(error) ? "denied" : "failed";
    }
    draw();
  }

  const byId = (id) => s.list.find((d) => d.id === id);

  function row(d) {
    if (s.renaming?.id === d.id) {
      const r = s.renaming;
      return `<div class="set-row pair-row">${icon(d)}<div class="set-row__main">${field(
        "device-name",
        "Name",
        input("device-name", r.value, { model: "device-name", max: 64, disabled: r.busy }),
        r.error ? `<p role="alert" class="jds-hint jds-hint--error">${esc(r.error)}</p>` : ""
      )}</div><div class="set-row__control pair-actions">${btn("Cancel", "rename-cancel", { variant: "secondary", disabled: r.busy })}${btn(r.busy ? "Saving…" : "Save", "rename-save", { disabled: r.busy })}</div></div>`;
    }
    const p = presence(d);
    return `<div class="set-row pair-row${d.id === s.newId ? " pair-row--new" : ""}">${icon(d)}<div class="set-row__main"><div class="pair-name">${esc(d.displayName)}</div><div class="pair-meta"><span class="jds-indicator jds-indicator--${p.tone}"><span class="jds-indicator__dot"></span><span>${esc(p.text)}</span></span><span>${esc(detailLine(d))}</span></div></div><div class="set-row__control pair-actions">${btn("Rename", "rename-start", { variant: "quiet", data: `data-id="${esc(d.id)}" id="rename-${esc(d.id)}"` })}${btn("Unlink", "unlink-ask", { variant: "quiet", data: `data-id="${esc(d.id)}" id="unlink-${esc(d.id)}"` })}</div></div>`;
  }

  function getApps() {
    const link = (label, href) =>
      href
        ? `<a class="jds-btn jds-btn--secondary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : btn(label, "no-link", { variant: "secondary", disabled: true });
    return [
      link("Get the Mac app", APP_LINKS.mac),
      link("Get the Android app", APP_LINKS.android)
    ].join("");
  }

  function render() {
    return `<section class="pair-section">${body()}</section>`;
  }

  function body() {
    const head = sectionHead("Devices");
    if (s.phase === "denied")
      return `${head}<p role="alert" class="jds-hint jds-hint--error">Devices could not be verified. Sign in again.</p>`;
    if (s.phase === "loading") return `${head}${status("Checking your devices…")}`;
    if (s.phase === "failed")
      return `${head}<p role="alert" class="jds-hint jds-hint--error">Couldn’t load your devices. ${btn("Try again", "devices-reload", { variant: "link" })}</p>`;
    const note = s.notice ? `<p class="pair-status" role="status">${esc(s.notice)}</p>` : "";
    const problem = s.problem
      ? `<p role="alert" class="jds-hint jds-hint--error">${esc(s.problem)}</p>`
      : "";
    if (!s.list.length) return `${head}${problem}${empty("No devices linked", "", getApps())}`;
    return `${head}${note}${problem}<div>${s.list.map(row).join("")}</div><div class="pair-get">${getApps()}</div>`;
  }

  /** The unlink confirmation, drawn after everything else so it sits over the screen. */
  function dialog() {
    const u = s.unlinking;
    const d = u && byId(u.id);
    if (!d) return "";
    return `<div class="jds-dialog-scrim"><div class="jds-dialog pair-dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title"><div class="jds-dialog__head"><div class="jds-dialog__heading"><div class="jds-dialog__title" id="dlg-title">Unlink ${esc(d.displayName)}?</div></div></div><div class="jds-dialog__body"><p>It stops ${isAndroid(d) ? "recording and bringing in ring recordings" : "recording and sending screen history"} until you link it again.</p>${u.error ? `<p role="alert" class="jds-hint jds-hint--error">${esc(u.error)}</p>` : ""}</div><div class="jds-dialog__foot">${btn("Cancel", "unlink-cancel", { variant: "secondary", id: "unlink-cancel", disabled: u.busy })}${btn(u.busy ? "Unlinking…" : "Unlink", "unlink-confirm", { variant: "danger", id: "unlink-confirm", disabled: u.busy })}</div></div></div>`;
  }

  async function saveRename() {
    const r = s.renaming;
    if (!r || r.busy) return;
    const checked = renameCheck(r.value);
    if (checked.error) {
      r.error = checked.error;
      draw();
      return;
    }
    r.busy = true;
    r.error = "";
    draw();
    try {
      await api.renameDevice(r.id, checked.name);
      const d = byId(r.id);
      if (d) d.displayName = checked.name;
      s.focus = `rename-${r.id}`;
      s.renaming = null;
      s.notice = "";
    } catch (error) {
      r.busy = false;
      r.error =
        error?.status === 404
          ? "That device is no longer linked."
          : "Couldn’t save the name. Try again.";
    }
    draw();
  }

  async function confirmUnlink() {
    const u = s.unlinking;
    if (!u || u.busy) return;
    u.busy = true;
    u.error = "";
    draw();
    try {
      await api.unlinkDevice(u.id);
    } catch (error) {
      // A device that is already gone counts as unlinked.
      if (error?.status !== 404) {
        u.busy = false;
        u.error = "Couldn’t unlink it. Try again.";
        draw();
        return;
      }
    }
    s.list = s.list.filter((d) => d.id !== u.id);
    s.unlinking = null;
    s.notice = "";
    draw();
  }

  const acts = {
    "devices-reload": () => void load(),
    "rename-start": (t) => {
      const d = byId(t.dataset.id);
      if (!d) return;
      s.renaming = { id: d.id, value: d.displayName, error: "", busy: false };
      s.notice = "";
      s.focus = "device-name";
      draw();
    },
    "rename-cancel": () => {
      s.focus = s.renaming ? `rename-${s.renaming.id}` : null;
      s.renaming = null;
      draw();
    },
    "rename-save": () => void saveRename(),
    "unlink-ask": (t) => {
      s.unlinking = { id: t.dataset.id, busy: false, error: "" };
      s.opener = `unlink-${t.dataset.id}`;
      s.focus = "unlink-cancel";
      draw();
    },
    "unlink-cancel": () => {
      if (s.unlinking?.busy) return;
      s.unlinking = null;
      s.focus = s.opener ?? null;
      draw();
    },
    "unlink-confirm": () => void confirmUnlink()
  };

  return {
    start: load,
    render,
    dialog,
    acts,
    isOpen: () => Boolean(s.unlinking),
    takeFocus() {
      const id = s.focus;
      s.focus = null;
      return id;
    },
    input(name, value) {
      if (name === "device-name" && s.renaming) {
        s.renaming.value = value;
        s.renaming.error = "";
      }
    },
    submit() {
      if (s.renaming) void saveRename();
    },
    escape() {
      if (s.unlinking) acts["unlink-cancel"]();
      else if (s.renaming) acts["rename-cancel"]();
    }
  };
}
