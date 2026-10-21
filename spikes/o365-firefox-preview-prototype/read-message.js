// Disposable DOM probe: no clicks, mutations, network access, or persistent state.
globalThis.__mossReadOpenedMessage = (expectedPhrase = "") => {
  const visible = (element) => {
    if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility === "visible" && element.getClientRects().length > 0;
  };
  const readable = (element) => visible(element) && !element.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="listbox"], [role="option"], nav');
  // Deliberately no page-wide text fallback. The English Outlook label is an
  // experimental selector; unsupported layouts/languages fail without content.
  const bodies = [...document.querySelectorAll('[role="document"][aria-label="Message body"]')].filter(readable);
  if (bodies.length !== 1) return { ok: false, reason: bodies.length > 1 ? "ambiguous" : "missing" };
  const body = bodies[0];

  // Only inspect headings in a nearby message wrapper, never the whole page.
  const isSender = (heading) => /^From:\s*\S/i.test(heading)
    || /^(?:[^<>\n]*<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>|[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/.test(heading);
  const isDate = (heading) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(heading) && /\d/.test(heading);
  const isSubject = (heading) => !isSender(heading) && !isDate(heading) && !/^(To|Cc|Bcc):/i.test(heading);
  let headings = [];
  let subjects = [];
  let scope = body.parentElement;
  // Live layout diagnostics located the synthetic subject at depth 11.
  for (let depth = 0; scope && depth < 12; depth++, scope = scope.parentElement) {
    if (scope.matches('body, html, main, [role="main"]') || scope.querySelector('[role="listbox"], [role="navigation"], nav')) break;
    if (scope.querySelectorAll('[role="document"][aria-label="Message body"]').length !== 1) break;
    headings = [...scope.querySelectorAll('h1, h2, h3, [role="heading"]')].slice(0, 100)
      .filter((heading) => !body.contains(heading) && readable(heading))
      .map((heading) => heading.innerText.trim().slice(0, 500)).filter(Boolean);
    // In the automatic test, intermediate headings must not end the search.
    // Require a unique subject-like heading containing the supplied test phrase.
    subjects = headings.filter(isSubject).filter((heading) => !expectedPhrase
      || heading.toLowerCase().includes(expectedPhrase.toLowerCase()));
    if (subjects.length) break;
  }
  const sender = headings.find(isSender) || "";
  const date = headings.find(isDate) || "";
  const subject = subjects.length === 1 ? subjects[0] : "";
  if (expectedPhrase && !subject.toLowerCase().includes(expectedPhrase.toLowerCase())) return { ok: false, reason: "identity" };

  // Read rendered text nodes only; exclude hidden descendants and controls.
  // Bound both traversal and output, including unusually large messages.
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let text = "";
  let nodes = 0;
  let truncated = false;
  while (walker.nextNode()) {
    if (++nodes > 20000) { truncated = true; break; }
    const node = walker.currentNode;
    const parent = node.parentElement;
    if (!parent || !readable(parent) || parent.closest('script, style, button, input, textarea, select')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    if (!range.getClientRects().length) continue;
    const chunk = node.textContent.trim();
    if (chunk) text += (text ? "\n" : "") + chunk;
    if (text.length > 12000) { text = text.slice(0, 12000); truncated = true; break; }
  }
  if (!text) return { ok: false, reason: "missing" };

  return { ok: true, subject, sender, date, body: text, truncated };
};
