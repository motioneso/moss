/* Throwaway live conversation. Only catalog components; model strings are text. */
const thread = document.getElementById("conversation");
const composer = document.getElementById("composer");
const input = composer.querySelector("textarea");
const submit = composer.querySelector('[type="submit"]');
const query = new URLSearchParams(location.search);
const conversation = [];
const prompts = {
  plan: "Help me plan an example day: I have 4 hours, a proposal to write, email to clear, and a workout. Show me a timeline and let me adjust the focus time.",
  money:
    "Use an example weekly budget of $250 for groceries, dining out, transport, and fun. Show me a spending chart and a slider to explore a different budget.",
  compare:
    "Compare taking a train vs driving to a workshop using invented example prices and travel times. I value a calm morning. Let me pick an option and adapt the plan."
};
let active = null;
let toastTimer;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function button(label, action, variant = "chip") {
  const node = el("button", `jds-btn jds-btn--${variant} jds-btn--sm`, label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function scroll() {
  thread.scrollTop = thread.scrollHeight;
}
function toast(text) {
  const box = document.getElementById("toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 6000);
}
function settings() {
  const view = document.getElementById("view").value;
  const theme = document.getElementById("theme").value;
  document.querySelector(".mockup-stage").dataset.view = view;
  document.querySelector(".mockup-chat").classList.toggle("chatd--expanded", view === "expanded");
  document.documentElement.dataset.colorMode = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme === "sage" ? "sage" : "forest";
  history.replaceState(null, "", `${location.pathname}?${new URLSearchParams({ view, theme })}`);
}
function welcome() {
  const block = el("div", "live-welcome");
  block.append(el("div", "jds-eyebrow", "A conversation you can shape"));
  block.append(el("h2", "", "Ask. Explore. Adjust."));
  block.append(
    el(
      "p",
      "mockup-lede",
      "Real model replies, with visuals you can use. Try a starting point, or ask something of your own."
    )
  );
  const starters = el("div", "live-starters");
  for (const [key, label, detail] of [
    ["plan", "Make room in my day", "Move from a list to a plan"],
    ["money", "Explore a weekly budget", "Adjust the numbers together"],
    ["compare", "Help me choose", "See the tradeoffs side by side"]
  ]) {
    const choice = button(label, () => send(prompts[key]), "quiet");
    choice.append(el("small", "", detail));
    starters.append(choice);
  }
  block.append(starters);
  block.append(
    el(
      "p",
      "live-caption",
      "Separate prototype conversation · Example data · Replies use the local Codex login"
    )
  );
  thread.replaceChildren(block);
}
function panelView(panel) {
  const section = el("section", "live-panel");
  section.append(el("h3", "", panel.title));
  const items = Array.isArray(panel.items) ? panel.items.slice(0, 8) : [];
  if (panel.type === "chart") {
    const largest = Math.max(1, ...items.map((item) => Math.abs(Number(item.value) || 0)));
    const chart = el("div", "visual-bars");
    for (const item of items) {
      const row = el("div");
      const label = el("div", "visual-bar-label");
      label.append(
        el("span", "", item.label),
        el("strong", "", item.detail || `${item.value} ${panel.unit}`)
      );
      const track = el("div", "visual-track");
      const bar = el("span");
      bar.style.width = `${Math.min(100, (Math.abs(Number(item.value) || 0) / largest) * 100)}%`;
      track.append(bar);
      row.append(label, track);
      chart.append(row);
    }
    section.append(chart);
  } else if (panel.type === "table" || panel.type === "timeline") {
    const table = el("table", "jds-table live-table");
    const caption = el(
      "caption",
      "live-caption",
      panel.type === "timeline" ? "Time / step · Plan" : "Option · Details"
    );
    const body = el("tbody");
    for (const item of items) {
      const row = el("tr");
      const heading = el("th", "", item.label);
      heading.scope = "row";
      row.append(heading, el("td", "", item.detail));
      body.append(row);
    }
    table.append(caption, body);
    section.append(table);
  } else if (panel.type === "choices") {
    const choices = el("div", "live-choices");
    for (const item of items) {
      const choice = button(
        item.label,
        () => {
          send(
            `For “${panel.title}”, I choose “${item.label}” (${item.detail}). Adapt your recommendation and show the updated plan.`
          );
        },
        "quiet"
      );
      choice.append(el("small", "", item.detail));
      choices.append(choice);
    }
    section.append(choices);
  } else if (panel.type === "slider") {
    const min = Number(panel.min);
    const max = Number(panel.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    const label = el("label", "live-range-label");
    const output = el("output");
    const range = el("input", "live-range");
    range.type = "range";
    range.min = min;
    range.max = max;
    range.step = max - min <= 20 ? 0.5 : 1;
    range.value = Math.max(min, Math.min(max, Number(panel.value) || min));
    range.setAttribute("aria-label", panel.title);
    function update() {
      output.textContent = `${range.value} ${panel.unit}`.trim();
      range.setAttribute("aria-valuetext", output.textContent);
    }
    range.addEventListener("input", update);
    update();
    label.append(el("span", "", "Try a different amount"), output, range);
    const limits = el("div", "live-range-limits");
    limits.append(el("span", "", `${min} ${panel.unit}`), el("span", "", `${max} ${panel.unit}`));
    section.append(
      label,
      limits,
      button("Update the plan", () => {
        send(
          `Set “${panel.title}” to ${range.value} ${panel.unit}. Recalculate the figures and adapt the plan to this value.`
        );
      })
    );
  } else {
    return null;
  }
  return section;
}
function answerView(reply) {
  const article = el("article", "live-reply");
  article.append(el("div", "live-speaker", "Moss"));
  const prose = el("div", "live-prose");
  for (const paragraph of reply.text.split(/\n\s*\n/)) prose.append(el("p", "", paragraph));
  article.append(prose);
  const panels = Array.isArray(reply.panels) ? reply.panels.slice(0, 3) : [];
  const metrics = Array.isArray(reply.metrics) ? reply.metrics.slice(0, 3) : [];
  if (panels.length || metrics.length) {
    const visual = el("div", "visual-reply visual-inline");
    if (reply.title) visual.append(el("h2", "", reply.title));
    if (metrics.length) {
      const list = el("dl", "visual-metrics");
      for (const metric of metrics) {
        const item = el("div");
        item.append(el("dt", "", metric.label), el("dd", "", metric.value));
        list.append(item);
      }
      visual.append(list);
    }
    for (const panel of panels) {
      const node = panelView(panel);
      if (node) visual.append(node);
    }
    article.append(visual);
  }
  const suggestions = el("div", "live-suggestions");
  for (const suggestion of (reply.suggestions || []).slice(0, 3)) {
    suggestions.append(button(suggestion, () => send(suggestion)));
  }
  article.append(suggestions);
  return article;
}
function busy(value) {
  submit.disabled = value;
  document.getElementById("live-stop").hidden = !value;
  document.querySelector(".chatd__status").textContent = value
    ? "Thinking through your reply…"
    : "Live conversation · Example data";
  thread.setAttribute("aria-busy", String(value));
}
async function cancel() {
  if (!active) return;
  const current = active;
  current.controller.abort();
  await fetch("/api/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: current.id })
  }).catch(() => {});
}
async function send(prompt) {
  if (active || !prompt.trim()) return;
  if (conversation.length >= 40) return toast("Start a new conversation to keep exploring.");
  thread.querySelector(".live-welcome")?.remove();
  thread.querySelector(".live-error")?.remove();
  const user = el("div", "chatd-msg chatd-msg--me");
  user.append(el("div", "chatd-bubble", prompt));
  const pending = el("div", "live-pending", "Moss is shaping a reply…");
  pending.setAttribute("role", "status");
  thread.append(user, pending);
  conversation.push({ role: "user", content: prompt });
  input.value = "";
  const current = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    controller: new AbortController()
  };
  active = current;
  busy(true);
  scroll();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: current.controller.signal,
      body: JSON.stringify({ id: current.id, messages: conversation })
    });
    const reply = await response.json();
    if (!response.ok) throw new Error(reply.error || "Could not finish this reply.");
    conversation.push({ role: "assistant", content: JSON.stringify(reply) });
    thread.append(answerView(reply));
  } catch (error) {
    conversation.pop();
    user.remove();
    const box = el("div", "live-error");
    box.setAttribute("role", "alert");
    box.append(
      el(
        "p",
        "",
        error.name === "AbortError"
          ? "Reply stopped. Your message is ready to edit or send again."
          : error.message
      )
    );
    box.append(button("Try again", () => send(prompt)));
    thread.append(box);
    input.value = prompt;
  } finally {
    pending.remove();
    active = null;
    busy(false);
    scroll();
  }
}

document.querySelector(".review-head strong").textContent = "Visual replies, now live";
document.querySelector(".review-head .jds-eyebrow").textContent = "Moss · Interactive prototype";
document.querySelector(".chatd__status").textContent = "Live conversation · Example data";
document.querySelector(".mockup-composer-note").textContent =
  "Real model replies · Example data · No account changes";
document.querySelector(".mockup-compose-bottom > span").textContent = "Live prototype";
document.querySelector(".review-dock").remove();
document
  .querySelector('[data-action="about"]')
  .addEventListener("click", () =>
    toast(
      "Real model replies in a separate conversation. Example data; no Moss account or app actions. Try a choice or slider to change the next reply."
    )
  );
document.querySelector('[data-action="reset"]').setAttribute("aria-label", "New live conversation");
document.querySelector('[data-action="reset"]').addEventListener("click", () => {
  if (active) return toast("Stop the current reply first, then start a new conversation.");
  conversation.length = 0;
  input.value = "";
  welcome();
});
document.querySelector('[data-action="expand"]').addEventListener("click", () => {
  const control = document.getElementById("view");
  control.value = control.value === "expanded" ? "drawer" : "expanded";
  settings();
});
document
  .querySelector('[aria-label="About example attachments"]')
  .addEventListener("click", () =>
    toast("This prototype accepts text. Describe any example data in your message.")
  );
input.setAttribute("aria-label", "Message Moss");
input.placeholder = "Ask something. Then shape it together…";
submit.setAttribute("aria-label", "Send message");
const stop = button("Stop", cancel, "quiet");
stop.id = "live-stop";
stop.hidden = true;
submit.before(stop);
composer.addEventListener("submit", (event) => {
  event.preventDefault();
  send(input.value.trim());
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send(input.value.trim());
  }
});
const scenario = document.getElementById("scenario");
scenario.prepend(new Option("Choose a starting point", ""));
scenario.value = "";
scenario.addEventListener("change", () => {
  if (prompts[scenario.value]) send(prompts[scenario.value]);
  scenario.value = "";
});
for (const [key, values] of [
  ["view", ["expanded", "drawer", "phone"]],
  ["theme", ["light", "dark", "sage"]]
]) {
  const control = document.getElementById(key);
  if (values.includes(query.get(key))) control.value = query.get(key);
  control.addEventListener("change", settings);
}
thread.setAttribute("aria-label", "Conversation with Moss");
settings();
welcome();
