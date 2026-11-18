/** Renders generated briefing prose. The text is model output built from outside sources, so
 * nothing is interpreted as HTML, images are dropped and only http and https links stay. */
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

export function safeHref(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function inline(text) {
  const parts = [];
  const pattern =
    /(\[([^\]\n]+)\]\(([^)\s]+)\))|(`([^`\n]+)`)|(\*\*|__)(?=\S)([\s\S]*?\S)\6|(\*|_)(?=\S)([^*_\n]*?\S)\8/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    parts.push(esc(text.slice(last, m.index)));
    if (m[1]) {
      const href = safeHref(m[3]);
      parts.push(
        href
          ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(m[2])}</a>`
          : esc(m[2])
      );
    } else if (m[4]) parts.push(`<code>${esc(m[5])}</code>`);
    else if (m[6]) parts.push(`<strong>${inline(m[7])}</strong>`);
    else parts.push(`<em>${esc(m[9])}</em>`);
    last = m.index + m[0].length;
  }
  parts.push(esc(text.slice(last)));
  return parts.join("");
}

/** A lone bold line is a heading, and a bare known section name is too. */
function headingText(line, sectionNames, startsParagraph) {
  const bold = /^[ \t]*(\*\*|__)([^*_\n]+?)\1[ \t]*:?[ \t]*$/.exec(line);
  if (bold) return bold[2].trim();
  const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(line);
  if (heading) return heading[1].trim();
  const bare = line.trim().replace(/:$/, "").trim();
  if (
    startsParagraph &&
    /^\S/.test(line) &&
    sectionNames.some((n) => n.toLowerCase() === bare.toLowerCase())
  ) {
    return bare;
  }
  return null;
}

export function renderMarkdown(text, sectionNames = []) {
  const out = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p class="jds-brief__body">${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list)
      out.push(`<${list.tag} class="brief-reader__list">${list.items.join("")}</${list.tag}>`);
    list = null;
  };
  let previousBlank = true;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      previousBlank = true;
      continue;
    }
    const item = /^\s{0,3}([-*+]|\d+[.)])[ \t]+(.+)$/.exec(line);
    if (item) {
      flushParagraph();
      const tag = /\d/.test(item[1]) ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(`<li>${inline(item[2])}</li>`);
      previousBlank = false;
      continue;
    }
    const heading = headingText(line, sectionNames, previousBlank);
    previousBlank = false;
    if (heading !== null) {
      flushParagraph();
      flushList();
      out.push(`<h4 class="brief-reader__section-heading">${inline(heading)}</h4>`);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return `<div class="brief-reader__sections">${out.join("")}</div>`;
}
