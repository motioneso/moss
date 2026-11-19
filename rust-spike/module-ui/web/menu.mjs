/** Shared imperative menu lifecycle for package screens using the shipped JDS menu. */
export function bindMenus(root, changed = () => {}, owner = root.ownerDocument) {
  let trigger = null;
  function close(restore = false) {
    if (!trigger) return;
    const previous = trigger;
    previous.setAttribute("aria-expanded", "false");
    previous.nextElementSibling.hidden = true;
    trigger = null;
    if (restore) previous.focus();
    changed();
  }
  function items() {
    return [...trigger.nextElementSibling.querySelectorAll('[role="menuitem"]')];
  }
  function open(button, last = false) {
    close();
    trigger = button;
    trigger.setAttribute("aria-expanded", "true");
    trigger.nextElementSibling.hidden = false;
    const choices = items();
    choices[last ? choices.length - 1 : 0]?.focus();
    changed();
  }
  function click(event) {
    const button = event.target.closest?.("[data-menu-trigger]");
    if (button && root.contains(button) && !button.disabled) {
      if (button === trigger) close(true);
      else open(button);
    } else if (trigger && event.target.closest?.('[role="menuitem"]')) close(true);
  }
  function outside(event) {
    if (trigger && !trigger.parentElement.contains(event.target)) close();
  }
  function key(event) {
    const button = event.target.closest?.("[data-menu-trigger]");
    if (button && !button.disabled && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      open(button, event.key === "ArrowUp");
      return;
    }
    if (!trigger) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close();
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const choices = items();
      const current = choices.indexOf(owner.activeElement);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? choices.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      choices[index]?.focus();
    }
  }
  root.addEventListener("click", click);
  root.addEventListener("keydown", key);
  owner.addEventListener("pointerdown", outside);
  return () => {
    close();
    root.removeEventListener("click", click);
    root.removeEventListener("keydown", key);
    owner.removeEventListener("pointerdown", outside);
  };
}
