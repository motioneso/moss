/* global document, window, fetch, setInterval */
// Runs only in the selected server's web view, using that profile's signed-in session.
(() => {
  let account = null;
  let seen = new Set();
  let chatSeen = new Set();
  let chatReady = false;
  let busy = false;
  const send = (kind) => {
    if (document.hidden || !document.hasFocus()) {
      window.ipc.postMessage(JSON.stringify({ notice: kind }));
    }
  };
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch("/api/desktop/notices", { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 401) {
          account = null;
          seen.clear();
          chatSeen.clear();
          chatReady = false;
        }
        return;
      }
      const data = await response.json();
      const next = new Set(data.events);
      if (account === data.account && data.events.some((id) => !seen.has(id))) send("reminder");
      if (account !== data.account) {
        chatSeen.clear();
        chatReady = false;
      }
      account = data.account;
      seen = next;
      const thread = await fetch("/api/chat/thread", { cache: "no-store" });
      if (thread.ok) {
        const data = await thread.json();
        const replies = data.messages.filter((m) => m.role === "assistant").map((m) => m.id);
        if (chatReady && replies.some((id) => !chatSeen.has(id))) send("chat");
        chatSeen = new Set(replies);
        chatReady = true;
      }
    } catch {
      // An offline server is handled by the app's reachability screen. Keep the baseline.
    } finally {
      busy = false;
    }
  };
  poll();
  setInterval(poll, 5000);
})();
