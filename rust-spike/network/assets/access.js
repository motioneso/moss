/* global document, location */
"use strict";
const status = document.getElementById("status");
const say = (message) => {
  status.textContent = message;
};
const firewallReasons = {
  foreign_rule:
    "The firewall already has a rule named like Moss's that Moss did not create. Moss left it alone and sharing is still off. Rename or remove that rule in your firewall settings, then try again.",
  no_firewall_manager:
    "Moss could not find a firewall manager it can use (ufw or firewalld). Sharing is still off. Install and turn on one of them, then try again.",
  stuck:
    "The firewall rule may still be open. Try again, or remove Moss's rule in your firewall settings."
};
const explanation = (code, reason) =>
  firewallReasons[reason] ||
  {
    sign_in_body_timeout: "That connection was too slow. Try signing in again.",
    sign_in_body_too_large: "This sign-in request is too large. Reload the page and try again.",
    sign_in_rate_limited: "Too many tries. Wait a minute, then try again.",
    INVALID_EMAIL_OR_PASSWORD: "The email or password did not match. Try again.",
    setup_is_complete: "Moss already has an owner. Go back and sign in.",
    setup_is_local_only: "Create the owner account on the computer running Moss.",
    origin_or_sharing_refused: "This address is not allowed. Open Moss at a trusted address.",
    app_firewall_refused:
      "The firewall did not allow Moss. Sharing is still off. Try again and choose Allow, or add Moss in your firewall settings.",
    host_refused: "This address is not trusted. Open Moss at its configured address."
  }[code];
async function call(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    const failure = new Error(
      explanation(result.code, result.reason) ||
        result.message ||
        result.error ||
        "That did not work. Try again."
    );
    failure.sharing = result.sharing;
    throw failure;
  }
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
        if (complete) form.remove();
        else {
          form.hidden = false;
          form.classList.add("auth-form");
        }
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
  const box = document.getElementById("sharing-enabled");
  const confirmBox = document.getElementById("confirm");
  const retry = document.getElementById("retry");
  const paint = (result) => {
    box.checked = result.sharing;
    box.disabled = false;
    document.getElementById("firewall").textContent =
      result.firewall === "allowed" ? "Allowed" : "Not asked yet";
    document.getElementById("address").textContent = result.origins[0] || "No network found.";
    document.getElementById("address-state").textContent = result.sharing ? "On" : "Off";
    document.getElementById("fingerprint").textContent = result.fingerprint;
    const list = document.getElementById("origins");
    list.replaceChildren(
      ...result.origins.map((origin) => {
        const li = document.createElement("li");
        li.textContent = origin;
        return li;
      })
    );
  };
  let target = true;
  const put = async (on) => {
    target = on;
    box.disabled = true;
    retry.hidden = true;
    say(on ? "Waiting for your firewall…" : "Turning sharing off…");
    try {
      await call("/api/network", "PUT", { sharing: on });
      // The change reply carries no address list, so the screen reads the full state again.
      paint(await call("/api/network"));
      say(on ? "Sharing is on. Other devices must sign in." : "Sharing is off.");
    } catch (error) {
      say(error.message);
      retry.hidden = false;
      paint(
        await call("/api/network").catch(() => ({ sharing: false, origins: [], fingerprint: "" }))
      );
    }
  };
  call("/api/network")
    .then((result) => {
      paint(result);
      say(
        result.sharing
          ? "Sharing is on. Other devices must sign in."
          : "Sharing is off. Moss is available on this computer only."
      );
    })
    .catch((error) => say(error.message));
  box.addEventListener("change", () => {
    if (box.checked) {
      box.checked = false;
      confirmBox.hidden = false;
    } else put(false);
  });
  document.getElementById("cancel").addEventListener("click", () => {
    confirmBox.hidden = true;
  });
  const start = () => {
    confirmBox.hidden = true;
    put(true);
  };
  document.getElementById("turn-on").addEventListener("click", start);
  document.getElementById("try-again").addEventListener("click", () => {
    if (target) start();
    else put(false);
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
