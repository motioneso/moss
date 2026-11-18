/* global document */
import { clear, h, svg } from "./dom.mjs";

const icon = (d, size = 15) =>
  svg({ viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, d);

/** Followed leagues first, then every selected league grouped by sport and region. */
export function buildStandingsPickerGroups(catalog, follows, selectedCompetitionKeys, activeCompetitionKeys = []) {
  const byKey = new Map(catalog.map((c) => [c.competitionKey, c]));
  const active = new Set(activeCompetitionKeys);
  const followedKeys = Array.from(new Set(follows.map((f) => f.competitionKey)))
    .filter((key) => byKey.has(key))
    .filter((key) => byKey.get(key)?.kind !== "tournament" || active.has(key));
  const followed = new Set(followedKeys);
  const selected = selectedCompetitionKeys === null ? new Set(catalog.map((c) => c.competitionKey)) : new Set(selectedCompetitionKeys.filter((key) => byKey.has(key)));
  const groups = [];
  if (followedKeys.length > 0) {
    groups.push({ label: "Following", regions: [{ label: null, competitions: followedKeys.flatMap((key) => (byKey.get(key) ? [byKey.get(key)] : [])) }] });
  }
  const sports = new Map();
  for (const competition of catalog) {
    if (followed.has(competition.competitionKey) || !selected.has(competition.competitionKey)) continue;
    const regions = sports.get(competition.sportLabel) ?? new Map();
    const entries = regions.get(competition.regionLabel) ?? [];
    entries.push(competition);
    regions.set(competition.regionLabel, entries);
    sports.set(competition.sportLabel, regions);
  }
  for (const [label, regions] of sports) {
    groups.push({ label, regions: Array.from(regions, ([regionLabel, competitions]) => ({ label: regionLabel, competitions })) });
  }
  return groups;
}

const rowKey = (row) => (row.kind === "competition" ? `competition:${row.competition.competitionKey}` : row.kind === "back" ? "back" : `${row.kind}:${row.label}`);

/** The nested league menu. Opens at the root, steps into a sport and region, and is fully keyboard driven. */
export function standingsPicker({ catalog, follows, selectedCompetitionKeys, activeCompetitionKeys, value, onChange }) {
  const groups = buildStandingsPickerGroups(catalog, follows, selectedCompetitionKeys, activeCompetitionKeys ?? []);
  const following = groups.find((g) => g.label === "Following");
  const sports = groups.filter((g) => g.label !== "Following");
  const current = catalog.find((c) => c.competitionKey === value);
  let open = false;
  let view = { level: "root" };
  let focusTarget = "current";
  let rowEls = [];

  const root = h("span", { class: "jds-menu sp-standings-picker" });
  const trigger = h(
    "button",
    { type: "button", class: "jds-btn jds-btn--field jds-btn--sm", "aria-label": "Select standings league", "aria-haspopup": "menu", "aria-expanded": "false" },
    h("span", {}, current?.label ?? "Select league"),
    icon("M6 9l6 6 6-6", 14)
  );
  root.append(trigger);
  let popup = null;

  function sectionsFor() {
    if (view.level === "root") {
      const out = [];
      const followed = following?.regions.flatMap((r) => r.competitions) ?? [];
      if (followed.length > 0) out.push({ label: "Following", rows: followed.map((competition) => ({ kind: "competition", competition })) });
      if (sports.length > 0) out.push({ label: "Sports", rows: sports.map((g) => ({ kind: "sport", label: g.label })) });
      return out;
    }
    const sport = sports.find((g) => g.label === view.sportLabel);
    if (!sport) return [];
    if (view.level === "region") {
      const region = sport.regions.find((r) => r.label === view.regionLabel);
      return region ? [{ label: "Leagues", rows: region.competitions.map((competition) => ({ kind: "competition", competition })) }] : [];
    }
    const regionRows = sport.regions.filter((r) => r.label !== null).map((r) => ({ kind: "region", label: r.label, sportLabel: sport.label }));
    const directRows = sport.regions.filter((r) => r.label === null).flatMap((r) => r.competitions.map((competition) => ({ kind: "competition", competition })));
    return [...(regionRows.length > 0 ? [{ label: "Countries and regions", rows: regionRows }] : []), ...(directRows.length > 0 ? [{ label: "Leagues", rows: directRows }] : [])];
  }

  const backRow = () => (view.level === "root" ? null : { kind: "back", target: view.level === "region" ? { level: "sport", sportLabel: view.sportLabel } : { level: "root" } });

  function close(restoreFocus) {
    open = false;
    paint();
    if (restoreFocus) queueMicrotask(() => trigger.focus());
  }
  function go(next) {
    focusTarget = "first";
    view = next;
    paint();
  }
  function activate(row) {
    if (row.kind === "competition") {
      onChange(row.competition.competitionKey);
      close(true);
    } else if (row.kind === "sport") go({ level: "sport", sportLabel: row.label });
    else if (row.kind === "region") go({ level: "region", sportLabel: row.sportLabel, regionLabel: row.label });
    else go(row.target);
  }
  function openPicker(target = "current") {
    focusTarget = target;
    view = { level: "root" };
    open = true;
    paint();
  }

  function onRowKey(event, index, row, rows) {
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (key === "Tab") {
      open = false;
      paint();
    } else if (key === "ArrowLeft" && view.level !== "root") {
      event.preventDefault();
      activate(backRow());
    } else if (key === "ArrowRight" && (row.kind === "sport" || row.kind === "region")) {
      event.preventDefault();
      activate(row);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
      event.preventDefault();
      const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 : key === "ArrowDown" ? (index + 1) % rows.length : (index - 1 + rows.length) % rows.length;
      rowEls[next]?.focus();
    } else if (key === "Enter" || key === " ") {
      event.preventDefault();
      activate(row);
    }
  }

  function paint() {
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    popup?.remove();
    popup = null;
    if (!open) return;
    const back = backRow();
    const sections = sectionsFor();
    const rows = [...(back ? [back] : []), ...sections.flatMap((s) => s.rows)];
    rowEls = [];
    const renderRow = (row) => {
      const index = rows.indexOf(row);
      const selected = row.kind === "competition" && row.competition.competitionKey === value;
      const label = row.kind === "competition" ? row.competition.label : row.kind === "back" ? "Back" : row.label;
      const el = h(
        "button",
        {
          type: "button",
          class: `jds-btn jds-btn--quiet jds-btn--sm${selected ? " jds-btn--active" : ""}`,
          role: row.kind === "competition" ? "menuitemradio" : "menuitem",
          "aria-checked": row.kind === "competition" ? (selected ? "true" : "false") : null,
          tabindex: "-1",
          onKeydown: (e) => onRowKey(e, index, row, rows),
          onClick: () => activate(row)
        },
        row.kind === "back" ? icon("M15 18l-6-6 6-6") : null,
        h("span", {}, label),
        selected ? icon("M20 6L9 17l-5-5") : null,
        row.kind === "sport" || row.kind === "region" ? icon("M9 18l6-6-6-6") : null
      );
      rowEls[index] = el;
      return el;
    };
    const title = view.level === "root" ? "Standings leagues" : view.level === "sport" ? view.sportLabel : view.regionLabel;
    popup = h(
      "div",
      { class: "jds-menu__list sp-standings-picker__popup", role: "menu", "aria-label": "Standings leagues" },
      h("div", { class: "sp-standings-picker__title" }, back ? renderRow(back) : null, h("span", { class: "jds-eyebrow jds-eyebrow--strong" }, title)),
      sections.map((section) =>
        h(
          "div",
          { class: "sp-standings-picker__group", role: "group", "aria-label": section.label ?? null },
          section.label ? h("div", { class: "jds-eyebrow jds-eyebrow--strong sp-standings-picker__heading" }, section.label) : null,
          section.rows.map(renderRow)
        )
      ),
      rows.length === 0 ? h("span", { role: "status" }, "No leagues available.") : null
    );
    root.append(popup);
    const currentIndex = rows.findIndex((r) => r.kind === "competition" && r.competition.competitionKey === value);
    const firstContent = back && rows.length > 1 ? 1 : 0;
    const index = focusTarget === "last" ? rows.length - 1 : focusTarget === "current" && currentIndex >= 0 ? currentIndex : firstContent;
    focusTarget = "first";
    rowEls[index]?.focus();
  }

  trigger.addEventListener("click", () => (open ? close(false) : openPicker()));
  trigger.addEventListener("keydown", (event) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      openPicker(event.key === "ArrowUp" || event.key === "End" ? "last" : event.key === "ArrowDown" || event.key === "Home" ? "first" : "current");
    }
  });
  const outside = (event) => {
    if (!open) return;
    if (!root.contains(event.target)) close(true);
  };
  document.addEventListener("mousedown", outside);
  root.dispose = () => document.removeEventListener("mousedown", outside);
  return root;
}

export { clear };
