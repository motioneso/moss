// Disposable calendar DOM probe. Injecting this file alone does not start it.
(() => {
  if (globalThis.__mossCalendarProbe) return;
  let timer;
  let route = "";
  let phrase = "";
  let running = false;
  let reason = "Not started";
  let scans = 0;
  let candidates = 0;
  let matched = 0;
  let observed = 0;
  let disappeared = 0;
  let lastScan = "";
  let rows = [];
  const present = new Set();
  const misses = new Map();
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
    disappeared,
    lastScan,
    rows: rows.map((row) => ({ ...row }))
  });
  const stop = (message = "Stopped and cleared") => {
    clearInterval(timer);
    timer = undefined;
    running = false;
    reason = message;
    phrase = "";
    rows = [];
    present.clear();
    misses.clear();
    candidates = matched = observed = disappeared = 0;
    return snapshot();
  };
  const record = (kind, summary) => {
    rows.unshift({ kind, summary, time: lastScan });
    rows = rows.slice(0, 20);
  };
  const scan = (baseline = false) => {
    if (currentRoute() !== route) {
      stop("Calendar route changed; stopped and cleared. Start again on the desired view.");
      return;
    }
    scans++;
    lastScan = new Date().toLocaleTimeString();
    const roots = [...document.querySelectorAll('main, [role="main"]')].filter(visible);
    if (roots.length !== 1) {
      candidates = matched = 0;
      misses.clear();
      reason = "No single calendar main region found; waiting.";
      return;
    }
    // Experimental English event labels: time range or All day. No page-text
    // fallback, dialogs, navigation, event opening, or internal Outlook APIs.
    const buttons = [...roots[0].querySelectorAll('button, [role="button"]')]
      .filter(
        (node) =>
          visible(node) &&
          !node.closest(
            'nav, [role="navigation"], [role="dialog"], [role="textbox"], [contenteditable="true"]'
          )
      )
      .slice(0, 500);
    const labels = buttons
      .map((node) =>
        (node.getAttribute("aria-label") || node.innerText || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 2000)
      )
      .filter((label) => /\b(?:\d{1,2}:\d{2}|\d{1,2}\s*[ap]m|all[ -]day)\b/i.test(label))
      .slice(0, 200);
    candidates = labels.length;
    const current = new Set(
      labels.filter((label) => label.toLowerCase().includes(phrase.toLowerCase())).slice(0, 50)
    );
    matched = current.size;
    for (const label of current) {
      misses.delete(label);
      if (present.has(label)) continue;
      present.add(label);
      if (!baseline) observed++;
      record(
        baseline
          ? "Already displayed at start"
          : "Appeared / changed summary in displayed calendar",
        label
      );
    }
    for (const label of present) {
      if (current.has(label)) continue;
      const count = (misses.get(label) || 0) + 1;
      misses.set(label, count);
      // Two absent scans soften brief rerenders, but do not prove cancellation.
      if (count < 2) continue;
      present.delete(label);
      misses.delete(label);
      disappeared++;
      record("No longer displayed — not proof of cancellation", label);
    }
    reason = "Watching displayed calendar event labels only";
  };
  const start = (filter) => {
    stop();
    if (!/(^|\/)calendar(\/|$)/i.test(location.pathname)) {
      reason = "Open Outlook Calendar first.";
      return snapshot();
    }
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
  globalThis.__mossCalendarProbe = { start, stop, snapshot };
})();
