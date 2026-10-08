/* global document */
// Local design preview only. No device, permission, recording or network APIs are used.
for (const pill of document.querySelectorAll(".meeting-recording-pill")) {
  const trigger = pill.querySelector("[data-source-trigger]");
  const menu = pill.querySelector("[data-source-menu]");
  const closeMenu = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  trigger.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    trigger.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("button")?.focus();
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-source-choice]");
    if (!option) return;
    for (const item of menu.querySelectorAll("[data-source-choice]")) {
      if (item.dataset.sourceChoice === option.dataset.sourceChoice) {
        item.setAttribute("aria-checked", String(item === option));
        item.querySelector("svg").style.opacity = item === option ? "1" : "0";
      }
    }
  });
  menu.addEventListener("keydown", (event) => {
    const options = [...menu.querySelectorAll("button")];
    const index = options.indexOf(document.activeElement);
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % options.length;
    if (event.key === "ArrowUp") next = (index + options.length - 1) % options.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = options.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      options[next].focus();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      closeMenu();
      trigger.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!pill.contains(event.target)) closeMenu();
  });
}
