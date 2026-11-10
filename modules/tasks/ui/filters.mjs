/* global document, Option */
import { filterTasks } from "./model.mjs";

const $ = (id) => document.getElementById(id);

// Account data stays in the package frame. These controls only filter loaded rows.
export function taskFilters(changed, searchIntent = () => null) {
  let listStates = {};
  let tagFilter = [];
  $("focus-filter").addEventListener("change", () => {
    // A preset overrides status, as in the legacy Today links. Choosing a
    // status explicitly leaves the preset; clearing it returns to open tasks.
    $("status-filter").value = $("focus-filter").value ? "" : "todo";
    changed();
  });
  $("status-filter").addEventListener("input", () => {
    $("focus-filter").value = "";
    changed();
  });
  $("list-filter").addEventListener("change", () => {
    const id = $("list-filter").value;
    listStates = id ? { [id]: "solo" } : {};
    changed();
  });
  $("tag-filter").addEventListener("change", () => {
    const name = $("tag-filter").value;
    if (name && !tagFilter.includes(name)) tagFilter.push(name);
    changed();
  });

  function render(lists, result) {
    const changedLists = lists.filter(
      (list) => listStates[list.id] && listStates[list.id] !== "included"
    );
    const single = changedLists.length === 1 && listStates[changedLists[0].id] === "solo";
    const custom = changedLists.length > 0 && !single;
    const picker = $("list-filter");
    picker.replaceChildren(new Option(`All lists (${result.listCountTotal})`, ""));
    for (const list of lists)
      picker.add(new Option(`${list.name} (${result.listCounts[list.id]})`, list.id));
    if (custom) {
      const option = new Option("Custom lists", "__custom");
      option.disabled = true;
      picker.add(option);
    }
    picker.value = custom ? "__custom" : single ? changedLists[0].id : "";
    const activeId = document.activeElement?.id;
    $("list-selection").replaceChildren(
      ...lists.map((list) => {
        const field = document.createElement("div");
        field.className = "jds-field";
        const label = document.createElement("label");
        label.className = "jds-label";
        label.htmlFor = `list-state-${list.id}`;
        label.textContent = `${list.name} (${result.listCounts[list.id]})`;
        const select = document.createElement("select");
        select.id = label.htmlFor;
        select.className = "jds-input";
        for (const [value, text] of [
          ["included", "Include"],
          ["solo", "Show only"],
          ["excluded", "Hide"]
        ])
          select.add(new Option(text, value));
        select.value = listStates[list.id] ?? "included";
        select.addEventListener("change", () => {
          listStates[list.id] = select.value;
          changed();
        });
        field.append(label, select);
        return field;
      })
    );
    if (activeId?.startsWith("list-state-")) $(activeId)?.focus();
    const tags = $("tag-filter");
    tags.replaceChildren(new Option("Add tag filter", ""));
    for (const name of result.allTags.filter((name) => !tagFilter.includes(name)))
      tags.add(new Option(name, name));
    $("active-tags").replaceChildren(
      ...tagFilter.map((name) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "jds-btn jds-btn--secondary";
        button.textContent = `#${name} ×`;
        button.setAttribute("aria-label", `Remove tag filter ${name}`);
        button.addEventListener("click", () => {
          tagFilter = tagFilter.filter((tag) => tag !== name);
          changed();
          $("tag-filter").focus();
        });
        return button;
      })
    );
  }
  function captureListId(lists) {
    const solo = lists.filter((list) => listStates[list.id] === "solo");
    return solo.length === 1 ? solo[0].id : undefined;
  }
  return {
    captureListId,
    defaultListId(lists) {
      // Details falls back to the first list; quick capture lets the route choose Personal.
      return captureListId(lists) ?? lists[0]?.id ?? "";
    },
    apply(tasks, lists, timeZone = "UTC") {
      const result = filterTasks(tasks, {
        lists,
        timeZone,
        listStates,
        tagFilter,
        status: $("status-filter").value,
        focus: $("focus-filter").value || null,
        search: $("search").value,
        searchIntent: searchIntent()
      });
      render(lists, result);
      return result.visibleTasks;
    },
    clear() {
      listStates = {};
      tagFilter = [];
      $("status-filter").value = "todo";
      $("focus-filter").value = "";
      $("search").value = "";
      changed();
    }
  };
}
