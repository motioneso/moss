/* global document, location, matchMedia */
// Parent page for a module screen. The signed-in session stays here; the sandboxed frame
// reaches its own module routes only through this bridge.
import { openModuleFrame } from "/module-shared/host-bridge.mjs";

const params = new URLSearchParams(location.search);
const moduleId = params.get("module") ?? "";
const screenPath = params.get("path") ?? "";
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
  const text = await response.text();
  if (!response.ok) {
    // The bridge passes the status and a small JSON body on so a screen can show guidance.
    let parsed = null;
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
  document.title = screen.title;
  openModuleFrame(frame, moduleId, screen.src, {
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
