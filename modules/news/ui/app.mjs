/* global document, window */
import { moduleClient } from "./guest-bridge.mjs";
import { newsApi } from "./api.mjs";
import { createImages } from "./images.mjs";
import { createFeedback } from "./feedback.mjs";
import * as v from "./view.mjs";

const client = moduleClient();
const api = newsApi(client);
const root = document.getElementById("root");

const ADVANCE_MS = 7000;
const STALE_MS = 10 * 60_000;

const state = {
  phase: "loading",
  raw: null,
  failed: false,
  filter: null,
  slide: 0,
  paused: false,
  labels: new Map(),
  dismissed: new Set(),
  savedLess: false,
  loadedAt: 0
};

const labelFor = (key) => state.labels.get(key) ?? key;
const data = () => (state.raw ? v.withoutStories(state.raw, state.dismissed) : null);

const images = createImages(api, { onSettled: resize });
const fb = createFeedback({
  api,
  onChange: draw,
  onDismiss(id) {
    state.dismissed.add(id);
    state.savedLess = true;
    draw();
  }
});

function resize() {
  const bottom = Math.ceil(root.getBoundingClientRect().bottom + window.scrollY);
  void client.resize(bottom).catch(() => {});
}

function activeFilter(current) {
  return state.filter !== null && current.activeTopics.includes(state.filter) ? state.filter : null;
}

function visibleTop(current, filter) {
  return current.topStories
    .filter((h) => v.matchesTopic(h, filter, labelFor))
    .slice(0, v.CAROUSEL_CAP);
}

function draw() {
  const current = data();
  if (!current) {
    root.innerHTML =
      `<div class="nw-wrap">` +
      v.masthead({ activeTopics: [], filter: null, labelFor }) +
      (state.phase === "error" ? v.failureLine(false) : v.loadingLine()) +
      `</div>`;
  } else {
    const filter = activeFilter(current);
    const count = visibleTop(current, filter).length;
    state.slide = Math.min(state.slide, Math.max(count - 1, 0));
    const receipt = state.savedLess
      ? v.note("Preference saved. Manage or remove it in News settings.")
      : "";
    root.innerHTML =
      `<div class="nw-wrap">` +
      v.pageHtml({
        data: current,
        filter,
        labelFor,
        slide: state.slide,
        feedbackHtml: fb.html,
        receipt,
        failed: state.failed
      }) +
      `</div>`;
  }
  images.hydrate(root);
  fb.afterRender(root);
  resize();
}

async function load() {
  try {
    const [overview, catalog] = await Promise.all([
      api.overview(),
      state.labels.size > 0 ? Promise.resolve(null) : api.catalog().catch(() => null)
    ]);
    for (const topic of catalog?.topics ?? []) state.labels.set(topic.topicKey, topic.label);
    state.raw = overview;
    state.phase = "ready";
    state.failed = false;
    state.loadedAt = Date.now();
  } catch {
    if (state.raw) state.failed = true;
    else state.phase = "error";
  }
  draw();
}

/* ---------------------------------------------------------------- Carousel */

function setSlide(next) {
  const current = data();
  if (!current) return;
  const tops = visibleTop(current, activeFilter(current));
  if (tops.length === 0) return;
  state.slide = next;
  root.querySelectorAll(".nw-carousel__slide").forEach((el, i) => {
    const on = i === next;
    el.classList.toggle("nw-carousel__slide--active", on);
    el.setAttribute("aria-hidden", String(!on));
    el.querySelectorAll("a").forEach((a) =>
      on ? a.removeAttribute("tabindex") : a.setAttribute("tabindex", "-1")
    );
    const hero = el.querySelector(".nw-hero");
    hero?.querySelector(":scope > .nw-feedback")?.remove();
    if (on && tops[i]) hero?.insertAdjacentHTML("beforeend", fb.html(tops[i]));
  });
  root.querySelectorAll(".nw-carousel__dot").forEach((dot, i) => {
    if (i === next) dot.setAttribute("aria-current", "true");
    else dot.removeAttribute("aria-current");
  });
}

function slideCount() {
  return root.querySelectorAll(".nw-carousel__slide").length;
}

window.setInterval(() => {
  const count = slideCount();
  if (state.paused || count < 2) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  setSlide((state.slide + 1) % count);
}, ADVANCE_MS);

const inCarousel = (el) => el instanceof Element && el.closest(".nw-carousel") !== null;
root.addEventListener("mouseover", (e) => inCarousel(e.target) && (state.paused = true));
root.addEventListener("mouseout", (e) => {
  if (inCarousel(e.target) && !inCarousel(e.relatedTarget)) state.paused = false;
});
root.addEventListener("focusin", (e) => inCarousel(e.target) && (state.paused = true));
root.addEventListener("focusout", (e) => {
  if (inCarousel(e.target) && !inCarousel(e.relatedTarget)) state.paused = false;
});

/* ------------------------------------------------------------------ Events */

root.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (fb.click(event)) return;
  const link = event.target.closest("a[href]");
  if (link?.hasAttribute("data-ext")) {
    event.preventDefault();
    void client.open(link.href).catch(() => {});
    return;
  }
  if (link?.hasAttribute("data-nav")) {
    event.preventDefault();
    void client.navigate(link.getAttribute("data-nav")).catch(() => {});
    return;
  }
  const slide = event.target.closest("[data-slide]")?.getAttribute("data-slide");
  if (slide !== undefined && slide !== null) {
    const count = slideCount();
    const next =
      slide === "prev"
        ? (state.slide - 1 + count) % count
        : slide === "next"
          ? (state.slide + 1) % count
          : Number(slide);
    setSlide(next);
    return;
  }
  const chip = event.target.closest("[data-filter]");
  if (chip) {
    const key = chip.getAttribute("data-filter");
    state.filter = key === "" ? null : key;
    state.slide = 0;
    draw();
    return;
  }
  if (event.target.closest("[data-retry]")) {
    state.phase = state.raw ? state.phase : "loading";
    if (!state.raw) draw();
    void load();
  }
});
root.addEventListener("submit", (event) => void fb.submit(event));
root.addEventListener("input", (event) => void fb.input(event));
root.addEventListener("keydown", (event) => void fb.key(event));
window.addEventListener("resize", resize);

// Coming back to an aged page reads the front page again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.loadedAt > STALE_MS) void load();
});

client
  .theme()
  .then((theme) => {
    if (typeof theme?.theme === "string") document.documentElement.dataset.theme = theme.theme;
    if (typeof theme?.colorMode === "string")
      document.documentElement.dataset.colorMode = theme.colorMode;
  })
  .catch(() => {});

draw();
void load();
