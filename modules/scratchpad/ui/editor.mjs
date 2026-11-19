/** Plain Markdown transformations, shared by the toolbar and keyboard. Positions use UTF-16. */
export function format(text, start, end, action) {
  if (action === "bold" || action === "italic") {
    const mark = action === "bold" ? "**" : "_";
    return {
      text: text.slice(0, start) + mark + text.slice(start, end) + mark + text.slice(end),
      start: start + mark.length,
      end: end + mark.length
    };
  }
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const until = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  const to = until < 0 ? text.length : until;
  let number = 0;
  const lines = text
    .slice(from, to)
    .split("\n")
    .map((line) => {
      if (action === "indent") return "  " + line;
      if (action === "outdent") return line.replace(/^ {1,2}/, "");
      const stripped = line.replace(/^(\s*)(?:[-*] (?:\[[ xX]\] )?|\d+\. )?/, "$1");
      const indent = stripped.match(/^\s*/)[0];
      const mark = { bullet: "- ", numbered: `${++number}. `, checkbox: "- [ ] " }[action];
      return indent + mark + stripped.slice(indent.length);
    })
    .join("\n");
  const delta = lines.length - (to - from);
  return {
    text: text.slice(0, from) + lines + text.slice(to),
    start: start === end ? Math.max(from, start + delta) : from,
    end: start === end ? Math.max(from, end + delta) : from + lines.length
  };
}
export function continueList(text, start, end) {
  if (start !== end) return null;
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const line = text.slice(from, start);
  const match = /^(\s*)([-*] (?:\[[ xX]\] )?|\d+\. )(.*)$/.exec(line);
  if (!match) return null;
  const [, indent, marker, body] = match;
  if (!body.trim())
    return { text: text.slice(0, from) + text.slice(start), start: from, end: from };
  let next = marker.replace(/\[[xX]\]/, "[ ]");
  if (/^\d/.test(next)) next = `${parseInt(next, 10) + 1}. `;
  const insert = "\n" + indent + next;
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    start: start + insert.length,
    end: start + insert.length
  };
}
export function shortcutMatches(event, shortcut) {
  const parts = shortcut
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop();
  return (
    event.key.toLowerCase() === key &&
    (event.ctrlKey || event.metaKey) ===
      parts.some((p) => ["mod", "ctrl", "cmd", "meta"].includes(p)) &&
    event.altKey === parts.includes("alt") &&
    event.shiftKey === parts.includes("shift")
  );
}
