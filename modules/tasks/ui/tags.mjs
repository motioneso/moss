/* global document */
// List-scoped tag editing uses the same authenticated routes as task details.
export function tagManager({ api, run, changed, bindForm, focus }) {
  const $ = (id) => document.getElementById(id);
  let list = null;
  let tags = [];
  let deleting = null;
  const drafts = new Map();
  const text = (tag, content, className = "") => {
    const node = document.createElement(tag);
    node.textContent = content;
    node.className = className;
    return node;
  };
  function button(label, action) {
    const node = text("button", label, "jds-btn jds-btn--secondary");
    node.type = "button";
    node.addEventListener("click", () => run(action));
    return node;
  }
  async function refresh() {
    tags = (await api("GET", `/tasks/lists/${list.id}/tags`)).tags;
    render();
  }
  function render() {
    $("tag-names").replaceChildren(
      ...tags.map((tag) => {
        const section = text("div", "", "tasks-fields");
        const form = text("form", "", "tasks-inline");
        const label = text("label", `Rename #${tag.name}`, "jds-label");
        const input = text("input", "", "jds-input");
        input.id = `rename-tag-${tag.id}`;
        label.htmlFor = input.id;
        input.value = drafts.get(tag.id) ?? tag.name;
        input.required = true;
        input.maxLength = 100;
        input.addEventListener("input", () => {
          if (input.value === tag.name) drafts.delete(tag.id);
          else drafts.set(tag.id, input.value);
        });
        const save = text("button", "Save tag name", "jds-btn jds-btn--secondary");
        save.type = "submit";
        form.append(label, input, save);
        bindForm(form, async () => {
          await api("PATCH", `/tasks/lists/${list.id}/tags/${tag.id}`, { name: input.value });
          drafts.delete(tag.id);
          await refresh();
          await changed();
          $("notice").textContent = "Tag renamed.";
          focus(document.getElementById(input.id));
        });
        section.append(form);
        if (deleting === tag.id) {
          const confirmation = text("div", "", "tasks-fields");
          confirmation.setAttribute("role", "group");
          confirmation.setAttribute("aria-label", `Delete #${tag.name}`);
          confirmation.append(
            text(
              "p",
              `Delete #${tag.name}? It will be removed from every task in this list. Tasks are kept.`
            )
          );
          const actions = text("div", "", "tasks-actions");
          actions.append(
            button("Delete tag everywhere", async () => {
              await api("DELETE", `/tasks/lists/${list.id}/tags/${tag.id}`);
              drafts.delete(tag.id);
              deleting = null;
              await refresh();
              await changed();
              $("notice").textContent = "Tag deleted. Your tasks are kept.";
              focus($("manage-tag-name"));
            }),
            button("Keep tag", () => {
              deleting = null;
              render();
              focus(document.getElementById(input.id));
            })
          );
          confirmation.append(actions);
          section.append(confirmation);
        } else {
          section.append(
            button(`Delete #${tag.name}`, () => {
              deleting = tag.id;
              render();
              focus($("tag-names").querySelector('[role="group"] button'));
            })
          );
        }
        return section;
      })
    );
    $("tags-empty").hidden = tags.length !== 0;
  }
  bindForm($("manage-tag-form"), async () => {
    await api("POST", `/tasks/lists/${list.id}/tags`, { name: $("manage-tag-name").value });
    $("manage-tag-name").value = "";
    await refresh();
    await changed();
    $("notice").textContent = "Tag created. Open a task to assign it.";
    focus($("manage-tag-name"));
  });
  return {
    async open(selected) {
      // Fetch first: failed loading must not replace the current screen or drafts.
      const result = await api("GET", `/tasks/lists/${selected.id}/tags`);
      list = selected;
      tags = result.tags;
      deleting = null;
      $("list-tags-heading").textContent = `Tags in ${list.name}`;
      $("tags-editor").hidden = false;
      $("lists-editor").hidden = true;
      $("tags-error").hidden = true;
      render();
      focus($("manage-tag-name"));
    },
    close() {
      $("tags-editor").hidden = true;
      deleting = null;
    },
    hasDraft: () =>
      !$("tags-editor").hidden && (drafts.size > 0 || $("manage-tag-name").value !== ""),
    discard() {
      drafts.clear();
      $("manage-tag-name").value = "";
    }
  };
}
