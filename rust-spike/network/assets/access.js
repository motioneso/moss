/* global document, location */
"use strict";
const status = document.getElementById("status");
const say = (message) => {
  status.setAttribute("role", "status");
  status.textContent = message;
};
const sayAlert = (message) => {
  status.setAttribute("role", "alert");
  status.textContent = message;
};
const firewallReasons = {
  unknown: "Could not confirm the firewall change. Try again.",
  firewall_service_unavailable: "Reinstall Moss or restart the firewall.",
  foreign_rule: "Rename or remove the other rule in your firewall settings, then try again.",
  no_firewall_manager: "Install and turn on ufw or firewalld, then try again.",
  stuck:
    "The firewall rule may still be open. Try again, or remove Moss's rule in your firewall settings.",
  legacy_rule: "Remove the old Moss rule in your firewall settings, then try again.",
  cleaned_up: "The old firewall rule was cleaned up. Try again to turn sharing on."
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
    app_firewall_refused: "The firewall did not allow Moss. Try again.",
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
  const pausedPanel = document.getElementById("paused-sharing");
  const blockedPanel = document.getElementById("blocked-sharing");
  const legacyPanel = document.getElementById("legacy-sharing");
  const resume = document.getElementById("resume-sharing");
  let paused = false;
  let blocked = false;
  let legacy = false;
  let firewallSettings = null;
  const paint = (result) => {
    paused = result.firewall === "paused";
    blocked = result.firewall === "paused_blocked";
    legacy = result.firewall === "legacy";
    if (result.firewall_settings !== undefined) firewallSettings = result.firewall_settings;
    pausedPanel.hidden = !paused;
    blockedPanel.hidden = !blocked;
    legacyPanel.hidden = !legacy;
    resume.disabled = false;
    box.checked = result.sharing || paused || blocked;
    box.disabled = false;
    document.getElementById("firewall").textContent =
      paused || blocked
        ? "Paused"
        : legacy
          ? "Old rule"
          : result.firewall === "allowed"
            ? "Allowed"
            : result.firewall === "disabled"
              ? "Off"
              : "Not asked yet";
    document.getElementById("address").textContent = result.origins[0] || "No network found.";
    document.getElementById("address-state").textContent =
      paused || blocked ? "Paused" : result.sharing ? "On" : "Off";
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
    resume.disabled = true;
    say(on ? "Waiting for your firewall…" : "Turning sharing off…");
    try {
      await call("/api/network", "PUT", { sharing: on });
      // The change reply carries no address list, so the screen reads the full state again.
      paint(await call("/api/network"));
      say("");
    } catch (error) {
      sayAlert(error.message);
      retry.hidden = paused || blocked || legacy;
      // A failed read leaves the screen as it was, since it cannot say what is true now.
      await call("/api/network")
        .then((result) => {
          paint(result);
          retry.hidden = paused || blocked || legacy;
        })
        .catch(() => sayAlert("Moss could not read the current state. Reload this page."));
    }
  };
  call("/api/network")
    .then((result) => {
      paint(result);
      say("");
    })
    .catch((error) => say(error.message));
  resume.addEventListener("click", () => put(true));
  document.getElementById("clear-legacy").addEventListener("click", async () => {
    try {
      await call("/api/network/legacy", "DELETE");
      paint(await call("/api/network"));
      say("The old rule record is cleared. You can turn sharing on again.");
    } catch (error) {
      sayAlert(error.message);
    }
  });
  document.getElementById("open-firewall-settings").addEventListener("click", () => {
    if (firewallSettings) {
      const link = document.createElement("a");
      link.href = firewallSettings;
      link.click();
    } else {
      say("Open your firewall settings and look for Moss in the list of allowed programs.");
    }
  });
  box.addEventListener("change", () => {
    if (box.checked) {
      box.checked = false;
      confirmBox.showModal();
    } else put(false);
  });
  document.getElementById("cancel").addEventListener("click", () => {
    confirmBox.close();
  });
  const start = () => {
    confirmBox.close();
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
