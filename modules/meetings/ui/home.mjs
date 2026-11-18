import { esc, meetingDate, meetingLength } from "./format.mjs";
import { btn, field, hint, input, select, status, alertHint } from "./kit.mjs";

const PAGE_SIZE = 30;

/** Meetings home: search box, type filter and the table of meetings. */
export function homeScreen({ api, draw, go }) {
  const s = {
    query: "",
    typeId: "",
    types: { state: "loading", list: [] },
    list: { phase: "loading", items: [], next: null, moreBusy: false },
    searching: false
  };
  let timer = null;
  let seq = 0;

  async function loadTypes() {
    s.types = { state: "loading", list: [] };
    try {
      const reply = await api.recordingTypes();
      s.types = { state: "ready", list: reply.types ?? [] };
    } catch {
      s.types = { state: "failed", list: [] };
    }
    draw();
  }

  async function search(more = false) {
    const mine = ++seq;
    if (more) s.list.moreBusy = true;
    else {
      s.list = { ...s.list, phase: s.list.items.length ? "ready" : "loading" };
      s.searching = true;
    }
    draw();
    try {
      const body = { query: s.query.trim(), filter: "all", limit: PAGE_SIZE };
      if (s.typeId) body.typeId = s.typeId;
      if (more && s.list.next) body.before = s.list.next;
      const page = await api.search(body);
      if (mine !== seq) return;
      s.list = {
        phase: "ready",
        items: more ? [...s.list.items, ...page.meetings] : page.meetings,
        next: page.nextCursor ?? null,
        moreBusy: false
      };
    } catch (error) {
      if (mine !== seq) return;
      const phase =
        error?.status === 401 || error?.status === 403
          ? "denied"
          : error?.status === 400
            ? "toolong"
            : "failed";
      s.list = { phase, items: [], next: null, moreBusy: false };
    }
    s.searching = false;
    draw();
  }

  function render() {
    const { list, types } = s;
    const q = s.query.trim();
    const rows = list.items
      .map((m) => {
        const type = m.recording?.typeId
          ? (types.list.find((t) => t.id === m.recording.typeId)?.name ?? m.recording.typeId)
          : null;
        return `<tr class="meetings-history-row"><td><button type="button" class="jds-rowbtn meetings-history-title" data-act="open" data-id="${esc(m.id)}">${esc(m.title)}</button></td><td><span>${esc(meetingDate(m.date.at))}</span><span class="jds-hint meetings-history-date-source">${m.date.source === "recorded" ? "Recorded" : "Added"}</span></td><td>${meetingLength(m.capture?.durationMs)}</td><td>—</td><td>${
          type ? `<span class="jds-badge jds-badge--neutral jds-badge--pill">${esc(type)}</span>` : "—"
        }${
          m.recording?.side
            ? `<span class="jds-hint meetings-history-side">${m.recording.side === "personal" ? "Personal" : "Work"}</span>`
            : ""
        }</td></tr>`;
      })
      .join("");
    const failure =
      list.phase === "denied"
        ? "Meetings are unavailable. Sign in again or retry."
        : list.phase === "toolong"
          ? "Shorten your search and try again."
          : list.phase === "failed"
            ? "Couldn’t load meetings."
            : null;
    const showTable = list.phase === "ready" && !s.searching && list.items.length;
    return `<div class="meetings-list-heading">${btn("Add recording", "add")}</div>
<section class="meetings-section" aria-label="Your meetings">
<div class="meetings-history-filters">
${field("meeting-history-search", "Search meetings", input("meeting-history-search", s.query, { type: "search", max: 256, placeholder: "Search titles, notes and transcripts", model: "query" }))}
${field("meeting-history-type", "Recording type", select("meeting-history-type", [["", "All types"], ...types.list.map((t) => [t.id, t.name])], s.typeId, { model: "typeId", disabled: types.state !== "ready" }))}
</div>
${types.state === "failed" ? `<p role="alert" class="jds-hint">Couldn’t load recording types. ${btn("Try again", "types-retry", { variant: "link" })}</p>` : ""}
${list.phase === "loading" || s.searching ? status("Loading meetings…") : ""}
${failure ? `<p role="alert" class="jds-hint jds-hint--error">${failure} ${btn("Try again", "history-retry", { variant: "link" })}</p>` : ""}
${list.phase === "ready" && !list.items.length && !s.searching ? hint(q || s.typeId ? "No meetings match this search." : "No meetings yet. Start with Add recording or New meeting.") : ""}
${showTable ? `<div class="meetings-history-scroll"><table class="meetings-history-table"><thead><tr><th scope="col">Title</th><th scope="col">Date</th><th scope="col">Length</th><th scope="col">Attendees</th><th scope="col">Type</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
${list.next && !s.searching && list.phase === "ready" ? btn(list.moreBusy ? "Loading more…" : "Load older meetings", "more", { variant: "secondary", disabled: list.moreBusy }) : ""}
</section>`;
  }

  return {
    start() {
      if (s.types.state !== "ready") void loadTypes();
      void search();
    },
    render,
    input(name, value) {
      if (name === "query") {
        s.query = value;
        clearTimeout(timer);
        timer = setTimeout(() => void search(), 250);
      } else if (name === "typeId") {
        s.typeId = value;
        void search();
      }
    },
    acts: {
      add: () => go({ view: "manual" }),
      open: (el) => go({ view: "record", id: el.dataset.id }),
      more: () => void search(true),
      "history-retry": () => void search(),
      "types-retry": () => void loadTypes()
    }
  };
}
