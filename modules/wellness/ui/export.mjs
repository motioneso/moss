import { h, icon, PATHS, button, linkButton } from "./dom.mjs";

// Medication and insight export is not offered by the Rust routes yet, so only the two
// categories the server accepts are listed.
export const CATEGORIES = [
  ["checkins", "Mood check-ins"],
  ["therapyNotes", "Therapy notes"]
];
const SENSITIVE_COPY =
  "This export will contain sensitive health and wellness data. Anyone you share it with will see it. Generate only if you trust the recipient (e.g. your doctor or therapist).";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POLL_MS = 2000;

const validDay = (value) => {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/** Days in the range, or null when either end is not a real date or the range runs backwards. */
export function exportRangeDays(from, to) {
  if (!validDay(from) || !validDay(to) || from > to) return null;
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}

export function addDays(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** The 90 days up to `today`. */
export function defaultRange(today) {
  return { from: addDays(today, -90), to: today };
}

function browserToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The choice of dates, categories and the running export survives closing the dialog.
// Health content and the acknowledgement are never kept.
const draft = { from: null, to: null, categories: CATEGORIES.map(([key]) => key), jobId: null };

export function resetExportDraft() {
  Object.assign(draft, { from: null, to: null, categories: CATEGORIES.map(([key]) => key), jobId: null });
}

/** Opens the export dialog over the page. `api.call` reads and writes the Wellness routes.
 * `save({ filename, contentType, text })` hands the finished file to the page for download.
 * `today` is the person's calendar day (YYYY-MM-DD). Returns `{ close }`. */
export function openExportDialog({ api, save, today = browserToday(), returnFocus = null }) {
  const defaults = defaultRange(today);
  let acknowledged = false;
  let starting = false;
  let startError = null;
  let status = null; // The last export status reply, or an { unavailable: true } marker.
  let statusFailed = false;
  let downloadFailed = false;
  let timer = null;
  let closed = false;

  const body = h("div", { class: "jds-dialog__body" });
  const dialog = h(
    "div",
    {
      class: "jds-dialog wl-dialog wl-dialog--export",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "wl-export-title",
      "aria-describedby": "wl-export-desc",
      tabIndex: -1
    },
    h(
      "div",
      { class: "jds-dialog__head" },
      h(
        "div",
        { class: "jds-dialog__heading" },
        h("div", { class: "jds-dialog__title", id: "wl-export-title" }, "Export for a clinician"),
        h(
          "button",
          { type: "button", class: "jds-iconbtn", "aria-label": "Close export", onclick: close },
          icon(PATHS.close, { size: 18 })
        )
      ),
      h("div", { class: "jds-dialog__desc", id: "wl-export-desc" }, "Share")
    ),
    body,
    h("div", { class: "jds-dialog__foot" }, button("Close", { variant: "secondary", onclick: close }))
  );
  const scrim = h("div", { class: "jds-dialog-scrim" }, dialog);
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) close();
  });
  scrim.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const stops = [...dialog.querySelectorAll("button, input, a[href]")].filter((n) => !n.disabled);
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = scrim.getRootNode().activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    scrim.remove();
    acknowledged = false;
    returnFocus?.focus?.();
  }

  const from = () => draft.from ?? defaults.from;
  const to = () => draft.to ?? defaults.to;

  function check(label, checked, onchange, disabled, extra = {}) {
    const input = h("input", { type: "checkbox", checked, disabled, ...extra });
    input.addEventListener("change", () => onchange(input.checked));
    return h(
      "label",
      { class: "jds-check", style: extra.style },
      input,
      h("span", { class: "jds-check__box" }, icon('<polyline points="2,7 5,10 11,3"/>', { size: 13 })),
      label
    );
  }

  function field(id, label, value, { max, onchange, disabled }) {
    const input = h("input", { id, type: "date", class: "wl-input", value, max, disabled });
    input.addEventListener("change", () => onchange(input.value));
    return h("div", { class: "wl-field", style: "margin-bottom: 12px" }, h("label", { for: id, class: "wl-field__label" }, label), input);
  }

  function form() {
    const days = exportRangeDays(from(), to());
    const rangeValid = days !== null && days <= 366;
    const canGenerate = rangeValid && draft.categories.length > 0 && acknowledged && !starting;
    const failedMessage = startError ?? (status?.status === "failed" ? "Export failed." : null);
    const generate = button(starting ? "Starting…" : "Generate export", {
      iconPaths: PATHS.download,
      disabled: !canGenerate,
      onclick: start
    });
    return [
      h(
        "p",
        { class: "wl-modal__desc", style: "margin-bottom: 14px" },
        "Generate a printable document of your wellness data for a date range and the categories you choose. Open it in a browser and print to PDF to share."
      ),
      h("p", { class: "jds-note jds-note--practical wl-export-boundaries" }, "UTC days, up to 366."),
      rangeValid ? null : h("p", { role: "alert" }, "Choose a date range of up to 366 days."),
      field("wlexport-from", "From", from(), {
        max: to(),
        disabled: starting,
        onchange: (value) => {
          draft.from = value;
          paint();
        }
      }),
      field("wlexport-to", "To", to(), {
        max: defaults.to,
        disabled: starting,
        onchange: (value) => {
          draft.to = value;
          paint();
        }
      }),
      h(
        "fieldset",
        { class: "wl-fieldset", style: "margin-bottom: 12px" },
        h("legend", { class: "wl-field__label" }, "Include"),
        CATEGORIES.map(([key, label]) =>
          check(label, draft.categories.includes(key), (on) => {
            draft.categories = on ? [...draft.categories, key] : draft.categories.filter((c) => c !== key);
            paint();
          }, starting)
        )
      ),
      h(
        "label",
        { class: "jds-check", style: "margin-bottom: 14px; align-items: flex-start" },
        (() => {
          const input = h("input", { type: "checkbox", checked: acknowledged, disabled: starting });
          input.addEventListener("change", () => {
            acknowledged = input.checked;
            paint();
          });
          return input;
        })(),
        h("span", { class: "jds-check__box" }, icon('<polyline points="2,7 5,10 11,3"/>', { size: 13 })),
        h("span", { class: "wl-consent-text" }, SENSITIVE_COPY)
      ),
      failedMessage
        ? h("div", { class: "wl-modal__note wl-modal__note--error", role: "alert", style: "margin-bottom: 10px" }, failedMessage)
        : null,
      generate
    ];
  }

  function reset() {
    draft.jobId = null;
    status = null;
    statusFailed = false;
    startError = null;
    acknowledged = false;
    paint();
  }

  async function download() {
    downloadFailed = false;
    try {
      const file = await api.call("GET", `/wellness/export/${encodeURIComponent(draft.jobId)}/download`);
      await save({ filename: file.filename, contentType: file.contentType, text: file.html });
    } catch {
      downloadFailed = true;
      paint();
    }
  }

  function view() {
    const state = status?.status;
    const expiresAt = status?.expiresAt;
    const expired =
      state === "expired" || (state === "ready" && expiresAt && Date.parse(expiresAt) <= Date.now());
    if (!draft.jobId || state === "failed") return form();
    if (expired || status?.unavailable) {
      return [
        h(
          "div",
          { role: "status" },
          h("p", {}, expired ? "This export has expired." : "This export is no longer available."),
          button("Generate again", { onclick: reset })
        )
      ];
    }
    if (statusFailed) {
      return [h("p", { role: "alert" }, "Could not check your export. ", linkButton("Try again", () => void poll()))];
    }
    if (state === "ready") {
      return [
        h(
          "div",
          { class: "wl-modal__ready", role: "status" },
          h("p", { class: "wl-modal__note" }, "Your export is ready. Open it in a browser and print to PDF to share."),
          downloadFailed
            ? h("p", { class: "wl-modal__note wl-modal__note--error", role: "alert" }, "Could not download the export. Try again.")
            : null,
          h(
            "div",
            { style: "display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap" },
            button("Download", { size: "sm", iconPaths: PATHS.download, onclick: () => void download() }),
            button("Start a new export", { variant: "quiet", size: "sm", onclick: reset })
          )
        )
      ];
    }
    return [
      h(
        "div",
        { class: "wl-modal__progress", role: "status" },
        h("p", {}, "Building your export… this usually takes a few seconds.")
      )
    ];
  }

  function paint() {
    if (closed) return;
    const focused = scrim.getRootNode().activeElement?.id;
    body.replaceChildren(...view().filter(Boolean));
    if (focused) body.querySelector(`#${focused}`)?.focus?.();
  }

  async function poll() {
    clearTimeout(timer);
    if (closed || !draft.jobId) return;
    statusFailed = false;
    try {
      status = await api.call("GET", `/wellness/export/${encodeURIComponent(draft.jobId)}`);
    } catch (error) {
      if ([404, 410].includes(error?.status)) status = { unavailable: true };
      else statusFailed = true;
    }
    if (closed) return;
    paint();
    if (!statusFailed && (status?.status === "pending" || status?.status === "building")) {
      timer = setTimeout(() => void poll(), POLL_MS);
    }
  }

  async function start() {
    if (starting) return;
    starting = true;
    startError = null;
    paint();
    try {
      const reply = await api.call("POST", "/wellness/export", {
        from: from(),
        to: to(),
        categories: [...draft.categories]
      });
      draft.jobId = reply.jobId;
      status = { status: reply.status };
    } catch (error) {
      startError =
        error?.status === 409
          ? "Another export with different settings is in progress."
          : "Export failed.";
    } finally {
      starting = false;
    }
    paint();
    if (draft.jobId) void poll();
  }

  document.body.append(scrim);
  paint();
  dialog.focus();
  if (draft.jobId) void poll();
  return { close };
}
