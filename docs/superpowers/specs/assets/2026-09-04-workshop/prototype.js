// Disposable, local-only interaction sketch. All assistant replies and build events are scripted.
/* global document, location, window */
const main = document.querySelector("#main");
const scenario = document.querySelector("#scenario");
const advance = document.querySelector("#advance");
const announcement = document.querySelector("#announcement");
const shareDialog = document.querySelector("#share-dialog");
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
const button = (label, action, variant = "secondary", extra = "") =>
  `<button class="jds-btn jds-btn--${variant}" data-action="${action}" ${extra}>${label}</button>`;
const statuses = {
  brief: "Needs your answer",
  ready: "Ready to plan",
  planning: "Preparing plan",
  review: "Ready for review",
  building: "Building",
  question: "Needs your answer",
  failed: "Check failed",
  stopping: "Stopping",
  stopped: "Stopped",
  draft: "Ready to try",
  finished: "Finished · private",
  shared: "Available to everyone",
  model: "Needs model setup"
};
let project;
let mobilePane = "conversation";
let showSaved = false;
let showMockSaved = false;

function seed(stage = "review") {
  project = {
    title: "Word of the Day",
    stage,
    revision: 1,
    history: false,
    draftHistory: null,
    attempt: ["building", "question", "failed", "stopped", "draft", "finished"].includes(stage)
      ? 1
      : 0,
    saved: false,
    composer: "",
    events: [],
    messages: [
      {
        role: "user",
        text: "I want a word of the day, with a definition and an example. Something simple I can open each morning."
      },
      {
        role: "assistant",
        text: "Should the word stay the same all day, or would you like a new word each time you open it?"
      }
    ]
  };
  if (stage !== "brief") {
    addMessage("user", "Keep the same word all day. No external service needed.");
    addMessage(
      "assistant",
      "I’ll use a small bundled word list and your local date. The plan and page sketch are ready to review together. Nothing has been built yet."
    );
  }
  if (["draft", "finished"].includes(stage)) {
    project.draftHistory = false;
    project.events = [
      ["Checks passed", "Daily selection, definition, and example verified."],
      ["Private draft opened", "Ready for you to try."]
    ];
    addMessage(
      "assistant",
      "The draft is ready to try. Open the page beside this conversation, then tell me what you would change."
    );
  }
  if (stage === "building")
    project.events = [
      ["Plan 1 approved", "Only the approved module is being built."],
      ["Word page written", "Checking daily selection and the page."]
    ];
  if (stage === "failed")
    project.events = [
      [
        "Daily-word check failed",
        "The word changed when reopening on the same day. Draft was not replaced."
      ]
    ];
  if (stage === "question")
    addMessage(
      "assistant",
      "Your device’s local date is the planned day boundary. Keep that behavior?"
    );
  mobilePane = ["brief", "question"].includes(stage) ? "conversation" : "artifact";
  showSaved = false;
  showMockSaved = false;
}

function addMessage(role, text) {
  project.messages.push({ role, text });
}
function go(route) {
  if (location.hash === `#${route}`) render();
  else location.hash = route;
}
function setStage(stage, pane = "artifact") {
  project.stage = stage;
  mobilePane = pane;
  render();
  main.focus();
}

function projectList() {
  return `<section class="page">
    <div class="page-heading"><div><h1>Your Workshop</h1><p>Make a place for something Moss doesn’t do yet. Start with an idea; shape it together, then try what you build.</p></div>${button("New project", "new", "primary")}</div>
    ${project ? `<h2>Your projects</h2><a class="project-row" href="#project"><div><h2>${escapeHtml(project.title)}</h2><p>${project.stage === "review" ? "Your plan and page sketch are ready. Review them before building." : "Continue the conversation, review the work, or try your module."}</p></div><div class="project-meta"><span class="status">${statuses[project.stage]}</span><span class="small muted">${project.stage === "shared" ? "Module shared" : "Only you"}</span></div></a>` : `<div class="jds-empty"><h2 class="jds-empty__title">A small idea is a good start.</h2><p class="jds-empty__sub">Your projects will stay here, from the first question to a finished module.</p></div>`}
    <p class="small muted" style="margin-top:var(--space-8)">Already discussing an idea with Moss? It can create a project and bring that conversation here.</p>
  </section>`;
}

function newProject() {
  return `<section class="page form-page"><a href="#list">← Your projects</a><h1>What would you like to make?</h1><p class="muted">Start with what you want it to do. Your Workshop assistant will help work out the details.</p>
    <form id="new-project"><div class="jds-field"><label class="jds-label" for="title">Project name</label><input id="title" name="title" class="jds-input" required maxlength="80" value="Word of the Day" /></div>
    <div class="jds-field"><label class="jds-label" for="idea">Your idea</label><textarea id="idea" name="idea" class="jds-textarea" rows="4" required maxlength="2000">I want a word of the day, with a definition and an example. Something simple I can open each morning.</textarea><span class="jds-hint">This prototype follows the Word of the Day example, even if you edit this prompt.</span></div>
    <div class="actions"><button class="jds-btn jds-btn--primary" type="submit">Create project</button><a href="#list">Cancel</a></div><p class="small muted">Private to you. Creating a project starts a conversation; building comes after you review the plan.</p></form></section>`;
}

function suggestions() {
  if (project.stage === "brief") return button("Same word all day", "answer");
  if (project.stage === "ready") return button("Prepare plan + mockup", "plan", "primary");
  if (project.stage === "review" && !project.history) return button("Add saved words", "history");
  if (project.stage === "question") return button("Yes, use my local date", "answer");
  if (["draft", "finished"].includes(project.stage) && !project.history)
    return button("Let me save words", "history");
  return "";
}

function conversation() {
  const reasoning = ["planning", "model"].includes(project.stage);
  return `<section class="conversation" aria-label="Project conversation"><div class="pane-heading"><h2>Workshop assistant</h2><span>${reasoning ? "Reasoning" : "Interactive"}</span></div>
    <div class="messages" role="log" aria-label="Conversation history">${project.messages.map((m) => `<article class="message ${m.role === "user" ? "user" : ""}"><strong>${m.role === "user" ? "You" : "Workshop"}</strong><p>${escapeHtml(m.text)}</p></article>`).join("")}</div>
    <div class="choices">${suggestions()}</div>
    <form id="message-form" class="composer"><label for="message">${project.stage === "review" ? "What would you change?" : "Message your project assistant"}</label><textarea class="jds-textarea" id="message" rows="2" maxlength="2000" placeholder="Ask a question or describe a change…">${escapeHtml(project.composer)}</textarea><div class="actions"><span class="small muted">This project’s conversation</span><button class="jds-btn jds-btn--primary" type="submit">Send</button></div></form></section>`;
}

function wordPreview(live = false) {
  const history = live ? project.draftHistory : project.history;
  if (!live && showMockSaved)
    return `<section class="module-preview" aria-label="Saved words mockup"><h3>Word of the Day</h3><div class="word" style="font-size:var(--text-2xl)">Saved words</div><div class="saved"><p>No saved words yet. Save a word you’d like to remember.</p></div><div class="actions" style="margin-top:var(--space-6)">${button("Today’s word", "mock-today")}</div></section>`;
  return `<section class="module-preview" aria-label="${live ? "Running Word of the Day" : "Visual mockup"}"><h3>Word of the Day</h3>
    ${showSaved && live ? `<div class="word" style="font-size:var(--text-2xl)">Saved words</div><div class="saved">${project.saved ? `<div class="actions"><p><strong>serendipity</strong><br />A happy, unexpected discovery.</p>${button("Remove", "remove-word", "quiet")}</div>` : "<p>No saved words yet. Save a word you’d like to remember.</p>"}</div><div class="actions" style="margin-top:var(--space-6)">${button("Today’s word", "today", "secondary")}</div>` : `<div class="word">serendipity</div><div class="word-type">noun · Today’s word</div><p class="definition">A happy, unexpected discovery.</p><p class="example">“Finding that little bookshop was pure serendipity.”</p>${history ? `<div class="actions">${live ? button(project.saved ? "Saved" : "Save word", "save-word", "primary", project.saved ? "disabled" : "") + button("Saved words", "saved-words", "quiet") : '<span class="jds-btn jds-btn--primary" aria-hidden="true">Save word</span>' + button("Saved words", "mock-saved", "quiet")}</div>` : '<p class="small muted">A new word each day. Yours until tomorrow.</p>'}`}
  </section>`;
}

function planView() {
  return `<div class="artifact-heading"><h2>Review plan ${project.revision}</h2><span class="small muted">Plan + visual mockup</span></div>
    ${project.revision > 1 ? '<div class="notice"><strong>What changed</strong><p>Added Save word and a saved-word list. Words stay private to you. The previous approval does not cover this revision.</p></div>' : ""}
    <div class="review-grid"><div><section class="plan-section"><h3>What you’ll get</h3><p>A page with one word, its definition, and an example. The word stays the same throughout your local day.${project.history ? " Save a word and revisit or remove it in Saved words." : ""}</p></section>
    <section class="plan-section"><h3>Data & access</h3><p>Bundled words. No outside services or credentials.${project.history ? " Saved words use Moss’s private storage and belong only to you." : " No personal data stored."}</p></section>
    <section class="plan-section"><h3>How we’ll prove it</h3><ul><li>Open and reopen: the same daily word.</li><li>Check a new local date: the next word.</li><li>Definition and example visible on a phone.</li>${project.history ? "<li>Save, reopen, and remove a word; another account cannot read it.</li>" : ""}</ul></section>
    <section class="plan-section"><h3>First version</h3><p>No external dictionary or notifications. Finish privately; sharing is a separate choice.</p></section></div>
    <div><p class="preview-label">Page sketch · ${project.history ? "Includes saved words" : "Daily word only"} · not a running draft</p>${wordPreview()}</div></div>
    <div class="approval"><p>Approve this plan and page sketch to build a private draft.</p><div class="actions">${button(`Approve plan ${project.revision} & build`, "approve", "primary")}${button("Request changes", "focus-message", "quiet")}</div></div>
    ${project.draftHistory !== null ? `<details><summary>Try the previous draft</summary>${wordPreview(true)}</details>` : ""}`;
}

function activity() {
  return `<details><summary>Activity & checks</summary><ol class="activity">${project.events.length ? project.events.map(([title, detail]) => `<li><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></li>`).join("") : "<li>No build activity yet.</li>"}</ol><p class="small muted">These events are sample content. Production must report observed work and actual check results.</p></details>`;
}

function artifact() {
  const stage = project.stage;
  if (stage === "review") return planView();
  if (["draft", "finished", "shared"].includes(stage))
    return `<div class="artifact-heading"><h2>${stage === "draft" ? "Try your draft" : "Your finished module"}</h2><span class="status">${stage === "shared" ? "Module shared" : "Only you"}</span></div>
    ${stage !== "draft" ? `<div class="notice"><strong>${stage === "shared" ? "Available to everyone in Moss" : "Finished, and still private"}</strong><p>${stage === "shared" ? "The module is shared. Your project conversation and personal words stay private." : "Word of the Day is ready for your own use. Return to this project whenever you want a change."}</p>${stage === "finished" ? button("Share with everyone…", "open-share") : ""}</div>` : '<p class="muted">Try the page, then ask for a change or finish this version.</p>'}
    <div class="draft-layout"><p class="preview-label">Interactive sample · simulates the installed draft</p>${wordPreview(true)}</div>${activity()}
    ${stage === "draft" ? `<div class="approval"><div class="actions">${button("Finish privately", "finish", "primary")}${button("Ask for a change", "focus-message", "quiet")}</div><p style="margin-top:var(--space-3)">Finishing makes this version yours to use. It does not share the module.</p></div>` : ""}`;
  if (["brief", "ready"].includes(stage))
    return `<div class="artifact-heading"><h2>Let’s shape your idea</h2></div><p class="muted">A few decisions now will make the first version useful.</p><section class="plan-section"><h3>Your starting point</h3><p>${escapeHtml(project.messages[0].text)}</p></section><section class="plan-section"><h3>Next</h3><p>${stage === "brief" ? "Decide how often the word changes. Then review a plan and visual mockup before anything is built." : "Prepare a plan and visual mockup from the agreed requirements."}</p></section>${stage === "ready" ? button("Prepare plan + mockup", "plan", "primary") : button("Answer in conversation", "focus-message", "secondary")}`;
  if (stage === "planning")
    return '<div class="artifact-heading"><h2>Preparing your plan</h2></div><div class="notice"><strong>Working through the requirements</strong><p>The reasoning model prepares the specification, build plan, and page sketch from this same project conversation.</p></div><p class="muted">You can still add a thought in the conversation.</p>';
  if (stage === "model")
    return `<div class="artifact-heading"><h2>Your project is safe</h2></div><div class="notice waiting"><h3>A reasoning model is unavailable</h3><p>The plan hasn’t started. Check AI model configuration, then retry here. Your conversation is kept.</p></div><div class="actions">${button("Retry planning", "plan", "primary")}${button("AI settings guidance", "model-help", "quiet")}</div>`;
  const copy = {
    building: [
      "Building your draft",
      "Checking the daily word",
      "The word page has been written. Next, verify daily selection and try the installed page."
    ],
    question: [
      "The build needs your answer",
      "Confirm the day boundary",
      "Use your device’s local date, as planned? The build is waiting for your answer."
    ],
    failed: [
      "A check failed",
      "The daily word changed on reopening",
      "The draft did not pass its daily-selection check. This attempt has stopped. Retry the build with this failure attached, or revise the plan."
    ],
    stopping: [
      "Stopping the build",
      "Waiting for the builder to stop",
      "No new work will start. This attempt is not marked stopped until the running process has ended."
    ],
    stopped: [
      "Build stopped",
      "Your project is kept",
      "The plan, conversation, and attempt history are here. Start another attempt when you’re ready."
    ]
  }[stage];
  return `<div class="artifact-heading"><h2>${copy[0]}</h2><span class="small muted">Attempt ${project.attempt} · plan ${project.revision}</span></div><div class="notice ${stage === "failed" ? "error" : stage === "question" ? "waiting" : ""}"><h3>${copy[1]}</h3><p>${copy[2]}</p></div><div class="actions">${stage === "building" ? button("Stop build", "stop") : ""}${stage === "question" ? button("Answer in conversation", "focus-message", "primary") + button("Stop build", "stop", "quiet") : ""}${["failed", "stopped"].includes(stage) ? button("Retry build", "retry", "primary") + button("Review plan", "review", "quiet") : ""}</div>${activity()}
    ${project.draftHistory !== null ? `<section style="margin-top:var(--space-7)"><h3>Previous draft · still usable</h3>${wordPreview(true)}</section>` : '<p class="small muted" style="margin-top:var(--space-6)">No working draft yet. A completed build must pass checks before one appears here.</p>'}`;
}

function projectView() {
  return `<header class="project-header"><div><a href="#list">← Your projects</a><h1>${escapeHtml(project.title)}</h1><p>${statuses[project.stage]} · ${project.stage === "shared" ? "Project private · module shared" : "Only you"}</p></div><div class="actions">${project.stage === "review" ? `<span class="status">Plan ${project.revision} needs your review</span>` : ""}</div></header>
    <nav class="mobile-switch" aria-label="Project views">${button("Conversation", "conversation", mobilePane === "conversation" ? "primary" : "secondary", `aria-pressed="${mobilePane === "conversation"}"`)}${button(project.stage === "review" ? "Plan + mockup" : "Project work", "artifact", mobilePane === "artifact" ? "primary" : "secondary", `aria-pressed="${mobilePane === "artifact"}"`)}</nav>
    <div class="workbench" data-pane="${mobilePane}">${conversation()}<section class="artifact" aria-label="Project work">${artifact()}</section></div>`;
}

function render() {
  const route = location.hash.slice(1) || "list";
  if (route === "project" && !project) seed("brief");
  main.innerHTML =
    route === "new" ? newProject() : route === "project" ? projectView() : projectList();
  const events = {
    planning: "Complete plan",
    building: "Complete build",
    stopping: "Confirm builder stopped"
  };
  advance.hidden = route !== "project" || !events[project?.stage];
  advance.textContent = events[project?.stage] || "Next simulated event";
  const log = document.querySelector(".messages");
  if (log) log.scrollTop = log.scrollHeight;
  announcement.textContent =
    route === "project"
      ? statuses[project.stage]
      : route === "new"
        ? "Create a project"
        : "Your projects";
}

function startBuild() {
  project.attempt += 1;
  project.events.push([`Attempt ${project.attempt} started`, `Approved plan ${project.revision}.`]);
  addMessage(
    "assistant",
    `Building plan ${project.revision}. I’ll bring back a draft after its checks pass.`
  );
  setStage("building");
}

function requestHistory() {
  addMessage("user", "Let me save words and return to them later.");
  addMessage(
    "assistant",
    "I’ll revise the plan and mockup to add Save word and a private saved-word list. Please review that revision before I build it."
  );
  project.history = true;
  project.revision += 1;
  setStage("planning");
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;
  if (action === "new") return go("new");
  if (action === "focus-message" || action === "conversation") {
    mobilePane = "conversation";
    render();
    document.querySelector("#message")?.focus();
    return;
  }
  if (action === "artifact") {
    mobilePane = "artifact";
    render();
    main.focus();
    return;
  }
  if (action === "answer") {
    addMessage("user", "Keep the same word all day, using my local date.");
    if (project.stage === "question") {
      addMessage(
        "assistant",
        "Confirmed. Continuing the same attempt with the agreed day boundary."
      );
      return setStage("building");
    }
    addMessage(
      "assistant",
      "A bundled word list can do that without an outside service. Ready to prepare a plan and page sketch."
    );
    return setStage("ready", "conversation");
  }
  if (action === "plan") return setStage("planning");
  if (action === "history") return requestHistory();
  if (action === "approve" && project.stage === "review") return startBuild();
  if (action === "retry" && ["failed", "stopped"].includes(project.stage)) return startBuild();
  if (action === "review") return setStage("review");
  if (action === "stop") return setStage("stopping");
  if (action === "finish") {
    addMessage(
      "assistant",
      "Finished privately. You can return here for changes whenever you like."
    );
    return setStage("finished");
  }
  if (action === "open-share") return shareDialog.showModal();
  if (action === "close-share") return shareDialog.close();
  if (action === "share") {
    shareDialog.close();
    return setStage("shared");
  }
  if (action === "save-word") project.saved = true;
  if (action === "remove-word") project.saved = false;
  if (action === "saved-words") showSaved = true;
  if (action === "today") showSaved = false;
  if (action === "mock-saved") showMockSaved = true;
  if (action === "mock-today") showMockSaved = false;
  if (action === "model-help") {
    addMessage(
      "assistant",
      "Check the reasoning-tier model in Moss’s AI configuration. This prototype does not change settings; use “Retry planning” to simulate recovery."
    );
    mobilePane = "conversation";
  }
  render();
  if (action.startsWith("mock-")) {
    document
      .querySelector(`[data-action="${action === "mock-saved" ? "mock-today" : "mock-saved"}"]`)
      ?.focus();
    return;
  }
  // Replaced controls need a deliberate focus destination after rendering.
  document
    .querySelector(
      `[data-action="${action === "saved-words" ? "today" : action === "today" ? "saved-words" : action === "save-word" ? "saved-words" : "today"}"]`
    )
    ?.focus();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "message") project.composer = event.target.value;
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "new-project") {
    const data = new FormData(event.target);
    const title = String(data.get("title")).trim();
    const idea = String(data.get("idea")).trim();
    if (!title || !idea) return;
    seed("brief");
    project.title = title;
    project.messages[0].text = idea;
    return go("project");
  }
  if (event.target.id !== "message-form") return;
  const text = project.composer.trim();
  if (!text) {
    document.querySelector("#message").focus();
    return;
  }
  project.composer = "";
  addMessage("user", text);
  // ponytail: arbitrary prompts are recorded, not interpreted; real AI belongs in implementation.
  addMessage(
    "assistant",
    "Your message is recorded in this prototype. Use the suggested reply or “Try a state” controls to continue the scripted Word of the Day journey."
  );
  render();
  document.querySelector("#message").focus();
});

advance.addEventListener("click", () => {
  if (project.stage === "planning") {
    addMessage(
      "assistant",
      `Plan ${project.revision} and its page sketch are ready. Review both before approving the build.`
    );
    setStage("review");
  } else if (project.stage === "building") {
    project.draftHistory = project.history;
    showSaved = false;
    project.events.push(
      [
        "Checks passed",
        project.history
          ? "Daily selection, saving, reopening, removal, and owner isolation."
          : "Daily selection, definition, and example."
      ],
      ["Draft opened", "Sample installed-page proof completed."]
    );
    addMessage("assistant", "The draft is ready. Try it, then tell me what you would change.");
    setStage("draft");
  } else if (project.stage === "stopping") {
    project.events.push(["Builder stopped", "No active process remains for this sample attempt."]);
    setStage("stopped");
  }
  main.focus();
});

scenario.addEventListener("change", () => {
  const value = scenario.value;
  if (value === "empty") {
    project = null;
    return go("list");
  }
  if (project?.stage === "building" && ["failed", "question"].includes(value)) {
    if (value === "failed")
      project.events.push([
        "Daily-word check failed",
        "Word changed on reopening. This attempt stopped; previous draft kept."
      ]);
    else
      addMessage(
        "assistant",
        "Your device’s local date is the planned day boundary. Keep that behavior?"
      );
    return setStage(value, value === "question" ? "conversation" : "artifact");
  }
  seed(value === "list" ? "review" : value === "handoff" ? "brief" : value);
  if (value === "handoff") {
    project.messages = [
      {
        role: "user",
        text: "From Moss: I want a word of the day with a definition and example. Keep the same word all day and use a bundled list."
      },
      {
        role: "assistant",
        text: "I’ve brought over your request and those decisions. We can prepare the plan and page sketch here; you don’t need to brief me again."
      }
    ];
    project.stage = "ready";
  }
  go(value === "list" ? "list" : "project");
});

window.addEventListener("hashchange", () => {
  render();
  main.focus();
});
seed();
render();
