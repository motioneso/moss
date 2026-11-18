/* global document */
import { autoAdvance, rotationControl } from "./rotation.mjs";
import { clear, h, svg } from "./dom.mjs";
import { BIG_STORY_WEIGHT, isWrittenArticle, rankStories, storyKey } from "./ranking.mjs";

const CAROUSEL_CAP = 5;
const CAROUSEL_ADVANCE_MS = 7000;
const MAJORS_CAP = 2;
const STANDARDS_CAP = 6;
const BRIEFS_CAP = 10;

const chevron = (d) =>
  svg(
    {
      viewBox: "0 0 24 24",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    },
    d
  );

export const newsIcon = () =>
  svg(
    {
      viewBox: "0 0 24 24",
      width: 15,
      height: 15,
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true"
    },
    "M4 5h13v14H4zM17 8h3v9a2 2 0 0 1-2 2h-1M7 8h7M7 12h7M7 16h4"
  );

const link = (headline, cls, ...children) =>
  h("a", { class: cls, href: headline.url, target: "_blank", rel: "noreferrer" }, ...children);

/** A story photo. A photo that fails to load is dropped and the slot shows its empty form. */
function photo(cls, url, empty) {
  const img = h("img", { class: cls, src: url, alt: "", loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(empty()));
  return img;
}

function heroSlide(headline, active) {
  const empty = () => h("div", { class: "sp-photo sp-photo--herostory", "aria-hidden": "true" });
  const a = h(
    "a",
    {
      class: "sp-hero__link",
      href: headline.url,
      target: "_blank",
      rel: "noreferrer",
      tabindex: active ? null : "-1"
    },
    headline.title
  );
  const more = h(
    "a",
    {
      class: "jds-btn jds-btn--link",
      href: headline.url,
      target: "_blank",
      rel: "noreferrer",
      tabindex: active ? null : "-1"
    },
    "Continue reading",
    h("span", { "aria-hidden": "true" }, " →")
  );
  return h(
    "article",
    {
      class: active ? "sp-carousel__slide sp-carousel__slide--active" : "sp-carousel__slide",
      role: "group",
      "aria-roledescription": "slide",
      "aria-hidden": active ? "false" : "true"
    },
    h(
      "div",
      { class: "sp-hero sp-hero--story sp-hero--split sp-fbhost" },
      headline.imageUrl
        ? photo("sp-photo sp-photo--herostory sp-photo--img", headline.imageUrl, empty)
        : empty(),
      h(
        "div",
        { class: "sp-hero__storybody" },
        h(
          "p",
          { class: "sp-hero__kicker" },
          h("span", { class: "sp-hero__kicker-desk" }, "Top story"),
          h(
            "span",
            { class: "sp-hero__kicker-comp" },
            `${headline.competitionLabel} · ${headline.publisherLabel}`
          )
        ),
        h("h2", { class: "sp-hero__headline" }, a),
        headline.summary ? h("p", { class: "sp-hero__dek" }, headline.summary) : null,
        more
      )
    )
  );
}

/** Rotating hero for a quiet day. Up to five top stories, one shown at a time. */
export function heroCarousel({ headlines, degraded = false }) {
  const slides = headlines.slice(0, CAROUSEL_CAP);
  const count = slides.length;
  if (count === 0) {
    return h(
      "section",
      { class: "sp-hero sp-hero--story sp-hero--split", "aria-label": "Top story" },
      h("div", { class: "sp-photo sp-photo--herostory", "aria-hidden": "true" }),
      h(
        "div",
        { class: "sp-hero__storybody" },
        h(
          "h2",
          { class: "sp-hero__headline" },
          degraded ? "Sports information is unavailable" : "No followed game today"
        )
      )
    );
  }
  let active = 0;
  const root = h("section", {
    class: "sp-carousel",
    "aria-label": "Top stories",
    "aria-roledescription": "carousel"
  });
  const stage = h(
    "div",
    { class: "sp-carousel__stage" },
    slides.map((s, i) => heroSlide(s, i === 0))
  );
  const ctl = h("div", { class: "sp-carousel__ctl" });
  const go = (next) => {
    active = (next + count) % count;
    paint();
  };
  const rotation = autoAdvance({
    root,
    count: () => count,
    advance: () => go(active + 1),
    intervalMs: CAROUSEL_ADVANCE_MS,
    onChange: () => count > 1 && paintControls()
  });

  function paint() {
    [...stage.children].forEach((slide, i) => {
      const on = i === active;
      slide.className = on ? "sp-carousel__slide sp-carousel__slide--active" : "sp-carousel__slide";
      slide.setAttribute("aria-hidden", on ? "false" : "true");
      slide
        .querySelectorAll("a")
        .forEach((a) => (on ? a.removeAttribute("tabindex") : a.setAttribute("tabindex", "-1")));
    });
    ctl
      .querySelectorAll(".sp-carousel__dot")
      .forEach((dot, i) =>
        i === active
          ? dot.setAttribute("aria-current", "true")
          : dot.removeAttribute("aria-current")
      );
  }

  function paintControls() {
    clear(ctl).append(
      ...[rotationControl(rotation)].flat().filter(Boolean),
      h(
        "button",
        {
          type: "button",
          class: "jds-iconbtn",
          "aria-label": "Previous story",
          onClick: () => go(active - 1)
        },
        chevron("M15 18l-6-6 6-6")
      ),
      h(
        "div",
        { class: "sp-carousel__dots" },
        slides.map((_, i) =>
          h("button", {
            type: "button",
            class: "sp-carousel__dot",
            "aria-label": `Story ${i + 1} of ${count}`,
            "aria-current": i === active ? "true" : null,
            onClick: () => go(i)
          })
        )
      ),
      h(
        "button",
        {
          type: "button",
          class: "jds-iconbtn",
          "aria-label": "Next story",
          onClick: () => go(active + 1)
        },
        chevron("M9 18l6-6-6-6")
      )
    );
  }

  root.append(stage);
  if (count > 1) {
    root.append(ctl);
    paintControls();
  }
  root.stop = () => rotation.stop();
  return root;
}

/** The compact "Top stories" list beside the standings. */
export function latestColumn(headlines) {
  if (headlines.length === 0) return null;
  return h(
    "section",
    { class: "sp-latest", "aria-label": "Top stories" },
    h("p", { class: "sp-col__kicker" }, "Top stories"),
    h(
      "ol",
      { class: "sp-latest__list" },
      headlines.slice(0, 6).map((headline) => {
        const empty = () =>
          h("span", { class: "sp-hl__thumb sp-hl__thumb--empty", "aria-hidden": "true" });
        return h(
          "li",
          { class: "sp-latest__item sp-fbhost" },
          link(
            headline,
            "sp-hl",
            headline.imageUrl ? photo("sp-hl__thumb", headline.imageUrl, empty) : empty(),
            h(
              "span",
              { class: "sp-hl__body" },
              h("span", { class: "sp-hl__comp" }, headline.competitionLabel),
              h("span", { class: "sp-hl__title" }, headline.title)
            )
          )
        );
      })
    )
  );
}

function newsArticle(headline, major) {
  const cls = [
    "sp-newsband__art",
    major ? "sp-newsband__art--major" : null,
    major && isWrittenArticle(headline) ? "sp-newsband__art--longform" : null,
    "sp-fbhost"
  ]
    .filter(Boolean)
    .join(" ");
  return h(
    "article",
    { class: cls },
    headline.imageUrl
      ? photo("sp-newsband__img", headline.imageUrl, () => document.createComment(""))
      : null,
    h(
      "p",
      { class: "sp-newsband__artkicker" },
      `${headline.competitionLabel} · ${headline.publisherLabel}`
    ),
    h("h4", { class: "sp-newsband__title" }, headline.title),
    headline.summary ? h("p", { class: "sp-newsband__blurb" }, headline.summary) : null,
    link(headline, "sp-newsband__more", "Continue reading →")
  );
}

function featureArticle(headline) {
  const frame = h("div", { class: "sp-newsband__imgframe" });
  if (headline.imageUrl) {
    const img = h("img", {
      class: "sp-newsband__img sp-newsband__img--feature",
      src: headline.imageUrl,
      alt: "",
      loading: "lazy"
    });
    // A small square logo is shown at its own size on a plate, never stretched.
    img.addEventListener("load", () => {
      if (img.naturalWidth > 0 && img.naturalWidth < 400)
        frame.classList.add("sp-newsband__imgframe--logo");
    });
    img.addEventListener("error", () => frame.remove());
    frame.append(img);
  }
  const paragraphs = headline.body
    ? headline.body
        .split("\n\n")
        .map((p) => h("p", { class: "sp-newsband__blurb sp-newsband__blurb--feature" }, p))
    : headline.summary
      ? [h("p", { class: "sp-newsband__blurb sp-newsband__blurb--feature" }, headline.summary)]
      : [];
  return h(
    "article",
    { class: "sp-newsband__feature sp-fbhost" },
    headline.imageUrl ? frame : null,
    h(
      "div",
      { class: "sp-newsband__featurebody" },
      h(
        "p",
        { class: "sp-newsband__featurekicker" },
        `${headline.competitionLabel} · ${headline.publisherLabel}`
      ),
      h("h3", { class: "sp-newsband__title sp-newsband__title--feature" }, headline.title),
      paragraphs,
      link(headline, "sp-newsband__more", "Continue reading →")
    )
  );
}

const groupKey = (group) =>
  group.kind === "sport" ? `sport:${group.sportKey}` : `competition:${group.competitionKey}`;

/** The news band below the grid, with a league filter. */
export function newsBand({ groups, followed }) {
  const visible = groups.filter((g) => g.headlines.length > 0);
  if (visible.length === 0) return null;
  const root = h("section", { class: "sp-newsband", "aria-label": "Sports news" });
  const body = h("div", { class: "sp-newsband__body" });
  const select = h(
    "select",
    {
      class: "sp-newsband__filter",
      "aria-label": "Filter sports news",
      onChange: () => paint(select.value)
    },
    h("option", { value: "all" }, "All"),
    visible.map((g) => h("option", { value: groupKey(g) }, g.competitionLabel))
  );

  function paint(filterKey) {
    const shown = filterKey === "all" ? visible : visible.filter((g) => groupKey(g) === filterKey);
    const ranked = rankStories(shown, followed);
    const feature = ranked[0] && ranked[0].weight >= BIG_STORY_WEIGHT ? ranked[0].headline : null;
    const rest = feature ? ranked.slice(1) : ranked;
    const majors = rest.filter((s) => s.headline.imageUrl).slice(0, MAJORS_CAP);
    const majorSet = new Set(majors.map((s) => s.headline));
    const flow = rest.filter((s) => !majorSet.has(s.headline));
    const standards = flow.slice(0, STANDARDS_CAP);
    const mosaicSet = new Set([...majors, ...standards].map((s) => s.headline));
    const mosaic = rest.filter((s) => mosaicSet.has(s.headline));
    const briefs = flow.slice(STANDARDS_CAP, STANDARDS_CAP + BRIEFS_CAP);
    clear(body).append(
      ...[
        feature ? featureArticle(feature) : null,
        h(
          "div",
          { class: "sp-newsband__mosaic" },
          mosaic.map(({ headline }) => newsArticle(headline, majorSet.has(headline)))
        ),
        briefs.length > 0
          ? h(
              "div",
              { class: "sp-newsband__briefs" },
              h("p", { class: "sp-newsband__briefslabel" }, "In brief"),
              h(
                "ul",
                { class: "sp-newsband__brieflist" },
                briefs.map(({ headline }) =>
                  h(
                    "li",
                    { class: "sp-newsband__brief sp-fbhost" },
                    link(
                      headline,
                      "sp-newsband__brieflink",
                      h("span", { class: "sp-newsband__brieftag" }, headline.competitionLabel),
                      headline.title
                    )
                  )
                )
              )
            )
          : null
      ].filter(Boolean)
    );
  }

  root.append(
    h("div", { class: "sp-newsband__head" }, h("p", { class: "sp-col__kicker" }, "News"), select),
    body
  );
  paint("all");
  return root;
}

export { storyKey };
