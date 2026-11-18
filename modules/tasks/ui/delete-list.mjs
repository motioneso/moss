/* global document, Option */
// Confirmation uses the real deletion route; tasks are always kept.
export function listDeletion({ api, lists, changed, focus }) {
  const $ = (id) => document.getElementById(id);
  let pending = null;
  return {
    open(list) {
      pending = list;
      $("delete-list-title").textContent = `Delete ${list.name}?`;
      $("delete-list-error").hidden = true;
      const select = $("delete-list-destination");
      select.replaceChildren(new Option("Delete only if empty", ""));
      for (const destination of lists())
        if (destination.id !== list.id) select.add(new Option(destination.name, destination.id));
      $("delete-list-confirmation").hidden = false;
      focus($("keep-list").querySelector("button"));
    },
    close() {
      const id = pending?.id;
      pending = null;
      $("delete-list-confirmation").hidden = true;
      focus(document.getElementById(`delete-list-${id}`));
    },
    async confirm() {
      if (!pending) return;
      const destination = $("delete-list-destination").value;
      try {
        await api("DELETE", `/tasks/lists/${pending.id}`, {
          ...(destination ? { reassignToListId: destination } : {})
        });
      } catch {
        $("delete-list-error").textContent =
          "Could not delete this list. If it has tasks, choose a list to move them to. Your last list is kept. Check the connection and retry.";
        $("delete-list-error").hidden = false;
        $("notice").textContent = "";
        focus($("delete-list-destination"));
        return;
      }
      pending = null;
      $("delete-list-confirmation").hidden = true;
      await changed();
      $("notice").textContent = "List deleted. Your tasks are kept.";
    }
  };
}
