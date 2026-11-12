/** Pure rendering for the Memory screen. Every value from the server is escaped here. */
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const SOURCES = {
  chat: "Chat",
  note: "Note",
  task: "Task",
  email: "Email",
  calendar: "Calendar",
  manual: "Added by you"
};
export const KINDS = {
  fact: "Fact",
  preference: "Preference",
  goal: "Goal",
  decision: "Decision",
  constraint: "Constraint",
  relationship: "Relationship"
};
const STATUS = {
  active: ["Active", "forest"],
  stale: ["Stale", "amber"],
  conflicting: ["Conflicting", "amber"],
  superseded: ["Superseded", "neutral"],
  expired: ["Expired", "neutral"],
  rejected: ["Rejected", "neutral"]
};
const PIN =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3z"/></svg>';

export function shortDate(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
const badge = (text, tone) => `<span class="jds-badge jds-badge--${tone}">${esc(text)}</span>`;
export const sourceName = (fact) => SOURCES[fact.sources?.[0]?.sourceKind] ?? "Unknown";
export const kindName = (fact) => KINDS[fact.recordKind] ?? fact.recordKind;
export const factTitle = (fact) => fact.objectText || fact.predicate || "Memory";

function factBadges(fact) {
  const [label, tone] = STATUS[fact.status] ?? [fact.status, "neutral"];
  const pin = fact.pinned ? `<span class="pin" title="Pinned">${PIN}</span>` : "";
  const sure =
    fact.status === "active" || fact.status === "stale" || fact.status === "conflicting"
      ? fact.confidenceTier === "confirmed"
        ? badge("Confirmed", "pine")
        : badge("Unconfirmed", "outline")
      : "";
  return `${pin}${badge(label, tone)}${sure}`;
}

export function factRows(facts, selected) {
  return facts
    .map(
      (fact) =>
        `<div class="row" role="button" tabindex="0" data-fact="${esc(fact.id)}"${
          fact.id === selected ? ' aria-current="true"' : ""
        }><div><p>${esc(factTitle(fact))}</p><small>${esc(sourceName(fact))} &middot; ${esc(
          shortDate(fact.createdAt)
        )}</small></div><div class="meta">${factBadges(fact)}</div></div>`
    )
    .join("");
}

export function historyRows(facts, dismissed) {
  const old = facts.map((fact) => {
    const [label, tone] = STATUS[fact.status] ?? [fact.status, "neutral"];
    return `<div class="row quiet"><div><p>${esc(factTitle(fact))}</p><small>${esc(
      shortDate(fact.updatedAt)
    )}</small></div><div class="meta">${badge(label, tone)}</div></div>`;
  });
  const gone = dismissed.map(
    (item) =>
      `<div class="row quiet"><div><p>${esc(item.title)}</p><small>Suggestion &middot; ${esc(
        shortDate(item.createdAt)
      )}</small></div><div class="meta">${badge(
        item.status === "suppressed" ? "Never suggest" : "Dismissed",
        "neutral"
      )}</div></div>`
  );
  return [...old, ...gone].join("");
}

export function reviewRows(items) {
  return items
    .map((item) => {
      const kind = KINDS[item.recordKind] ?? "Memory";
      const why = item.provenance === "volunteered" ? "You said this" : "Moss noticed this";
      return `<div class="row quiet" data-candidate="${esc(item.id)}"><div><p>${esc(
        item.title
      )}${item.titleTruncated ? "&hellip;" : ""}</p><small>${esc(kind)} &middot; ${esc(why)} &middot; ${esc(
        shortDate(item.createdAt)
      )}</small></div><div class="meta"><button class="jds-btn jds-btn--primary jds-btn--sm" data-act="accept">Accept</button><button class="jds-btn jds-btn--secondary jds-btn--sm" data-act="reject">Dismiss</button><button class="jds-btn jds-btn--quiet jds-btn--sm" data-act="suppress" title="Never suggest this again">Never suggest</button></div></div>`;
    })
    .join("");
}

function kv(fact) {
  const row = (name, value) => `<dt>${name}</dt><dd>${esc(value)}</dd>`;
  return `<dl class="kv">${row("Source", sourceName(fact))}${row("Kind", kindName(fact))}${row(
    "Valid from",
    shortDate(fact.validFrom) || "Not set"
  )}${row("Valid to", shortDate(fact.validTo) || "Not set")}${row(
    "Saved",
    shortDate(fact.createdAt)
  )}</dl>`;
}
const btn = (label, act, tone = "secondary", extra = "") =>
  `<button class="jds-btn jds-btn--${tone} jds-btn--sm" data-act="${act}"${extra}>${label}</button>`;
const back = (narrow) =>
  narrow ? '<button class="back" data-act="close">&larr; Saved memories</button>' : "";
const input = (id, label, value = "", placeholder = "Optional") =>
  `<div class="jds-field"><label class="jds-label" for="${id}">${label}</label><input class="jds-input" id="${id}" value="${esc(value)}" placeholder="${placeholder}"></div>`;
const area = (id, label, value = "") =>
  `<div class="jds-field"><label class="jds-label" for="${id}">${label}</label><textarea class="jds-textarea" id="${id}" rows="3">${esc(value)}</textarea></div>`;

export function detail(fact, mode, narrow) {
  const head = `${back(narrow)}<h2>${esc(factTitle(fact))}</h2>`;
  if (mode === "correct") {
    return `<div class="sheet">${back(narrow)}<h2>Correct this memory</h2><div class="form">${area(
      "text",
      "What Moss remembers",
      factTitle(fact)
    )}<div class="two">${input("from", "Valid from", "", "YYYY-MM-DD")}${input(
      "to",
      "Valid to",
      "",
      "YYYY-MM-DD"
    )}</div></div><div class="acts">${btn("Save correction", "save-correct", "primary")}${btn(
      "Cancel",
      "cancel",
      "quiet"
    )}</div></div>`;
  }
  if (mode === "stale") {
    return `<div class="sheet">${head}<div class="confirm"><p><b>Mark this memory stale?</b></p>${input(
      "stale-from",
      "Stale from",
      "",
      "Today"
    )}<div class="acts">${btn("Mark stale", "save-stale", "primary")}${btn(
      "Cancel",
      "cancel",
      "quiet"
    )}</div></div></div>`;
  }
  if (mode === "replace") {
    return `<div class="sheet">${back(narrow)}<h2>Replace this memory</h2><dl class="kv"><dt>Old</dt><dd><s>${esc(
      factTitle(fact)
    )}</s></dd></dl><div class="form">${area("text", "New memory")}</div><div class="acts">${btn(
      "Replace",
      "save-replace",
      "primary"
    )}${btn("Cancel", "cancel", "quiet")}</div></div>`;
  }
  const forgetting =
    mode === "forget"
      ? `<div class="confirm"><p><b>Forget this memory?</b></p><div class="acts">${btn(
          "Forget",
          "save-forget",
          "danger"
        )}${btn("Cancel", "cancel", "quiet")}</div></div>`
      : "";
  const live = fact.status === "active" || fact.status === "stale" || fact.status === "conflicting";
  const actions = live
    ? `<div class="acts">${btn(`${PIN} ${fact.pinned ? "Unpin" : "Pin"}`, "pin", "quiet")}${btn(
        "Confirm",
        "confirm"
      )}${btn("Correct", "correct")}${btn("Replace", "replace")}${btn("Mark stale", "stale")}${btn(
        "Forget",
        "forget",
        "quiet"
      )}</div>`
    : "";
  return `<div class="sheet">${head}<div class="badges">${factBadges(fact)}</div>${kv(
    fact
  )}${actions}${forgetting}</div>`;
}

export function addForm() {
  const kinds = Object.entries(KINDS)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  return `<div class="form add"><button class="back" data-act="cancel-add">&larr; Saved memories</button><h2>Add a memory</h2>${area(
    "text",
    "What should Moss remember?"
  )}<div class="two"><div class="jds-field"><label class="jds-label" for="kind">Kind</label><select class="jds-select" id="kind">${kinds}</select></div>${input(
    "about",
    "About",
    "",
    "Person or thing (optional)"
  )}</div><label class="check"><input type="checkbox" class="jds-checkbox" id="pin"> Pin it</label><div class="acts">${btn(
    "Save memory",
    "save-add",
    "primary"
  )}${btn("Cancel", "cancel-add", "quiet")}</div></div>`;
}

export function skeleton() {
  let rows = "";
  for (let i = 0; i < 5; i += 1) {
    rows += `<div class="row"><div><div class="sk w${i}"></div><div class="sk short"></div></div><div class="sk badge-sk"></div></div>`;
  }
  return `<div class="list" role="status" aria-label="Loading memories">${rows}</div>`;
}

export function empty() {
  return '<div class="state"><div class="jds-empty"><div class="jds-empty__title">No memories yet</div><div class="jds-empty__actions"><button class="jds-btn jds-btn--primary" data-act="add">Add a memory</button></div></div></div>';
}

export function broken() {
  return `<div class="state" role="alert"><div class="jds-empty"><div class="jds-empty__title">Memories did not load</div><div class="jds-empty__sub">The memory service is not answering.</div><div class="jds-empty__actions"><button class="jds-btn jds-btn--primary" data-act="retry">Try again</button></div></div></div>`;
}

export function counts(c) {
  const n = (value, label) => `<span><b>${Number(value) || 0}</b> ${label}</span>`;
  return `<div class="counts">${n(c.saved, "saved")}${n(c.active, "active")}${n(c.stale, "stale")}${n(
    c.pinned,
    "pinned"
  )}</div>`;
}

export function filters(f) {
  const opts = (map, current, any) =>
    `<option value="">${any}</option>${Object.entries(map)
      .map(([v, l]) => `<option value="${v}"${v === current ? " selected" : ""}>${l}</option>`)
      .join("")}`;
  return `<div class="filters"><input class="jds-input" id="q" type="search" placeholder="Search memories" value="${esc(
    f.q
  )}"><select class="jds-select" id="f-status">${opts(
    { active: "Active", stale: "Stale" },
    f.status,
    "Any status"
  )}</select><select class="jds-select" id="f-kind">${opts(
    KINDS,
    f.recordKind,
    "Any kind"
  )}</select><select class="jds-select" id="f-source">${opts(
    SOURCES,
    f.sourceKind,
    "Any source"
  )}</select></div>`;
}

export function tabs(tab, pending) {
  const label = { review: "To review", saved: "Saved memories", history: "History" };
  return `<div class="tabs" role="tablist">${["review", "saved", "history"]
    .map(
      (key) =>
        `<button role="tab" data-tab="${key}" aria-selected="${tab === key}">${label[key]}${
          key === "review" && pending > 0
            ? `<span class="jds-badge jds-badge--solid-amber">${pending}</span>`
            : ""
        }</button>`
    )
    .join(
      ""
    )}<span class="grow"></span><button class="jds-btn jds-btn--primary jds-btn--sm add" data-act="add">Add a memory</button></div>`;
}

export function pager(page, count, hasMore, total) {
  const from = count ? page * 20 + 1 : 0;
  const range = `${from} to ${page * 20 + count}${total != null ? ` of ${total}` : ""}`;
  return `<div class="pager"><span>${range}</span><span><button class="jds-btn jds-btn--quiet jds-btn--sm" data-act="prev"${
    page === 0 ? " disabled" : ""
  }>Previous</button> <button class="jds-btn jds-btn--secondary jds-btn--sm" data-act="next"${
    hasMore ? "" : " disabled"
  }>Next</button></span></div>`;
}
