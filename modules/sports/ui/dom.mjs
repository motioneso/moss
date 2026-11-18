/* global document */

/** Builds an element. Props starting with "on" become listeners; null and false children are skipped. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = value;
    } else if (key === "style" && typeof value === "object") {
      for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function button(label, { variant = "primary", size = "md", ...rest } = {}) {
  const cls = ["jds-btn", `jds-btn--${variant}`, size !== "md" ? `jds-btn--${size}` : null, rest.class]
    .filter(Boolean)
    .join(" ");
  return h("button", { type: "button", ...rest, class: cls }, label);
}

const SVG = "http://www.w3.org/2000/svg";

export function svg(attrs, ...paths) {
  const el = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const d of paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    el.append(p);
  }
  return el;
}
