/* global document, window */
// Runs in each server's persisted web profile, using that profile's signed-in session.
(() => {
  const prefix = "moss.desktop.receipts.v1:";
  const clientKey = "moss.desktop.client.v1";
  const client = () => {
    let id = localStorage.getItem(clientKey);
    if (id === null) {
      id = crypto.randomUUID();
      localStorage.setItem(clientKey, id);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error("Invalid desktop client identity");
    return id;
  };
  const documentId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
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

  // Native replies only after the notification backend reports success (or the user
  // has disabled banners). This is an at-least-once receipt, not proof the person read it.
  window.mossNoticeAck = async (token) => {
    const delivery = inflight.get(token);
    if (!delivery || delivery.account !== account) return;
    try {
      if (delivery.durable) {
        const response = await fetch("/api/desktop/notices", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client: client(),
            events: delivery.ids.map((key) => key.split("@")[0]),
            versions: delivery.ids.map((key) => Number(key.split("@")[1]))
          })
        });
        if (!response.ok) return;
        const saved = await response.json();
        if (saved.account !== delivery.account || account !== delivery.account) return;
        // A partial or unrecognized acceptance never consumes the pending batch.
        if (!delivery.ids.every((key) => saved.acknowledged.includes(key.split("@")[0]))) return;
      }
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

  const observe = (kind, ids, acknowledged) => {
    const durable = kind === "reminder" && Array.isArray(acknowledged);
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
    const present = new Set(next);
    channel.known = [...[...known].filter((id) => !present.has(id)), ...next].slice(-1000);
    channel.pending = next.filter((id) => pending.has(id) && !acknowledged?.includes(id));
    const quiet = !document.hidden && document.hasFocus();
    if (quiet) channel.pending = [];
    save(account, record); // Never send before the pending batch is durable.
    if (!channel.pending.length) return;
    const previous = [...inflight.values()].find((delivery) => delivery.kind === kind);
    if (previous && Date.now() < previous.retryAt) return;
    for (const [token, delivery] of inflight) if (delivery.kind === kind) inflight.delete(token);
    const attempts = (previous?.attempts || 0) + 1;
    const token = `${documentId}:${++sequence}`;
    inflight.set(token, {
      account,
      kind,
      durable,
      ids: channel.pending,
      attempts,
      retryAt: Date.now() + Math.min(60000, 5000 * 2 ** Math.min(attempts - 1, 4))
    });
    window.ipc.postMessage(JSON.stringify({ notice: kind, receipt: token }));
  };

  // One device token per server profile, kept in the profile and handed to the app so its
  // notifier can keep alerting after the window closes. The notifier shares this client id.
  const enrollKey = "moss.desktop.notifier.v1";
  const enrollNotifier = async () => {
    const who = `${client()}:${account}`;
    if (localStorage.getItem(enrollKey) === who) return;
    const response = await fetch("/api/desktop/notifier", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: client() })
    });
    if (!response.ok) return;
    const saved = await response.json();
    window.ipc.postMessage(JSON.stringify({ client: client(), token: saved.token }));
    localStorage.setItem(enrollKey, who);
  };

  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(`/api/desktop/notices?client=${client()}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        if (response.status === 401) {
          // Signed out: the background notifier must stop alerting for this server.
          if (localStorage.getItem(enrollKey) !== null) {
            localStorage.removeItem(enrollKey);
            window.ipc.postMessage(JSON.stringify({ forget: true }));
          }
          account = null;
          inflight.clear();
        }
        return;
      }
      const data = await response.json();
      if (account !== data.account) inflight.clear();
      account = data.account;
      window.ipc.postMessage(JSON.stringify({ heartbeat: true }));
      // Background-alert enrolment must never block in-window delivery.
      await enrollNotifier().catch(() => {});
      // A refreshed notification has a new version, so it counts as new for the window too.
      const keyed = (id) => `${id}@${data.versions?.[id] ?? 0}`;
      observe("reminder", data.events.map(keyed), data.acknowledged?.map(keyed));
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
