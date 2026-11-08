/** Connect exactly one opaque module frame. `request` runs the signed-in own-module route;
 * theme/navigation/chat callbacks belong to the host. No credentials cross this channel. */
export function connectModuleFrame(
  frame,
  moduleId,
  { request, theme, navigate, chat, hostWindow = window }
) {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(moduleId)) throw new Error("Invalid module");
  let live = true;
  const pending = new Set();
  const listener = async (event) => {
    if (!live || event.source !== frame.contentWindow || event.origin !== "null") return;
    const message = event.data;
    if (
      !message ||
      message.channel !== "moss.module.v1" ||
      typeof message.id !== "string" ||
      message.id.length > 100 ||
      !message.id ||
      pending.has(message.id) ||
      pending.size >= 32
    )
      return;
    const replyPort = event.ports?.[0];
    if (!replyPort || typeof replyPort.postMessage !== "function") return;
    pending.add(message.id);
    const reply = (body) => {
      if (live) replyPort.postMessage({ channel: "moss.module.v1", id: message.id, ...body });
    };
    try {
      let result;
      switch (message.type) {
        case "request": {
          const { method, path, body = null } = message;
          if (
            !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
            typeof path !== "string" ||
            !path.startsWith("/") ||
            path.startsWith("//") ||
            /[\\#\u0000-\u001f]/.test(path) ||
            path.length > 16384
          )
            throw new Error();
          const url = new URL(`/api/m/${moduleId}${path}`, "https://moss.invalid");
          if (
            !url.pathname.startsWith(`/api/m/${moduleId}/`) ||
            url.origin !== "https://moss.invalid"
          )
            throw new Error();
          if (JSON.stringify(body).length > 1024 * 1024) throw new Error();
          result = await request(method, url.pathname + url.search, body);
          break;
        }
        case "theme":
          result = theme();
          break;
        case "navigate": {
          if (
            typeof message.path !== "string" ||
            !/^\/(?!\/)/.test(message.path) ||
            /[\\\u0000-\u001f]/.test(message.path)
          )
            throw new Error();
          result = await navigate(message.path);
          break;
        }
        case "chat": {
          if (typeof message.text !== "string" || message.text.length > 16384) throw new Error();
          result = await chat(message.text);
          break;
        }
        case "resize": {
          if (!Number.isFinite(message.height)) throw new Error();
          frame.style.height = `${Math.min(10000, Math.max(160, Math.ceil(message.height)))}px`;
          result = null;
          break;
        }
        default:
          throw new Error();
      }
      reply({ ok: true, result });
    } catch {
      reply({ ok: false, error: "Moss could not finish this request" });
    } finally {
      pending.delete(message.id);
      replyPort.close();
    }
  };
  hostWindow.addEventListener("message", listener);
  return () => {
    live = false;
    pending.clear();
    hostWindow.removeEventListener("message", listener);
  };
}
