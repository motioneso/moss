/* global crypto, document, localStorage, window */
// Runs in each server's persisted web profile, using that profile's signed-in session.
(() => {
  const prefix = "moss.desktop.receipts.v1:";
  const documentId = crypto.randomUUID();
  let account = null;
  let busy = false;
  let sequence = 0;
  const inflight = new Map();
  const empty = () => ({ known: null, pending: [] });
  const valid = (channel) =>
    channel &&
    (channel.known === null ||
      (Array.isArray(channel.known) && channel.known.every((id) => typeof id === "string"))) &&
    Array.isArray(channel.pending) &&
    channel.pending.every((id) => typeof id === "string");
  const load = (actor) => {
    const saved = localStorage.getItem(prefix + actor);
    if (saved === null) return { reminder: empty(), chat: empty() };
    const record = JSON.parse(saved);
    if (!valid(record.reminder) || !valid(record.chat)) throw new Error("Invalid desktop receipts");
    return record;
  };
  const save = (actor, record) => localStorage.setItem(prefix + actor, JSON.stringify(record));

  // Native replies only after the desktop notification API accepts the banner (or the user
  // has disabled banners). This is an at-least-once receipt, not proof the person read it.
  window.mossNoticeAck = (token) => {
    const delivery = inflight.get(token);
    if (!delivery || delivery.account !== account) return;
    try {
      const record = load(account);
      record[delivery.kind].pending = record[delivery.kind].pending.filter(
        (id) => !delivery.ids.includes(id)
      );
      save(account, record);
      inflight.delete(token);
    } catch {
      // Keep pending IDs when persistence fails. A later poll retries; a duplicate is possible.
    }
  };

  const observe = (kind, ids) => {
    const record = load(account);
    const channel = record[kind];
    const next = [...new Set(ids)].slice(-1000);
    const known = new Set(channel.known || []);
    const pending = new Set(channel.pending);
    if (channel.known !== null) {
      for (const id of next) if (!known.has(id)) pending.add(id);
    }
    // Bound receipts to the recent history and the current unread page. Pending delivery
    // only matters while an item remains visible in the server's current result.
    channel.known = [...new Set([...known, ...next])].slice(-1000);
    channel.pending = next.filter((id) => pending.has(id));
    const quiet = !document.hidden && document.hasFocus();
    if (quiet) channel.pending = [];
    save(account, record); // Never send before the pending batch is durable.
    if (!channel.pending.length) return;
    for (const [token, delivery] of inflight) if (delivery.kind === kind) inflight.delete(token);
    const token = `${documentId}:${++sequence}`;
    inflight.set(token, { account, kind, ids: channel.pending });
    window.ipc.postMessage(JSON.stringify({ notice: kind, receipt: token }));
  };

  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch("/api/desktop/notices", { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 401) {
          account = null;
          inflight.clear();
        }
        return;
      }
      const data = await response.json();
      if (account !== data.account) inflight.clear();
      account = data.account;
      observe("reminder", data.events);
      const thread = await fetch("/api/chat/thread", { cache: "no-store" });
      if (thread.ok) {
        const data = await thread.json();
        observe(
          "chat",
          data.messages.filter((m) => m.role === "assistant").map((m) => m.id)
        );
      }
    } catch {
      // Offline servers and unavailable/corrupt receipt storage do not advance delivery.
    } finally {
      busy = false;
    }
  };
  poll();
  setInterval(poll, 5000);
})();
