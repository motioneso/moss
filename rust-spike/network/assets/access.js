/* global document, location */
"use strict";
const status = document.getElementById("status");
const say = (message) => {
  status.textContent = message;
};
const explanation = (code) =>
  ({
    sign_in_rate_limited: "Too many tries. Wait a minute, then try again.",
    INVALID_EMAIL_OR_PASSWORD: "The email or password did not match. Try again.",
    setup_is_complete: "Moss already has an owner. Go back and sign in.",
    setup_is_local_only: "Create the owner account on the computer running Moss.",
    origin_or_sharing_refused: "This address is not allowed. Open Moss at a trusted address.",
    host_refused: "This address is not trusted. Open Moss at its configured address."
  })[code];
async function call(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      explanation(result.code) || result.message || result.error || "That did not work. Try again."
    );
  return result;
}
for (const id of ["sign-in", "setup"]) {
  const form = document.getElementById(id);
  if (!form) continue;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    say(id === "setup" ? "Creating your account…" : "Signing in…");
    try {
      await call(
        `/api/auth/${id === "setup" ? "sign-up" : "sign-in"}/email`,
        "POST",
        Object.fromEntries(new FormData(form))
      );
      form.reset();
      location.assign(id === "setup" ? "/settings/sharing" : "/today");
    } catch (error) {
      say(error.message);
      button.disabled = false;
    }
  });
}
if (document.getElementById("setup") || document.getElementById("setup-link")) {
  call("/api/setup/status")
    .then(({ complete }) => {
      const form = document.getElementById("setup");
      if (form) {
        form.hidden = complete;
        say(
          complete
            ? "Moss already has an owner. Go back and sign in."
            : "This account will be the first administrator."
        );
      }
      const link = document.getElementById("setup-link");
      if (link) link.hidden = complete;
    })
    .catch(() => {
      if (document.getElementById("setup"))
        say("Open this page on the computer running Moss to create its owner account.");
    });
}
const sharing = document.getElementById("sharing");
if (sharing) {
  call("/api/network")
    .then((result) => {
      const checkbox = document.getElementById("sharing-enabled");
      document.getElementById("fingerprint").textContent = result.fingerprint;
      checkbox.checked = result.sharing;
      checkbox.disabled = false;
      sharing.querySelector("button").disabled = false;
      for (const origin of result.origins) {
        const li = document.createElement("li");
        li.textContent = origin;
        document.getElementById("origins").append(li);
      }
      say(
        result.sharing
          ? "Sharing is on. Other devices must sign in."
          : "Sharing is off. Moss is available on this computer only."
      );
    })
    .catch((error) => say(error.message));
  sharing.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = sharing.querySelector("button");
    button.disabled = true;
    try {
      const result = await call("/api/network", "PUT", {
        sharing: document.getElementById("sharing-enabled").checked
      });
      say(result.sharing ? "Saved. Other devices can now sign in." : "Saved. Sharing is off.");
    } catch (error) {
      say(error.message);
    } finally {
      button.disabled = false;
    }
  });
}
document.getElementById("sign-out")?.addEventListener("click", async () => {
  try {
    await call("/api/auth/sign-out", "POST", {});
    location.assign("/sign-in");
  } catch (error) {
    say(error.message);
  }
});
