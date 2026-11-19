/* global document, window */
import { moduleClient } from "./guest-bridge.mjs";
import { scratchpadApi } from "./api.mjs";
import { padModel } from "./model.mjs";
import { format, continueList, shortcutMatches } from "./editor.mjs";
import { padMarkup } from "./view.mjs";

const client = moduleClient();
const root = document.getElementById("root");
root.innerHTML = padMarkup;
const text = root.querySelector("textarea");
const preview = document.createElement("div");
preview.className = "jds-textarea sc-pad__text sc-pad__text--lines";
preview.tabIndex = 0;
preview.hidden = true;
preview.setAttribute("aria-label", "Appended scratchpad text; click to edit");
text.after(preview);
function resumeEditing() {
  model.dismissNotice();
  text.focus();
}
preview.addEventListener("click", resumeEditing);
preview.addEventListener("keydown", (event) => {
  if (["Enter", " "].includes(event.key)) {
    event.preventDefault();
    resumeEditing();
  }
});
const status = root.querySelector('[role="status"]');
status.textContent = "Loading";
const failure = root.querySelector("#failure");
const notice = root.querySelector("#notice");
const count = root.querySelector("#count");
const model = padModel(scratchpadApi(client), (state) => {
  // Do not replace the textarea when the user is typing; keep selection and undo intact.
  if (text.value !== state.text) text.value = state.text;
  text.disabled = !state.loaded;
  status.textContent = state.status;
  root.querySelector("#conflict").hidden = !state.conflict;
  failure.hidden = !state.error;
  root.querySelector("#error-text").textContent = state.error;
  if (state.notice && !state.conflict && state.status === "Saved") {
    const mark = document.createElement("span");
    mark.className = "jds-highlight";
    mark.textContent = state.text.slice(state.appendedFrom);
    preview.replaceChildren(document.createTextNode(state.text.slice(0, state.appendedFrom)), mark);
    preview.hidden = false;
    text.hidden = true;
  } else {
    preview.hidden = true;
    text.hidden = false;
  }
  notice.hidden = !state.notice;
  notice.textContent = state.notice;
  count.hidden = state.text.length <= 50000;
  count.textContent = `${state.text.length.toLocaleString()} / 64,000 characters`;
  count.classList.toggle("sc-pad__count--near", state.text.length > 60000);
});
text.addEventListener("input", () => model.edit(text.value));
text.addEventListener("blur", () => void model.save());
function apply(result) {
  if (!result || !model.state.loaded) return;
  if (result.text.length > 64000) return;
  // setRangeText preserves the browser's editing behavior without rendering Markdown.
  text.setRangeText(result.text, 0, text.value.length, "preserve");
  text.setSelectionRange(result.start, result.end);
  text.focus();
  model.edit(text.value);
}
text.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  let result;
  if (event.key === "Tab")
    result = format(
      text.value,
      text.selectionStart,
      text.selectionEnd,
      event.shiftKey ? "outdent" : "indent"
    );
  else if (event.key === "Enter")
    result = continueList(text.value, text.selectionStart, text.selectionEnd);
  else if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    ["b", "i"].includes(event.key.toLowerCase())
  )
    result = format(
      text.value,
      text.selectionStart,
      text.selectionEnd,
      event.key.toLowerCase() === "b" ? "bold" : "italic"
    );
  if (result) {
    event.preventDefault();
    apply(result);
  }
});
const actions = {
  "Bullet list": "bullet",
  "Numbered list": "numbered",
  Checkbox: "checkbox",
  Indent: "indent",
  Outdent: "outdent",
  Bold: "bold",
  Italic: "italic"
};
for (const button of root.querySelectorAll('[role="toolbar"] button')) {
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () =>
    apply(
      format(
        text.value,
        text.selectionStart,
        text.selectionEnd,
        actions[button.getAttribute("aria-label")]
      )
    )
  );
}
root.querySelector("#reload").addEventListener("click", async () => {
  await model.reload();
  text.focus();
});
root
  .querySelector("#retry")
  .addEventListener(
    "click",
    () => void (model.state.loaded && model.dirty() ? model.save() : model.read())
  );
async function close(path) {
  await model.save();
  // Hiding the persistent frame keeps both failed drafts and conflict drafts in memory.
  await client.navigate(path);
}
root
  .querySelector('[aria-label="Close scratchpad"]')
  .addEventListener("click", () => void close("/scratchpad-close"));
root
  .querySelector('[aria-label="Scratchpad settings"]')
  .addEventListener("click", () => void close("/scratchpad-settings"));
document.addEventListener("keydown", (event) => {
  if (shortcutMatches(event, model.state.shortcut)) {
    event.preventDefault();
    void close("/scratchpad-close");
  }
  if (event.key === "Escape") {
    event.preventDefault();
    void close("/scratchpad-close");
  }
  // Tab remains in this sheet/panel. Editor Tab indents; toolbar Tab wraps at its ends.
  if (event.key === "Tab" && !event.defaultPrevented) {
    const buttons = [
      ...root.querySelectorAll("button:not([disabled]), textarea:not([disabled])")
    ].filter((el) => !el.closest("[hidden]"));
    const at = buttons.indexOf(document.activeElement);
    if ((event.shiftKey && at === 0) || (!event.shiftKey && at === buttons.length - 1)) {
      event.preventDefault();
      buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus();
    }
  }
});
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.channel !== "moss.scratchpad.visibility")
    return;
  if (event.data.open) {
    void model.read();
    text.focus();
  } else void model.save();
});
window.addEventListener("beforeunload", (event) => {
  if (model.dirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  model.dispose();
  client.dispose();
});
await client
  .theme()
  .then((theme) => {
    document.documentElement.dataset.colorMode = theme.colorMode;
  })
  .catch(() => {});
await model.read();
text.focus();
setInterval(() => void model.read(), 2000);
