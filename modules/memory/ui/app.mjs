/* global document, window */
import { moduleClient } from "./guest-bridge.mjs";
import { memoryApi } from "./api.mjs";
import * as v from "./view.mjs";

const client = moduleClient();
const api = memoryApi(client);
const root = document.getElementById("root");
const narrowQuery = window.matchMedia("(max-width: 760px)");

const state = {
  tab: "saved",
  phase: "loading",
  facts: [],
  counts: { saved: 0, active: 0, stale: 0, pinned: 0, pending: 0 },
  cursors: [null],
  page: 0,
  hasMore: false,
  nextCursor: null,
  filters: { q: "", status: "", recordKind: "", sourceKind: "" },
  selected: null,
  mode: "view",
  adding: false,
  candidates: [],
  candidateCursor: null,
  candidateMore: false,
  dismissed: [],
  note: "",
  busy: false
};

const FAILURES = new Map([
  [404, "That memory is gone. The list has been refreshed."],
  [409, "That change conflicts with something already saved."]
]);

const selectedFact = () => state.facts.find((f) => f.id === state.selected) ?? null;

async function loadFacts() {
  const cursor = state.cursors[state.page];
  const params = { limit: 20, cursor, ...state.filters };
  if (state.tab === "history") {
    const [found, gone] = await Promise.all([
      api.facts({ ...params, view: "history", status: "", recordKind: "", sourceKind: "", q: "" }),
      api.candidates({ view: "history" })
    ]);
    Object.assign(state, {
      facts: found.items,
      counts: found.counts,
      hasMore: found.hasMore,
      nextCursor: found.nextCursor,
      dismissed: gone.items
    });
    return;
  }
  const found = await api.facts({ ...params, view: "saved" });
  Object.assign(state, {
    facts: found.items,
    counts: found.counts,
    hasMore: found.hasMore,
    nextCursor: found.nextCursor
  });
  if (!state.facts.some((f) => f.id === state.selected)) {
    state.selected = narrowQuery.matches ? null : (state.facts[0]?.id ?? null);
  }
}

async function loadCandidates(more) {
  const found = await api.candidates({
    view: "pending",
    cursor: more ? state.candidateCursor : undefined
  });
  state.candidates = more ? [...state.candidates, ...found.items] : found.items;
  state.candidateCursor = found.nextCursor;
  state.candidateMore = found.hasMore;
  state.counts = { ...state.counts, pending: found.total };
}

async function load({ keepPage = false } = {}) {
  state.phase = "loading";
  state.note = "";
  draw();
  try {
    if (!keepPage) {
      state.cursors = [null];
      state.page = 0;
    }
    if (state.tab === "review") {
      const found = await api.facts({ limit: 1, view: "saved" });
      state.counts = found.counts;
      await loadCandidates(false);
    } else {
      await loadFacts();
    }
    state.phase = "ready";
  } catch {
    state.phase = "broken";
  }
  draw();
}

function body() {
  const head = `<div class="phead"><h1>Memory &amp; context</h1><span class="head-links"><button class="jds-btn jds-btn--quiet jds-btn--sm" data-act="search-model">Search model</button></span></div>`;
  const top = `${head}${v.tabs(state.tab, state.counts.pending)}`;
  if (state.adding) return v.addForm();
  if (state.phase === "loading") return `${top}${v.skeleton()}`;
  if (state.phase === "broken") return `${top}${v.broken(false)}`;
  const note = state.note ? `<p class="note" role="status">${v.esc(state.note)}</p>` : "";
  if (state.tab === "review") {
    if (!state.candidates.length) {
      return `${top}${note}<div class="state"><div class="jds-empty"><div class="jds-empty__title">Nothing to review</div></div></div>`;
    }
    const more = state.candidateMore
      ? '<div class="pager"><span></span><button class="jds-btn jds-btn--secondary jds-btn--sm" data-act="more">Show more</button></div>'
      : "";
    return `${top}${note}<div class="list">${v.reviewRows(state.candidates)}${more}</div>`;
  }
  if (state.tab === "history") {
    const rows = v.historyRows(state.facts, state.dismissed);
    if (!rows) {
      return `${top}<div class="state"><div class="jds-empty"><div class="jds-empty__title">No history yet</div></div></div>`;
    }
    return `${top}<div class="list">${rows}</div>`;
  }
  const filtered = Object.values(state.filters).some(Boolean);
  if (!state.facts.length && !filtered && state.page === 0) return `${top}${v.empty()}`;
  const fact = selectedFact();
  const narrow = narrowQuery.matches;
  const list = `<div class="list">${v.factRows(state.facts, state.selected)}${v.pager(
    state.page,
    state.facts.length,
    state.hasMore,
    filtered ? null : state.counts.saved
  )}</div>`;
  const panel = fact ? `<div class="detail">${v.detail(fact, state.mode, narrow)}</div>` : "";
  if (narrow) {
    if (fact && state.detailOpen) return `${top}${note}${panel}`;
    return `${top}${v.filters(state.filters)}${v.counts(state.counts)}${note}${list}`;
  }
  return `${top}${v.filters(state.filters)}${v.counts(state.counts)}${note}<div class="split">${list}${panel}</div>`;
}

function draw() {
  const focus = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;
  root.innerHTML = body();
  if (focus === "q") {
    const field = document.getElementById("q");
    field.focus();
    if (caret != null) field.setSelectionRange(caret, caret);
  }
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

function fail(error) {
  state.note =
    error?.status === 409 && error.detail
      ? error.detail
      : (FAILURES.get(error?.status) ?? "That did not work. Try again.");
}

async function act(work, { reload = true } = {}) {
  if (state.busy) return;
  state.busy = true;
  state.note = "";
  try {
    await work();
    state.mode = "view";
    state.adding = false;
    if (reload) await load({ keepPage: true });
  } catch (error) {
    if (error?.status === 404 && reload) await load({ keepPage: true });
    fail(error);
    state.busy = false;
    draw();
    return;
  }
  state.busy = false;
}

const value = (id) => document.getElementById(id)?.value.trim() ?? "";
const dateOrNull = (text) => {
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const actions = {
  add: () => {
    state.adding = true;
    draw();
  },
  "cancel-add": () => {
    state.adding = false;
    draw();
  },
  cancel: () => {
    state.mode = "view";
    draw();
  },
  close: () => {
    state.detailOpen = false;
    state.mode = "view";
    draw();
  },
  retry: () => void load({ keepPage: true }),
  "search-model": () => void client.navigate("/settings/memory/search-model").catch(() => {}),
  correct: () => ((state.mode = "correct"), draw()),
  stale: () => ((state.mode = "stale"), draw()),
  replace: () => ((state.mode = "replace"), draw()),
  forget: () => ((state.mode = "forget"), draw()),
  pin: () => {
    const fact = selectedFact();
    return act(() => api.pin(fact.id, !fact.pinned));
  },
  confirm: () => act(() => api.confirm(state.selected)),
  "save-forget": () =>
    act(async () => {
      await api.forget(state.selected);
      state.detailOpen = false;
      state.selected = null;
    }),
  "save-correct": () => {
    const text = value("text");
    const [from, to] = [dateOrNull(value("from")), dateOrNull(value("to"))];
    if (!text || from === undefined || to === undefined) {
      state.note = "Enter the corrected text and dates as YYYY-MM-DD.";
      return draw();
    }
    return act(async () => {
      const saved = await api.correct(state.selected, text);
      state.selected = saved.fact.id;
      if (from || to) await api.patch(saved.fact.id, { validFrom: from, validTo: to });
    });
  },
  "save-stale": () => {
    const at = dateOrNull(value("stale-from"));
    if (at === undefined) {
      state.note = "Enter the date as YYYY-MM-DD.";
      return draw();
    }
    return act(async () => {
      await api.markStale(state.selected);
      if (at) await api.patch(state.selected, { staleAt: at });
    });
  },
  "save-replace": () => {
    const text = value("text");
    const old = selectedFact();
    if (!text) {
      state.note = "Enter the new memory.";
      return draw();
    }
    return act(async () => {
      const made = await api.remember({
        subjectEntityId: old.subjectEntityId,
        predicate: old.predicate,
        objectText: text,
        recordKind: old.recordKind,
        confidence: 1,
        provenance: "confirmed",
        importance: old.importance,
        pinned: old.pinned,
        source: {
          sourceKind: "manual",
          sourceRef: "memory-screen",
          sourceLabel: "Added by you",
          excerpt: text
        }
      });
      await api.supersede(old.id, null);
      state.selected = made.fact?.id ?? null;
    });
  },
  "save-add": () => {
    const text = value("text");
    if (!text) {
      state.note = "Enter what Moss should remember.";
      return draw();
    }
    const kind = value("kind") || "fact";
    const about = value("about");
    const pinned = document.getElementById("pin")?.checked === true;
    state.tab = "saved";
    return act(async () => {
      const made = await api.add({
        text,
        recordKind: kind,
        pinned,
        ...(about ? { about } : {})
      });
      state.selected = made.fact?.id ?? null;
    });
  },
  prev: () => {
    state.page -= 1;
    return load({ keepPage: true });
  },
  next: () => {
    state.cursors[state.page + 1] = state.nextCursor;
    state.page += 1;
    return load({ keepPage: true });
  },
  more: () => void loadCandidates(true).then(draw)
};

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-act],[data-tab],[data-fact]");
  if (!target) return;
  if (target.dataset.tab) {
    state.tab = target.dataset.tab;
    state.adding = false;
    state.selected = null;
    state.detailOpen = false;
    void load();
  } else if (target.dataset.fact) {
    state.selected = target.dataset.fact;
    state.mode = "view";
    state.detailOpen = true;
    draw();
  } else if (["accept", "reject", "suppress"].includes(target.dataset.act)) {
    const id = target.closest("[data-candidate]")?.dataset.candidate;
    if (id) void decide(id, target.dataset.act);
  } else if (target.dataset.act in actions) {
    void actions[target.dataset.act]();
  }
});

async function decide(id, action) {
  await act(() => api.decide(id, action, {}), { reload: false });
  if (state.note) return;
  if (action === "accept") await load({ keepPage: true });
  else decideDone(id);
}

function decideDone(id) {
  state.candidates = state.candidates.filter((c) => c.id !== id);
  state.counts = { ...state.counts, pending: Math.max(0, state.counts.pending - 1) };
  draw();
}

let timer = null;
root.addEventListener("input", (event) => {
  if (event.target.id === "q") {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filters.q = event.target.value.trim();
      void load();
    }, 300);
  }
});
root.addEventListener("change", (event) => {
  const map = { "f-status": "status", "f-kind": "recordKind", "f-source": "sourceKind" };
  if (map[event.target.id]) {
    state.filters[map[event.target.id]] = event.target.value;
    void load();
  }
});
root.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.dataset?.fact) {
    event.preventDefault();
    event.target.click();
  }
});
narrowQuery.addEventListener("change", draw);
void load();
