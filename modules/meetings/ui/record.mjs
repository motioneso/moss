import {
  accessDenied,
  esc,
  meetingDate,
  notesProblem,
  randomKey,
  titleProblem
} from "./format.mjs";
import { alertHint, btn, empty, hint, menu, sectionHead, status, textarea, field } from "./kit.mjs";
import { transcriptPane } from "./transcript.mjs";
import { summaryPane } from "./summary.mjs";

const NARROW = "(max-width: 760px)";

/** One meeting page: header, title, type, notes, and the transcript and summary panes. */
export function recordScreen(ctx) {
  const { api, draw, go, focus } = ctx;
  const ws = newWorkspace();
  const transcript = transcriptPane(ctx, ws);
  const summary = summaryPane(ctx, ws);
  ctx.refreshRecord = () => void loadRecord(true);
  ctx.notesDirty = () => dirty();

  function newWorkspace() {
    return {
      id: null,
      phase: "loading",
      meeting: null,
      refreshFailed: false,
      tab: "notes",
      tool: null,
      menuOpen: null,
      showDelete: false,
      del: { busy: false, error: "" },
      narrow: globalThis.matchMedia?.(NARROW).matches ?? false,
      title: {
        editing: false,
        text: "",
        base: "",
        saving: false,
        error: null,
        conflict: undefined
      },
      notes: {
        base: null,
        text: "",
        pending: null,
        phase: "idle",
        latest: null,
        loading: false,
        loadFailed: false
      },
      type: { state: "loading", data: null, busy: false, failed: false },
      transcript: {
        phase: "loading",
        data: null,
        search: null,
        evidence: null,
        evidenceState: "none"
      },
      outputs: { phase: "loading", data: null }
    };
  }

  /* ---------- loading ---------- */

  async function loadRecord(quiet) {
    const id = ws.id;
    try {
      const { meeting } = await api.record(id);
      if (ws.id !== id) return;
      ws.meeting = meeting;
      ws.phase = "ready";
      ws.refreshFailed = false;
      if (!ws.title.editing && !ws.title.saving && ws.title.text === ws.title.base) {
        ws.title.text = ws.title.base = meeting.title;
      }
      const n = ws.notes;
      if (
        !n.base ||
        (n.phase === "idle" && !dirty() && meeting.notesRevision > n.base.notesRevision)
      ) {
        ws.notes = { ...ws.notes, base: meeting, text: meeting.personalNotes };
      }
    } catch (error) {
      if (ws.id !== id) return;
      if (quiet && ws.meeting) ws.refreshFailed = true;
      else ws.phase = accessDenied(error) && error.status === 404 ? "notfound" : "failed";
    }
    draw();
  }

  async function loadType() {
    const id = ws.id;
    ws.type.state = ws.type.data ? "ready" : "loading";
    try {
      const data = await api.recording(id);
      if (ws.id !== id) return;
      ws.type = { ...ws.type, state: "ready", data };
    } catch (error) {
      if (ws.id !== id) return;
      ws.type.state = accessDenied(error) ? "denied" : "failed";
    }
    draw();
  }

  function dirty() {
    const n = ws.notes;
    return !!n.base && (n.text !== n.base.personalNotes || n.pending !== null);
  }

  function start(id, params) {
    Object.assign(ws, newWorkspace(), { id });
    ws.transcript.evidence = params;
    ws.tab = params && ws.narrow ? "transcript" : "notes";
    void loadRecord(false);
    void loadType();
    transcript.start();
    summary.start();
  }

  /* ---------- title ---------- */

  async function saveTitle() {
    const t = ws.title;
    if (t.saving || t.conflict !== undefined) return;
    const sent = t.text.trim();
    const problem = titleProblem(t.text);
    if (problem) {
      t.error = problem;
      draw();
      return;
    }
    if (sent === t.base) {
      t.text = sent;
      t.error = null;
      t.editing = false;
      draw();
      return;
    }
    const id = ws.id;
    t.saving = true;
    t.error = null;
    draw();
    try {
      const { meeting } = await api.putTitle(id, { title: sent, expectedTitle: t.base });
      if (ws.id !== id) return;
      ws.meeting = { ...ws.meeting, title: meeting.title, updatedAt: meeting.updatedAt };
      Object.assign(t, {
        base: meeting.title,
        text: t.text.trim() === sent ? meeting.title : t.text,
        saving: false,
        error: null,
        editing: false
      });
    } catch (error) {
      if (ws.id !== id) return;
      if (error?.status === 409) {
        try {
          const latest = await api.record(id);
          Object.assign(t, {
            saving: false,
            conflict: latest.meeting.title,
            error: "The title changed elsewhere. Your title is kept."
          });
        } catch {
          Object.assign(t, { saving: false, error: "Couldn’t load the current title. Try again." });
        }
      } else Object.assign(t, { saving: false, error: "Couldn’t save the title. Try again." });
    }
    draw();
  }

  /* ---------- notes ---------- */

  let noteTimer = null;
  function scheduleNotes() {
    clearTimeout(noteTimer);
    const n = ws.notes;
    if (!dirty() || notesProblem(n.text) || n.phase !== "idle") return;
    noteTimer = setTimeout(() => void saveNotes(), 650);
  }

  async function loadCurrentNotes() {
    const id = ws.id;
    ws.notes.loading = true;
    ws.notes.loadFailed = false;
    draw();
    try {
      const { meeting } = await api.record(id);
      if (ws.id !== id) return;
      if (ws.notes.phase === "conflict") ws.notes.latest = meeting;
    } catch {
      if (ws.id === id) ws.notes.loadFailed = true;
    }
    ws.notes.loading = false;
    draw();
  }

  async function saveNotes() {
    const n = ws.notes;
    if (!n.base || n.phase === "saving" || n.phase === "conflict") return;
    if (!n.pending && (notesProblem(n.text) || !dirty())) return;
    const id = ws.id;
    n.pending ??= {
      expectedRevision: n.base.notesRevision,
      personalNotes: n.text,
      requestKey: randomKey()
    };
    n.phase = "saving";
    const sent = n.pending;
    draw();
    try {
      const result = await api.putNotes(id, sent);
      if (ws.id !== id || ws.notes.pending?.requestKey !== sent.requestKey) return;
      ws.notes = { ...ws.notes, base: result.meeting, pending: null, phase: "idle", latest: null };
      ws.meeting = {
        ...ws.meeting,
        personalNotes: result.meeting.personalNotes,
        notesRevision: result.meeting.notesRevision
      };
    } catch (error) {
      if (ws.id !== id) return;
      const conflict = error?.status === 409;
      ws.notes.pending = error?.status === 400 ? null : ws.notes.pending;
      ws.notes.phase = conflict ? "conflict" : "failed";
      draw();
      if (conflict) await loadCurrentNotes();
      return;
    }
    draw();
    scheduleNotes();
  }

  /* ---------- type, delete ---------- */

  async function changeType(typeId) {
    const t = ws.type;
    if (t.busy || !t.data) return;
    const id = ws.id;
    t.busy = true;
    t.failed = false;
    draw();
    try {
      await api.putRecordingType(id, { expectedRevision: t.data.metadata?.revision ?? 0, typeId });
      if (ws.id !== id) return;
      await loadType();
    } catch {
      if (ws.id !== id) return;
      t.failed = true;
      await loadType();
    }
    ws.type.busy = false;
    draw();
  }

  async function removeMeeting() {
    if (ws.del.busy) return;
    ws.del = { busy: true, error: "" };
    draw();
    try {
      await api.remove(ws.id);
      ws.showDelete = false;
      go({ view: "home" });
    } catch (error) {
      const code = error?.code;
      ws.del = {
        busy: false,
        error:
          code === "meeting_cleanup_pending"
            ? "Recording cleanup is pending or a notes folder is unavailable. Restore folder access if needed, then retry deletion. The recording is still here."
            : code === "meeting_cleanup_conflict"
              ? "A note from this recording changed. Review its current contribution and preserve unrelated text before retrying deletion. The recording is still here."
              : "Couldn’t confirm deletion. You can retry or cancel without losing your edits here."
      };
      draw();
    }
  }

  /* ---------- rendering ---------- */

  function showSummary() {
    return (
      !!ws.transcript.data?.snapshot.segments.length ||
      !!ws.outputs.data?.headVersion ||
      ws.tool !== null ||
      ws.tab === "summary"
    );
  }

  function typeChip() {
    const t = ws.type;
    if (t.state === "denied") return "";
    if (t.state === "failed")
      return `<p role="alert" class="jds-hint">Couldn’t load recording type. ${btn("Try again", "type-retry", { variant: "link" })}</p>`;
    if (!t.data) return status("Loading recording type…");
    const types = t.data.configuration.types;
    const current = types.find((x) => x.id === t.data.metadata?.typeId);
    const name = current?.name ?? "Automatic";
    const chip = menu(
      "meeting-type",
      `Recording type: ${name}`,
      esc(name),
      types
        .filter((x) => !x.retired)
        .map((x) => ({
          act: "type-pick",
          data: `data-type="${esc(x.id)}"`,
          label: esc(x.name),
          checked: x.id === t.data.metadata?.typeId,
          disabled: t.busy
        })),
      ws.menuOpen === "meeting-type",
      { chip: true }
    );
    return `<div class="meetings-section"><div class="meetings-actions">${chip}${
      t.data.metadata?.side
        ? `<span class="jds-badge jds-badge--neutral jds-badge--pill">${t.data.metadata.side === "personal" ? "Personal" : "Work"}</span>`
        : ""
    }${t.busy ? '<span role="status" class="jds-hint">Saving type…</span>' : ""}</div>${
      t.failed ? alertHint("Couldn’t save the type. Review the current value and try again.") : ""
    }</div>`;
  }

  function titleBlock() {
    const t = ws.title;
    const head = t.editing
      ? `<input id="meeting-title-input" aria-label="Meeting title" class="jds-input meetings-input" data-in="title" value="${esc(t.text)}" maxlength="240"${t.saving ? " disabled" : ""} />`
      : `<div class="jds-section-head"><h1 class="jds-section-head__title"><button type="button" class="jds-rowbtn" id="meeting-title-edit" aria-label="Edit meeting title" data-act="title-edit">${esc(t.text)}</button></h1></div>`;
    return `<div class="meetings-title">${head}${t.saving ? '<span class="jds-hint">Saving…</span>' : ""}${
      t.error
        ? `<p role="alert" class="jds-hint">${esc(t.error)} ${
            t.conflict !== undefined
              ? `<span>Current title: ${esc(t.conflict)}. </span>${btn("Keep my title", "title-keep", { variant: "link" })}${btn("Load current title", "title-load", { variant: "link" })}`
              : btn("Retry title save", "title-retry", { variant: "link" })
          }</p>`
        : ""
    }</div>`;
  }

  function notesBlock() {
    const n = ws.notes;
    const isDirty = dirty();
    const valid = !notesProblem(n.text);
    const line =
      n.phase === "saving"
        ? "Saving…"
        : n.phase === "failed"
          ? "Couldn’t save. Your edits are kept here."
          : n.phase === "conflict"
            ? "Notes changed elsewhere. Review the saved version."
            : isDirty
              ? "Unsaved changes"
              : "Saved";
    return `<section class="meetings-section" aria-label="Personal notes">${sectionHead("Notes")}
${textarea("meeting-personal-notes", n.text, { label: "Notes", placeholder: "Add a note…", max: 64000, cls: "meetings-notes", model: "notes" })}
<p class="jds-hint" id="meeting-notes-status" role="status"${!isDirty && n.phase === "idle" && !n.text ? " hidden" : ""}>${line}</p>
${n.phase === "failed" ? btn("Retry save", "notes-retry", { variant: "link", disabled: !valid && !n.pending }) : ""}
${!valid ? alertHint("Shorten these notes or remove unsupported characters before saving.") : ""}
${
  n.phase === "conflict"
    ? `<div class="meetings-section">${n.loading ? hint("Loading current notes…") : ""}${n.loadFailed ? alertHint("Couldn’t load current notes. Your edits have not been replaced.") : ""}${
        n.latest
          ? `${field("meeting-current-notes", "Current saved notes", textarea("meeting-current-notes", n.latest.personalNotes, { rows: 6, readonly: true, model: "current-notes" }))}${btn("Keep my version", "notes-keep", { variant: "secondary" })}`
          : btn("Load current notes", "notes-load", { variant: "secondary", disabled: n.loading })
      }</div>`
    : ""
}</section>`;
  }

  function tabs(items) {
    const value = !ws.narrow && ws.tab === "transcript" ? "notes" : ws.tab;
    return `<div class="jds-tabs__root"><div class="jds-tabs__list" role="tablist" aria-label="Meeting sections"${items.length < 2 ? " hidden" : ""}>${items
      .map(
        (i) =>
          `<button type="button" class="jds-tabs__tab" id="meeting-review-tab-${i.value}" role="tab" aria-selected="${value === i.value}" aria-controls="meeting-review-panel-${i.value}" tabindex="${value === i.value ? 0 : -1}" data-act="tab" data-tab="${i.value}">${i.label}</button>`
      )
      .join("")}</div>${items
      .map(
        (i) =>
          `<div class="jds-tabs__panel" id="meeting-review-panel-${i.value}"${items.length > 1 ? ` role="tabpanel" aria-labelledby="meeting-review-tab-${i.value}"` : ""}${value !== i.value ? " hidden" : ""}>${i.html}</div>`
      )
      .join("")}</div>`;
  }

  function dialog() {
    const m = ws.meeting;
    return `<div class="jds-dialog-scrim" data-scrim="delete"><div class="jds-dialog meetings-dialog" role="dialog" aria-modal="true" aria-labelledby="meeting-delete-title" tabindex="-1"><div class="jds-dialog__head"><div class="jds-dialog__heading"><div class="jds-dialog__title"><span id="meeting-delete-title">Delete this meeting?</span></div></div></div><div class="jds-dialog__body"><p>“${esc(m.title)}”, its personal notes, transcript revisions, generated versions, and meeting chat will be permanently deleted. This cannot be undone. Unsaved edits will be lost. Exact source-linked note contributions and unsupported recording memories are removed first. Accepted Tasks and independent saved vault copies remain.</p>${ws.del.error ? alertHint(esc(ws.del.error)) : ""}</div><div class="jds-dialog__foot">${btn("Cancel", "delete-cancel", { variant: "secondary", id: "delete-cancel", disabled: ws.del.busy })}${btn(ws.del.busy ? "Deleting…" : "Permanently delete meeting", "delete-confirm", { variant: "danger", disabled: ws.del.busy })}</div></div></div>`;
  }

  function render() {
    if (ws.phase === "loading") return status("Loading meeting…");
    if (ws.phase !== "ready")
      return empty(
        ws.phase === "notfound" ? "This meeting is unavailable" : "Couldn’t load this meeting",
        "",
        `${btn("Try again", "record-retry")}${btn("Meetings", "back", { variant: "link" })}`
      );
    const m = ws.meeting;
    const showTab = showSummary();
    const tPane = transcript.render();
    const items = [
      ...(ws.narrow ? [{ value: "transcript", label: "Transcript", html: tPane }] : []),
      { value: "notes", label: "Notes", html: notesBlock() },
      ...(showTab ? [{ value: "summary", label: "Summary", html: summary.render() }] : [])
    ];
    const menuNode = menu(
      "meeting-actions",
      "Meeting actions",
      '<span aria-hidden="true">•••</span>',
      [
        { act: "tool", data: 'data-tool="search"', label: "Search transcript" },
        { act: "tool", data: 'data-tool="rewrite"', label: "Rewrite summary" },
        { act: "tool", data: 'data-tool="versions"', label: "Earlier versions" },
        { act: "tool", data: 'data-tool="vault"', label: "Save to vault" },
        { act: "tool", data: 'data-tool="copy"', label: "Copy as Markdown" },
        {
          act: "tool",
          data: 'data-tool="delete"',
          label: "Delete meeting",
          disabled: ws.notes.phase === "saving"
        }
      ],
      ws.menuOpen === "meeting-actions"
    );
    return `${ws.refreshFailed ? `<p role="status" class="jds-hint">Couldn’t refresh this meeting. ${btn("Try again", "record-refresh", { variant: "link" })}</p>` : ""}
<section class="meetings-section" aria-label="Meeting workspace">
<header class="meetings-record-heading"><div>${btn("Meetings", "back", { variant: "link" })}</div><div class="meetings-actions meetings-record-tools">${menuNode}</div></header>
${titleBlock()}
${typeChip()}
${m.title !== "Untitled meeting" ? hint(esc(meetingDate(m.createdAt))) : ""}
<div class="meetings-workspace">${ws.narrow ? "" : tPane}${tabs(items)}</div>
${showTab ? "" : `<div hidden>${summary.render()}</div>`}
${ws.showDelete ? dialog() : ""}
</section>`;
  }

  /* ---------- events ---------- */

  const acts = {
    back: () => go({ view: "home" }),
    "record-retry": () => {
      ws.phase = "loading";
      draw();
      void loadRecord(false);
    },
    "record-refresh": () => void loadRecord(true),
    tab: (el) => {
      ws.tab = el.dataset.tab;
      draw();
    },
    tool: (el) => {
      const tool = el.dataset.tool;
      ws.menuOpen = null;
      if (tool === "delete") {
        ws.showDelete = true;
        ws.del = { busy: false, error: "" };
        focus("delete-cancel");
      } else if (tool === "search") {
        ws.transcript.search = "";
        if (ws.narrow) ws.tab = "transcript";
        focus("meeting-transcript-search");
      } else {
        ws.tool = tool;
        ws.tab = "summary";
        summary.openTool();
      }
      draw();
    },
    "type-pick": (el) => {
      ws.menuOpen = null;
      void changeType(el.dataset.type);
      draw();
    },
    "type-retry": () => void loadType(),
    "title-edit": () => {
      ws.title.editing = true;
      focus("meeting-title-input");
      draw();
    },
    "title-keep": () => {
      Object.assign(ws.title, {
        base: ws.title.conflict,
        conflict: undefined,
        error: null,
        editing: true
      });
      focus("meeting-title-input");
      draw();
    },
    "title-load": () => {
      Object.assign(ws.title, {
        text: ws.title.conflict,
        base: ws.title.conflict,
        conflict: undefined,
        error: null,
        editing: false
      });
      draw();
    },
    "title-retry": () => {
      ws.title.editing = true;
      void saveTitle();
    },
    "notes-retry": () => void saveNotes(),
    "notes-load": () => void loadCurrentNotes(),
    "notes-keep": () => {
      const n = ws.notes;
      if (n.latest) ws.notes = { ...n, base: n.latest, phase: "idle", latest: null };
      draw();
      scheduleNotes();
    },
    "delete-cancel": () => {
      if (ws.del.busy) return;
      ws.showDelete = false;
      draw();
    },
    "delete-confirm": () => void removeMeeting(),
    ...transcript.acts,
    ...summary.acts
  };

  return {
    start,
    render,
    acts,
    narrow(value) {
      if (ws.narrow === value) return;
      ws.narrow = value;
      draw();
    },
    input(name, value) {
      if (name === "title") ws.title.text = value;
      else if (name === "notes") {
        ws.notes.text = value;
        const node = globalThis.document?.getElementById("meeting-notes-status");
        if (node && ws.notes.phase === "idle") {
          node.hidden = false;
          node.textContent = dirty() ? "Unsaved changes" : "Saved";
        }
        scheduleNotes();
      } else if (!transcript.input(name, value)) summary.input(name, value);
    },
    /** Returns true when the key was handled. */
    key(event, target) {
      if (target.id === "meeting-title-input") {
        if (event.key === "Enter") {
          event.preventDefault();
          void saveTitle();
          return true;
        }
        if (event.key === "Escape") {
          Object.assign(ws.title, {
            text: ws.meeting.title,
            base: ws.meeting.title,
            saving: false,
            error: null,
            editing: false
          });
          draw();
          return true;
        }
      }
      if (target.getAttribute?.("role") === "tab") {
        const tabsEls = [...target.parentElement.querySelectorAll('[role="tab"]')];
        const index = tabsEls.indexOf(target);
        const next = {
          ArrowRight: (index + 1) % tabsEls.length,
          ArrowLeft: (index + tabsEls.length - 1) % tabsEls.length,
          Home: 0,
          End: tabsEls.length - 1
        }[event.key];
        if (next !== undefined) {
          event.preventDefault();
          ws.tab = tabsEls[next].dataset.tab;
          focus(tabsEls[next].id);
          draw();
          return true;
        }
      }
      if (ws.showDelete && event.key === "Escape" && !ws.del.busy) {
        ws.showDelete = false;
        draw();
        return true;
      }
      return false;
    },
    blur(target) {
      if (target.id === "meeting-title-input" && ws.title.editing) void saveTitle();
    },
    /** Closes any open menu. Returns true when something closed. */
    closeMenu() {
      if (!ws.menuOpen) return false;
      ws.menuOpen = null;
      draw();
      return true;
    },
    toggleMenu(id) {
      ws.menuOpen = ws.menuOpen === id ? null : id;
      focus(ws.menuOpen ? `${id}-list` : `${id}-trigger`);
      draw();
    },
    ws
  };
}
