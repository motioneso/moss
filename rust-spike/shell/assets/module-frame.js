/* global document, location, matchMedia */
// Parent page for a module screen. The signed-in session stays here; the sandboxed frame
// reaches its own module routes only through this bridge.
import { openModuleFrame } from "/module-shared/host-bridge.mjs";

const params = new URLSearchParams(location.search);
const moduleId = params.get("module") ?? "";
const screenPath = params.get("path") ?? "";
// A Today or chat link may carry a short lowercase preset for the screen to open with.
const focusParam = params.get("focus") ?? "";
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
  if (!response.ok) throw new Error();
  const text = await response.text();
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
  document.title = screen.title;
  const screenUrl = new URL(screen.src, location.href);
  if (/^[a-z]{1,20}$/.test(focusParam)) screenUrl.searchParams.set("focus", focusParam);
  openModuleFrame(frame, moduleId, screenUrl.href, {
    request,
    theme: () => ({ theme: "park-press", colorMode: dark ? "dark" : "light" }),
    navigate: async (path) => {
      (globalThis.top ?? globalThis).location.assign(path);
      return null;
    },
    chat: async () => {
      throw new Error();
    }
  });
} catch {
  fail();
}
