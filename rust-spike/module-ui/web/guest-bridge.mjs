/** Each reply uses a transferred MessagePort, which remains bound to this document after
 * navigation. An opaque frame cannot safely receive private replies with targetOrigin '*'. */
export function moduleClient({ guestWindow = globalThis.window, timeoutMs = 30000 } = {}) {
  const transport = new MessageChannel();
  guestWindow.parent.postMessage({ channel: "moss.module.v1", type: "connect" }, "*", [
    transport.port2
  ]);
  const pending = new Map();
  let nextId = 0;
  let live = true;
  const call = (type, data = {}) =>
    new Promise((resolve, reject) => {
      if (!live || pending.size >= 32) {
        reject(new Error("Module closed or busy"));
        return;
      }
      const id = String(++nextId);
      const channel = new MessageChannel();
      const done = () => {
        pending.delete(id);
        clearTimeout(timer);
        channel.port1.close();
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error("Moss did not reply"));
      }, timeoutMs);
      pending.set(id, {
        close: () => {
          done();
          reject(new Error("Module closed"));
        }
      });
      channel.port1.onmessage = (event) => {
        const reply = event.data;
        if (!reply || reply.channel !== "moss.module.v1" || reply.id !== id) return;
        done();
        if (reply.ok === true) resolve(reply.result);
        else reject(new Error("Moss could not finish this request"));
      };
      transport.port1.postMessage({ ...data, channel: "moss.module.v1", id, type }, [
        channel.port2
      ]);
    });
  return {
    request: (method, path, body) => call("request", { method, path, body }),
    theme: () => call("theme"),
    navigate: (path) => call("navigate", { path }),
    chat: (text = "") => call("chat", { text }),
    resize: (height) => call("resize", { height }),
    dispose() {
      live = false;
      transport.port1.close();
      for (const p of pending.values()) p.close();
      pending.clear();
    }
  };
}
