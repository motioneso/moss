/* Review-only state sheet. Controls simulate host-confirmed events; they are not product code. */
/* global document */
const main = document.querySelector("#main");
const picker = document.querySelector("#state-select");
const announcement = document.querySelector("#announcement");

const states = {
  "list-loading": {
    label: "Loading project list",
    badge: "Loading",
    title: "Your Workshop",
    body: `<div class="skeleton-list" aria-label="Loading projects"><span></span><span></span><span></span></div><p class="small muted">Loading your private projects…</p>`
  },
  "list-failure": {
    label: "Project list could not load",
    badge: "Couldn’t load",
    title: "Your projects are still here",
    body: `<div class="notice error" role="alert"><strong>We couldn’t load your projects.</strong><p>Try again when your connection is ready. We won’t replace a failed request with an empty list.</p><button class="jds-btn jds-btn--secondary" data-action="retry-list">Try again</button></div>`
  },
  "detail-loading": {
    label: "Loading project detail",
    badge: "Loading",
    title: "Word of the Day",
    body: `<div class="detail-loading" aria-label="Loading project"><span></span><span></span><span></span></div><p class="small muted">Restoring the conversation and current project work…</p>`
  },
  "detail-failure": {
    label: "Project detail could not load",
    badge: "Couldn’t load",
    title: "This project needs another try",
    body: `<div class="notice error" role="alert"><strong>We couldn’t load the project.</strong><p>Your conversation and unsent message remain on the server. Try again to restore the latest state.</p><button class="jds-btn jds-btn--secondary" data-action="retry-detail">Try again</button></div>`
  },
  "create-pending": {
    label: "Creating project",
    badge: "Creating",
    title: "Let’s shape your idea",
    body: `<form class="state-form"><div class="jds-field"><label class="jds-label" for="idea">Your idea</label><textarea id="idea" class="jds-textarea" rows="3">I want a word of the day with a definition and an example.</textarea><span class="jds-hint">Your text stays in the form while the project is created.</span></div><button class="jds-btn jds-btn--primary" disabled aria-busy="true">Creating project…</button></form>`
  },
  "approve-pending": {
    label: "Approving plan revision 2",
    badge: "Approving",
    title: "Review plan 2",
    body: `<div class="notice waiting" role="status"><strong>Your approval is being recorded.</strong><p>We’ll build only this exact plan revision. Keep this page open while the host confirms it.</p></div><div class="actions"><button class="jds-btn jds-btn--primary" disabled aria-busy="true">Approving plan…</button><button class="jds-btn jds-btn--quiet" data-action="cancel-approval">Keep reviewing</button></div>`
  },
  "stop-pending": {
    label: "Stopping builder",
    badge: "Stopping",
    title: "Stopping the build",
    body: `<div class="notice waiting" role="status"><strong>Stop requested.</strong><p>The builder is ending its process. We’ll keep the previous usable draft until the host confirms it has stopped.</p></div><button class="jds-btn jds-btn--secondary" disabled aria-busy="true">Stopping…</button>`
  },
  "send-failure": {
    label: "Message failed to send",
    badge: "Send failed",
    title: "Your message is still here",
    body: `<form class="state-form"><div class="jds-field"><label class="jds-label" for="retained-message">Message your project assistant</label><textarea id="retained-message" class="jds-textarea" rows="3" aria-invalid="true">Please keep the same word all day.</textarea><span class="jds-hint jds-hint--error" id="send-error">Couldn’t send this message. Your text is retained; try again when connected.</span></div><div class="actions"><button class="jds-btn jds-btn--primary" data-action="retry-send">Try sending again</button><button class="jds-btn jds-btn--quiet" data-action="discard-message">Discard</button></div></form>`
  },
  "stale-approval": {
    label: "Approval superseded",
    badge: "Review needed",
    title: "This approval is out of date",
    body: `<div class="notice error" role="alert"><strong>The plan changed after this approval.</strong><p>Adding saved words created plan 2. Plan 1 can’t start a build now, so nothing was launched.</p></div><div class="actions"><button class="jds-btn jds-btn--primary" data-action="review-current">Review plan 2</button><button class="jds-btn jds-btn--quiet" data-action="discard-stale">Discard this approval</button></div>`
  },
  offline: {
    label: "Disconnected project",
    badge: "Offline",
    title: "You’re offline",
    body: `<div class="notice waiting" role="status"><strong>Your project is read-only until we reconnect.</strong><p>We’ll refresh authoritative state before enabling actions. Your unsent message stays in the composer.</p></div><div class="offline-line"><span class="signal" aria-hidden="true"></span><span>Last confirmed 2 minutes ago · draft still available</span></div><button class="jds-btn jds-btn--primary" data-action="reconnect">Reconnect and refresh</button>`
  },
  capability: {
    label: "Reasoning model unavailable",
    badge: "Needs setup",
    title: "A reasoning model is unavailable",
    body: `<div class="notice error" role="alert"><strong>Planning can’t start with the current configuration.</strong><p>The selected reasoning route is unavailable. Your project and conversation are preserved.</p></div><div class="actions"><a class="jds-btn jds-btn--primary" href="../../../../../settings?section=aiproviders">Open AI settings</a><button class="jds-btn jds-btn--secondary" data-action="retry-planning">Retry planning</button></div><p class="small muted">Settings destination: AI providers · reasoning route.</p>`
  },
  "mockup-generation": {
    label: "Mockup generation failed",
    badge: "Preview failed",
    title: "The page sketch needs another try",
    body: `<div class="preview-failure" role="alert"><div class="artifact-mark" aria-hidden="true">×</div><div><strong>We couldn’t create the visual preview.</strong><p>No visual artifact is available to approve. Retry the capture or continue reviewing the written plan.</p></div></div><div class="actions"><button class="jds-btn jds-btn--primary" data-action="retry-mockup">Retry preview</button><button class="jds-btn jds-btn--quiet" data-action="written-plan">Review written plan</button></div>`
  },
  "mockup-loading": {
    label: "Loading MockupV1 artifact",
    badge: "Loading preview",
    title: "Plan 2 · page sketch",
    body: `<figure class="mockup-frame" aria-label="Loading raster mockup"><div class="mockup-skeleton"></div><figcaption>Loading the owner-scoped PNG artifact…</figcaption></figure><p class="small muted">The host loads a server-issued artifact ID for this revision before showing the image.</p>`
  },
  "mockup-missing": {
    label: "Mockup artifact unavailable",
    badge: "Preview unavailable",
    title: "The page sketch is unavailable",
    body: `<figure class="mockup-frame mockup-frame--empty" role="img" aria-label="Missing raster mockup"><div class="artifact-mark" aria-hidden="true">?</div><figcaption>That preview artifact is missing or no longer matches this revision.</figcaption></figure><div class="notice error" role="alert"><p>Approval stays disabled until the exact PNG/WebP artifact is available.</p></div><button class="jds-btn jds-btn--secondary" data-action="retry-mockup">Try loading again</button>`
  },
  "mockup-ready": {
    label: "Host-rendered MockupV1",
    badge: "Preview ready",
    title: "Plan 2 · Word of the Day",
    body: `<div class="preview-tabs" role="tablist" aria-label="Mockup screen"><button class="jds-btn jds-btn--secondary" role="tab" aria-selected="true" data-screen="home">Home · default</button><button class="jds-btn jds-btn--quiet" role="tab" aria-selected="false" data-screen="saved">Saved words · empty</button></div><figure class="mockup-frame" id="mockup-preview" role="img" aria-label="Illustrative raster preview contract for Word of the Day"><div class="raster-preview"><span class="preview-eyebrow">Word of the Day</span><strong>serendipity</strong><span>noun · a happy unexpected discovery</span></div><figcaption><span>Contract preview · PNG · 1440 × 900</span><span>Artifact hash verified for plan 2</span></figcaption></figure><p class="small muted">Illustrative review tile for the validated raster contract. Production shows the owner-scoped PNG/WebP artifact; no generated HTML, CSS, or script runs here.</p>`
  },
  "storage-pending": {
    label: "Saved-word mutation pending",
    badge: "Saving",
    title: "Saving serendipity",
    body: `<div class="storage-row"><div><strong>Save · serendipity</strong><span>A happy, unexpected discovery.</span></div><button class="jds-btn jds-btn--secondary" disabled aria-busy="true">Saving…</button></div><div class="storage-row"><div><strong>Remove · old word</strong><span>The same confirmation state applies when removing.</span></div><button class="jds-btn jds-btn--secondary" disabled aria-busy="true">Removing…</button></div><p class="small muted">We’ll show the confirmed result after the host confirms the queue and user-scoped record. You can’t submit the opposite action while one is pending.</p>`
  },
  "storage-failure": {
    label: "Saved-word mutation failed",
    badge: "Save failed",
    title: "The word is still unsaved",
    body: `<div class="notice error" role="alert"><strong>Couldn’t save serendipity.</strong><p>The host did not confirm a record. Nothing was added to your saved words.</p></div><div class="storage-row"><div><strong>serendipity</strong><span>Ready to try again.</span></div><button class="jds-btn jds-btn--primary" data-action="retry-save">Try again</button></div>`
  },
  "storage-dedup": {
    label: "Saved-word request deduplicated",
    badge: "Already saving",
    title: "Save already requested",
    body: `<div class="notice waiting" role="status"><strong>That save is already in progress.</strong><p>We ignored the duplicate request and are waiting for the original host confirmation.</p></div><div class="storage-row"><div><strong>serendipity</strong><span>One request · waiting for confirmation.</span></div><button class="jds-btn jds-btn--secondary" disabled>Saving…</button></div>`
  },
  "storage-timeout": {
    label: "Saved-word request timed out",
    badge: "No confirmation",
    title: "We couldn’t confirm the save",
    body: `<div class="notice error" role="alert"><strong>The save timed out.</strong><p>It may still be in flight. Refresh your saved words before trying again so a retry cannot create a duplicate.</p></div><div class="actions"><button class="jds-btn jds-btn--primary" data-action="refresh-storage">Refresh saved words</button><button class="jds-btn jds-btn--quiet" data-action="retry-save">Try again</button></div>`
  },
  "storage-429": {
    label: "Saved-word request rate limited",
    badge: "Try later",
    title: "Too many saves at once",
    body: `<div class="notice waiting" role="alert"><strong>Save is temporarily limited.</strong><p>Wait a moment, then retry. Your word and project remain available, and no unconfirmed save is shown as complete.</p></div><button class="jds-btn jds-btn--secondary" data-action="retry-save">Retry save</button>`
  }
};

function announce(message) {
  announcement.textContent = message;
}

function badgeClass(label) {
  if (label.includes("failed") || label.includes("unavailable") || label.includes("Couldn’t")) {
    return "jds-badge--red";
  }
  if (
    label.includes("pending") ||
    label.includes("Saving") ||
    label.includes("Offline") ||
    label.includes("Try")
  ) {
    return "jds-badge--amber";
  }
  return "jds-badge--neutral";
}

function frame(state) {
  return `<section class="state-page"><div class="state-heading"><div><p class="eyebrow">Workshop state · simulated</p><h1>${state.title}</h1><p class="lede">${state.label}. This sheet shows the user-facing recovery and authority boundary.</p></div><span class="jds-badge ${badgeClass(state.badge)} jds-badge--pill" aria-label="State: ${state.badge}">${state.badge}</span></div><div class="state-grid"><article class="jds-card jds-card--raised state-card"><div class="card-label">Observed state</div>${state.body}</article><aside class="jds-card jds-card--sunken guidance"><div class="card-label">Design contract</div><h2>What the host confirms</h2><ul><li>State-changing actions wait for durable confirmation.</li><li>Failure keeps the project and user text available.</li><li>Retry is explicit and safe to repeat.</li></ul><details><summary>Primitive notes</summary><p class="small muted">Buttons and links use the authored Button API variants. Recovery is a Card; collection emptiness uses EmptyState in the approved journey. Forms use jds-field, jds-label, jds-input, jds-textarea, and jds-hint.</p></details></aside></div></section>`;
}

function render(value = picker.value) {
  const state = states[value] ?? states["list-loading"];
  main.innerHTML = frame(state);
  bindActions();
  main.focus();
}

function bindActions() {
  main.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", () => {
      const action = element.dataset.action;
      if (
        [
          "retry-list",
          "retry-detail",
          "reconnect",
          "retry-planning",
          "review-current",
          "retry-mockup",
          "written-plan",
          "refresh-storage",
          "retry-save",
          "retry-send"
        ].includes(action)
      ) {
        const target =
          action === "reconnect"
            ? "detail-loading"
            : action === "retry-mockup"
              ? "mockup-ready"
              : action === "retry-save"
                ? "storage-pending"
                : action === "retry-send"
                  ? "detail-loading"
                  : "mockup-ready";
        picker.value = target;
        render(target);
        announce(`Simulated ${action.replaceAll("-", " ")}.`);
      } else if (action === "discard-message") {
        const field = main.querySelector("#retained-message");
        if (field) field.value = "";
        field?.focus();
        announce("Message cleared in the simulated sheet.");
      } else {
        announce(`Simulated ${action.replaceAll("-", " ")}.`);
      }
    });
  });
  main.querySelectorAll("[data-screen]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const saved = tab.dataset.screen === "saved";
      main
        .querySelectorAll("[data-screen]")
        .forEach((item) => item.setAttribute("aria-selected", String(item === tab)));
      const preview = main.querySelector(".raster-preview");
      if (preview)
        preview.innerHTML = saved
          ? `<span class="preview-eyebrow">Word of the Day</span><strong>Saved words</strong><span>No saved words yet.</span>`
          : `<span class="preview-eyebrow">Word of the Day</span><strong>serendipity</strong><span>noun · a happy unexpected discovery</span>`;
      announce(saved ? "Showing Saved words, empty state." : "Showing Home, default state.");
    });
  });
}

picker.addEventListener("change", () => render(picker.value));
render();
