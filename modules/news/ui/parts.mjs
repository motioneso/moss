import { h, button, badge, icon, PATHS } from "./dom.mjs";

/** A prerequisite line with its fix link. The link goes through the host, so it opens in the app. */
export function gate({ requirement, href, linkLabel }, navigate) {
  return h(
    "span",
    { class: "nw-set__gate" },
    requirement,
    " ",
    h(
      "a",
      {
        class: "nw-set__gatelink",
        href,
        onClick: (event) => {
          event.preventDefault();
          void navigate(href).catch(() => {});
        }
      },
      linkLabel
    ),
    "."
  );
}

/** A section with a title and one sentence under it. */
export function section(label, title, sub, ...children) {
  return h(
    "section",
    { class: "nw-set", "aria-label": label },
    h(
      "div",
      { class: "nw-set__head" },
      h("h2", { class: "jds-section-title" }, title),
      sub ? h("p", { class: "jds-section-sub" }, sub) : null
    ),
    ...children
  );
}

/** A sub-heading with an optional count badge. */
export function groupHead(title, count) {
  return h(
    "div",
    { class: "nw-set__group-head" },
    h(
      "h3",
      { class: "nw-set__subheading" },
      h("span", {}, title),
      count ? badge(String(count), "neutral") : null
    )
  );
}

export const iconBox = (paths) =>
  h("span", { class: "nw-set__item-icon", "aria-hidden": "true" }, icon(paths));
export const newsIcon = () => iconBox(PATHS.newspaper);

export function sourceHealthBadge(source) {
  if (source.validationStatus !== "approved") return badge("Needs revalidation", "amber");
  switch (source.healthStatus) {
    case "healthy":
      return badge("Healthy", "pine");
    case "authentication_failed":
      return badge("Key rejected", "red");
    case "temporarily_unavailable":
      return badge("Temporarily unavailable", "amber");
    case "disabled":
      return badge("Disabled", "neutral");
    case "unsupported":
      return badge("Unsupported", "amber");
    default:
      return null;
  }
}

export const status = (text, extra = "") =>
  h("p", { class: `nw-set__exstatus${extra}`, role: "status" }, text);
export const failure = (text) => h("p", { class: "nw-set__exerr", role: "alert" }, text);

/** A labelled text box next to its buttons. */
export function textRow({ id, label, value, placeholder, disabled, onInput, buttons }) {
  const input = h("input", {
    id,
    class: "jds-input",
    type: "text",
    value,
    placeholder,
    disabled
  });
  input.addEventListener("input", () => onInput(input.value, input));
  return {
    input,
    nodes: [
      h("label", { class: "nw-set__exlabel", for: id }, label),
      h("div", { class: "nw-set__exrow" }, input, ...(buttons ?? []))
    ]
  };
}

export { button };
