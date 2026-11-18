import { h, svg } from "./dom.mjs";
import { formatDate } from "./locale.mjs";

export function initials(name, shortName) {
  if (shortName && shortName.trim().length > 0) return shortName.slice(0, 3).toUpperCase();
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? name;
  const last = parts[parts.length - 1] ?? name;
  const letters = parts.length >= 2 ? (first[0] ?? "") + (last[0] ?? "") : name.slice(0, 2);
  return letters.toUpperCase();
}

/** A team or league mark. Falls back to an initials swatch when the image is missing or fails to load. */
export function crest({ name, shortName, crestUrl, size = "sm" }) {
  const cls = `sp-crest sp-crest--${size}`;
  const swatch = () => h("span", { class: `${cls} sp-crest--swatch` }, initials(name, shortName));
  if (!crestUrl) return swatch();
  const img = h("img", { class: "sp-crest__img", src: crestUrl, alt: "", width: 44, height: 44 });
  const wrap = h("span", { class: cls }, img);
  img.addEventListener("error", () => wrap.replaceWith(swatch()));
  return wrap;
}

export const liveDot = () => h("span", { class: "sp-livedot", "aria-hidden": "true" });

/** W/D/L form pips. Wins are green, draws steel, losses neutral, never red. */
export function formPips(form, detail, locale) {
  if (!form || form.length === 0) return null;
  return h(
    "span",
    { class: "sp-formrow", "aria-label": "recent form" },
    form.map((result, index) => formPip(result, detail?.[index], locale))
  );
}

function formPip(result, detail, locale) {
  const cls = `sp-formpip sp-formpip--${result.toLowerCase()}`;
  if (!detail) return h("span", { class: cls }, result);
  const verb = result === "W" ? "Won" : result === "D" ? "Drew" : "Lost";
  const prep = detail.homeAway === "home" ? "vs" : "at";
  const played = formatDate(detail.playedAt, locale, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  const label = `${verb} ${detail.score} ${prep} ${detail.opponentName}, ${played}`;
  return h(
    "span",
    { class: `${cls} sp-formpip--pop`, tabindex: "0", role: "note", "aria-label": label },
    result,
    h(
      "span",
      { class: "sp-formpop", "aria-hidden": "true" },
      h(
        "span",
        { class: "sp-formpop__top" },
        h("span", { class: "sp-formpop__verb" }, verb),
        h("span", { class: "sp-formpop__score" }, detail.score)
      ),
      h("span", { class: "sp-formpop__opp" }, `${prep} ${detail.opponentName}`),
      h("span", { class: "sp-formpop__date" }, played)
    )
  );
}

export const trophyIcon = () =>
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
    "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 4H4v2a3 3 0 0 0 3 3M17 4h3v2a3 3 0 0 1-3 3"
  );
