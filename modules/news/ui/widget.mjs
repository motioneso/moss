/* global document, window */
import { moduleClient } from "./guest-bridge.mjs";
import { newsApi } from "./api.mjs";
import { createImages } from "./images.mjs";
import { createFeedback } from "./feedback.mjs";
import { leadArtSvg } from "./lead-art.mjs";
import * as v from "./view.mjs";

const client = moduleClient();
const api = newsApi(client);
const root = document.getElementById("root");
const state = { raw: null, dismissed: new Set() };

function resize() {
  const bottom = Math.ceil(root.getBoundingClientRect().bottom + window.scrollY);
  void client.resize(bottom).catch(() => {});
}

// A photo that will not load falls back to the drawn artwork; an icon falls back to the name.
const images = createImages(api, {
  onSettled: resize,
  onFail(img) {
    if (img.hasAttribute("data-art")) {
      const lead = v.withoutStories(state.raw, state.dismissed).topStories[0];
      if (lead && img.parentElement) {
        img.parentElement.innerHTML = leadArtSvg({
          topic: lead.topicLabel ?? lead.topicKey ?? "",
          headline: lead.title,
          publisher: lead.sourceLabel
        });
      }
    } else if (img.hasAttribute("data-fallback")) {
      img.parentElement?.replaceWith(document.createTextNode(img.getAttribute("data-fallback")));
    }
  }
});

const fb = createFeedback({
  api,
  onChange: draw,
  onDismiss(id) {
    state.dismissed.add(id);
    draw();
  }
});

function draw() {
  // Nothing is drawn until stories exist, so a fresh install's Today stays clean.
  root.innerHTML = state.raw
    ? v.widgetHtml(v.withoutStories(state.raw, state.dismissed), fb.html, leadArtSvg)
    : "";
  images.hydrate(root);
  fb.afterRender(root);
  resize();
}

root.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (fb.click(event)) return;
  const link = event.target.closest("a[data-ext]");
  if (link) {
    event.preventDefault();
    void client.open(link.href).catch(() => {});
  }
});
root.addEventListener("submit", (event) => void fb.submit(event));
root.addEventListener("input", (event) => void fb.input(event));
root.addEventListener("keydown", (event) => void fb.key(event));
window.addEventListener("resize", resize);

client
  .theme()
  .then((theme) => {
    if (typeof theme?.theme === "string") document.documentElement.dataset.theme = theme.theme;
    if (typeof theme?.colorMode === "string")
      document.documentElement.dataset.colorMode = theme.colorMode;
  })
  .catch(() => {});

api
  .overview()
  .then((overview) => {
    state.raw = overview;
    draw();
  })
  .catch(() => {});
