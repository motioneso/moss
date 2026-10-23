/* Local-only prototype controls. No network calls and no persisted state. */
const examples = JSON.parse(document.getElementById("example-data").textContent);
const query = new URLSearchParams(location.search);
const variants = ["A", "B", "C"];
const descriptions = {
  A: ["Inline summary", "A visual passage in the flow of the reply"],
  B: ["Visual card", "A contained snapshot with the key numbers"],
  C: ["Compact dashboard", "A headline insight, detail, and a supporting rail"]
};
const state = {
  scenario: Object.hasOwn(examples, query.get("scenario")) ? query.get("scenario") : "plan",
  variant: variants.includes(query.get("variant")) ? query.get("variant") : "A",
  view: ["expanded", "drawer", "phone"].includes(query.get("view"))
    ? query.get("view")
    : "expanded",
  theme: ["light", "dark", "sage"].includes(query.get("theme")) ? query.get("theme") : "light"
};
const thread = document.getElementById("conversation");
let toastTimer;
function toast(message) {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 4500);
}
function render() {
  thread.replaceChildren(
    document.getElementById(`reply-${state.scenario}-${state.variant}`).content.cloneNode(true)
  );
  document.querySelector(".mockup-stage").dataset.view = state.view;
  document.documentElement.dataset.colorMode = state.theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme === "sage" ? "sage" : "forest";
  document
    .querySelector(".mockup-chat")
    .classList.toggle("chatd--expanded", state.view === "expanded");
  for (const key of ["scenario", "view", "theme"]) document.getElementById(key).value = state[key];
  document.getElementById("page-title").textContent =
    state.view === "drawer" ? "Today" : "Main chat";
  document.getElementById("variant-title").textContent =
    `${state.variant} · ${descriptions[state.variant][0]}`;
  document.getElementById("variant-description").textContent = descriptions[state.variant][1];
  document.getElementById("variant-counter").textContent =
    `${variants.indexOf(state.variant) + 1} / 3`;
  thread.scrollTop = 0;
  history.replaceState(null, "", `${location.pathname}?${new URLSearchParams(state)}`);
}
function cycle(delta) {
  state.variant = variants[(variants.indexOf(state.variant) + delta + 3) % 3];
  render();
}
function followup(prompt = examples[state.scenario].suggestion) {
  const user = document.createElement("div");
  user.className = "chatd-msg chatd-msg--me";
  const bubble = document.createElement("div");
  bubble.className = "chatd-bubble";
  bubble.textContent = prompt;
  user.append(bubble);
  const answer = document.createElement("div");
  answer.className = "mockup-followup-answer";
  answer.style.cssText = "margin: 0 0 24px 36px; line-height: 1.7";
  answer.textContent = examples[state.scenario].answer;
  thread.append(user, answer);
  thread.scrollTop = thread.scrollHeight;
}
document.addEventListener("click", async (event) => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const action = control.dataset.action;
  if (action === "prev") cycle(-1);
  if (action === "next") cycle(1);
  if (action === "reset") render();
  if (action === "expand") {
    state.view = state.view === "expanded" ? "drawer" : "expanded";
    render();
  }
  if (action === "about")
    toast("A visual target using invented data. No live model, bookings, or account changes.");
  if (action === "sources") {
    const detail = thread.querySelector(".mockup-source-detail");
    detail.hidden = !detail.hidden;
  }
  if (action === "followup") followup();
  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(thread.innerText);
      toast("Example answer copied as readable text.");
    } catch {
      toast("Select the answer text to copy it in this preview.");
    }
  }
  if (action === "reveal") {
    thread.classList.remove("revealing");
    void thread.offsetWidth;
    thread.classList.add("revealing");
    toast("Visual reveal only; this mockup does not run a streaming model.");
  }
});
for (const key of ["scenario", "view", "theme"])
  document.getElementById(key).addEventListener("change", (event) => {
    state[key] = event.target.value;
    render();
  });
document.addEventListener("keydown", (event) => {
  if (event.target.closest("input, textarea, select, [contenteditable]")) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    cycle(event.key === "ArrowLeft" ? -1 : 1);
  }
});
document.getElementById("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = event.currentTarget.querySelector("textarea");
  if (!input.value.trim()) return;
  followup(input.value.trim());
  input.value = "";
  toast("Showing the scripted follow-up for this example; no message was sent to a model.");
});
render();
