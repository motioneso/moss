/* global document, location, matchMedia, window, FileReader */
// Parent page for a module screen. The signed-in session stays here; the sandboxed frame
// reaches its own module routes only through this bridge.
import { openModuleFrame } from "/module-shared/host-bridge.mjs";

const params = new URLSearchParams(location.search);
const moduleId = params.get("module") ?? "";
const screenPath = params.get("path") ?? "";
// A Today or chat link may carry a short lowercase preset for the screen to open with.
const focusParam = params.get("focus") ?? "";
// A Mac or phone asking to link opens Meetings with its one-time code after the "#". The code is
// read once, taken out of the address bar, and never sent to the server.
const topWindow = globalThis.top ?? globalThis;
let linkCode = null;
if (moduleId === "meetings") {
  linkCode = new URLSearchParams(topWindow.location.hash.replace(/^#/, "")).get("code");
  if (linkCode) {
    topWindow.history.replaceState(
      null,
      "",
      topWindow.location.pathname + topWindow.location.search
    );
  }
}
const frame = document.getElementById("frame");
const failure = document.getElementById("failure");

function fail() {
  frame.hidden = true;
  failure.hidden = false;
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === null ? {} : { "content-type": "application/json" },
    body: body === null ? undefined : JSON.stringify(body)
  });
  // A story picture or site icon comes back as a data address so the sandboxed frame can show it.
  const type = response.headers.get("content-type") ?? "";
  if (response.ok && /^image\/[a-z0-9.+-]+$/i.test(type.split(";")[0].trim())) {
    const blob = await response.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl };
  }
  const text = await response.text();
  if (!response.ok) {
    // The bridge passes the status and a small JSON body on so a screen can show guidance.
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    throw Object.assign(new Error(), { status: response.status, body: parsed });
  }
  if (!text) return null;
  return JSON.parse(text);
}

try {
  const reply = await fetch(
    `/api/modules/${encodeURIComponent(moduleId)}/screen?path=${encodeURIComponent(screenPath)}`,
    { credentials: "same-origin" }
  );
  if (!reply.ok) throw new Error();
  const screen = await reply.json();
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  // Screens word some hints differently for admins, so the parent passes the role along.
  let isAdmin = false;
  try {
    const shellReply = await fetch("/api/shell", { credentials: "same-origin" });
    if (shellReply.ok) isAdmin = (await shellReply.json())?.account?.is_admin === true;
  } catch {
    isAdmin = false;
  }
  document.title = screen.title;
  const screenUrl = new URL(screen.src, location.href);
  if (/^[a-z]{1,20}$/.test(focusParam)) screenUrl.searchParams.set("focus", focusParam);
  // Weather's "Use my location" reads the browser position from inside the sandboxed frame.
  if (moduleId === "weather") frame.setAttribute("allow", "geolocation *");
  openModuleFrame(frame, moduleId, screenUrl.href, {
    request,
    theme: () => ({
      theme: "park-press",
      colorMode: dark ? "dark" : "light",
      isAdmin,
      ...(linkCode ? { linkCode } : {})
    }),
    navigate: async (path) => {
      topWindow.location.assign(path);
      return null;
    },
    open: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
      return null;
    },
    chat: async () => {
      throw new Error();
    },
    save: async ({ filename, contentType, text }) => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([text], { type: contentType }));
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      return null;
    }
  });
} catch {
  fail();
}
