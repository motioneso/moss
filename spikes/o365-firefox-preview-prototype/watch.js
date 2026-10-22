// Tab-local, isolated-world state. Loading this file alone does not start reading.
(() => {
  if (globalThis.__mossInboxProbe) return;
  let timer;
  let route = "";
  let phrase = "";
  let running = false;
  let reason = "Not started";
  let seen = new Set();
  let rows = [];
  let scans = 0;
  let candidates = 0;
  let matched = 0;
  let observed = 0;
  let lastScan = "";
  const currentRoute = () => location.pathname + location.search + location.hash;
  const visible = (node) =>
    !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
    getComputedStyle(node).visibility === "visible" &&
    node.getClientRects().length > 0;
  const snapshot = () => ({
    running,
    reason,
    phrase,
    scans,
    candidates,
    matched,
    observed,
    lastScan,
    rows: rows.map((row) => ({ ...row }))
  });
  const stop = (message = "Stopped and cleared") => {
    clearInterval(timer);
    timer = undefined;
    running = false;
    reason = message;
    seen.clear();
    rows = [];
    phrase = "";
    candidates = matched = observed = 0;
    return snapshot();
  };
  const scan = (baseline = false) => {
    if (currentRoute() !== route) {
      stop("Page route changed; stopped and cleared. Return to Inbox and start again.");
      return;
    }
    scans++;
    lastScan = new Date().toLocaleTimeString();
    // Do not guess from page text or read dropdown/recipient lists. The user
    // chooses Inbox; only a single named, visible message list is supported.
    const lists = [...document.querySelectorAll('[role="listbox"]')].filter(
      (node) =>
        visible(node) &&
        /message|conversation|inbox/i.test(node.getAttribute("aria-label") || "") &&
        !node.closest('nav, [role="navigation"], [role="dialog"], [contenteditable="true"]')
    );
    if (lists.length !== 1) {
      candidates = matched = 0;
      reason =
        lists.length > 1
          ? "Several message lists found; waiting for one Inbox list."
          : "No supported message list found; waiting. Keep Inbox open.";
      return;
    }
    const options = [...lists[0].querySelectorAll('[role="option"]')]
      .filter(
        (node) =>
          node.closest('[role="listbox"]') === lists[0] &&
          visible(node) &&
          !node.closest('[role="textbox"], [contenteditable="true"]')
      )
      .slice(0, 50);
    candidates = options.length;
    matched = 0;
    for (const option of options) {
      // Rendered text only, not HTML, attributes, message IDs, or hidden labels.
      const summary = option.innerText.trim().slice(0, 2000);
      if (!summary || !summary.toLowerCase().includes(phrase.toLowerCase())) continue;
      matched++;
      if (seen.has(summary)) continue;
      seen.add(summary);
      if (seen.size > 500) seen.delete(seen.values().next().value);
      if (!baseline) observed++;
      rows.unshift({
        kind: baseline ? "Already visible at start" : "Newly observed or changed row",
        time: lastScan,
        summary
      });
      rows = rows.slice(0, 20);
    }
    reason = "Watching rendered rows only";
  };
  const start = (filter) => {
    stop();
    if (typeof filter !== "string" || filter.trim().length < 3 || filter.length > 80) {
      reason = "Use a test phrase of 3–80 characters.";
      return snapshot();
    }
    phrase = filter.trim();
    route = currentRoute();
    scans = 0;
    running = true;
    scan(true);
    timer = setInterval(() => scan(), 2000);
    return snapshot();
  };
  globalThis.__mossInboxProbe = { start, stop, snapshot };
})();
