/* global document */
import { moduleClient } from "./guest-bridge.mjs";
const client = moduleClient();
const $ = (id) => document.getElementById(id);
let view = null;
let busy = false;

// Only fixed wording is shown; backend text is never displayed.
const failures = new Map([
  [403, "Only an admin can change the memory search model."],
  [400, "That address or model name was refused. Check both and try again."]
]);

function render() {
  $("form").hidden = !view;
  if (!view) return;
  $("state").textContent = view.set ? "A model is set up." : view.message;
  $("key-note").textContent = view.hasCredential
    ? "A key is saved. Leave this empty to keep it."
    : "No key is saved.";
  $("clear").hidden = !view.set;
  // Saving needs an address, a model name and the off-device confirmation.
  $("save").disabled =
    busy || !$("url").value.trim() || !$("model").value.trim() || !$("confirm").checked;
  $("clear").disabled = busy;
  void client.resize(document.documentElement.scrollHeight).catch(() => {});
}

async function request(method, body) {
  let reply;
  try {
    reply = await client.request(method, "/embedding", body);
  } catch (error) {
    if (!Number.isInteger(error?.status)) throw error;
    reply = { status: error.status, body: error.body };
  }
  if (!(reply && typeof reply.status === "number" && "body" in reply)) {
    reply = { status: 200, body: reply };
  }
  if (reply.status >= 400) {
    const error = new Error("Memory request failed");
    error.status = reply.status;
    throw error;
  }
  return reply.body;
}

async function run(work) {
  if (busy) return;
  busy = true;
  $("status").textContent = "";
  render();
  try {
    view = await work();
    savedUrl = view.url ?? "";
    hasKey = view.hasCredential === true;
    $("url").value = savedUrl;
    $("model").value = view.model ?? view.defaultModel ?? "";
    $("key").value = "";
    $("confirm").checked = false;
  } catch (error) {
    $("status").textContent = failures.get(error?.status) ?? "Could not reach the server.";
  }
  busy = false;
  render();
}

let savedUrl = "";
let hasKey = false;
$("form").addEventListener("input", render);
$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = $("key").value;
  if (!key && hasKey && $("url").value.trim() !== savedUrl) {
    $("status").textContent = "The address changed. Enter the key for the new address first.";
    return;
  }
  void run(() =>
    request("PUT", {
      url: $("url").value.trim(),
      model: $("model").value.trim(),
      ...(key ? { apiKey: key } : {}),
      confirmOffDevice: $("confirm").checked
    })
  );
});
$("clear").addEventListener("click", () => {
  void run(() => request("PUT", { url: "", model: "", confirmOffDevice: true }));
});
void run(() => request("GET"));
