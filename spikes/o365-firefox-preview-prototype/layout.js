(() => {
  // Explicit local diagnostic. Returns fixed labels/counts only, never DOM text,
  // attributes, message content, addresses, identifiers, or the supplied phrase.
  globalThis.__mossDescribeMessageLayout = (phrase) => {
    if (
      typeof phrase !== "string" ||
      !/^MOSS BODY TEST\s+\S/i.test(phrase.trim()) ||
      phrase.length > 80
    ) {
      return {
        report: "Enter the exact synthetic email test phrase, including its suffix, first."
      };
    }
    const visible = (node) =>
      !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
      getComputedStyle(node).visibility === "visible" &&
      node.getClientRects().length > 0;
    const readable = (node) =>
      visible(node) &&
      !node.closest(
        '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="listbox"], [role="option"], nav'
      );
    const selector = '[role="document"][aria-label="Message body"]';
    const bodies = [...document.querySelectorAll(selector)].filter(readable);
    const lines = [`Layout check v0.4.2; readable bodies: ${bodies.length}.`];
    if (bodies.length !== 1) return { report: lines.join("\n") };
    const body = bodies[0];
    let scope = body.parentElement;
    for (let depth = 0; scope && depth < 12; depth++, scope = scope.parentElement) {
      if (scope.matches("body, html")) {
        lines.push("Reached page boundary.");
        break;
      }
      const main = scope.matches('main, [role="main"]');
      const allHeadings = scope.querySelectorAll('h1, h2, h3, [role="heading"]');
      const headings = [...allHeadings]
        .slice(0, 100)
        .filter((node) => !body.contains(node) && readable(node));
      // Compare transiently; never return any heading text or keep a text list.
      const matching = headings.filter((node) =>
        node.innerText.trim().slice(0, 500).toLowerCase().includes(phrase.trim().toLowerCase())
      ).length;
      lines.push(
        `Depth ${depth}: main=${main ? "yes" : "no"}; bodies=${scope.querySelectorAll(selector).length}; lists=${scope.querySelectorAll('[role="listbox"]').length}; navigation=${scope.querySelectorAll('nav, [role="navigation"]').length}; headings=${headings.length}; phrase headings=${matching}; heading cap=${allHeadings.length > 100 ? "yes" : "no"}.`
      );
      if (main) break;
    }
    return { report: lines.join("\n") };
  };
})();
