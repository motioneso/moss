import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

export interface DialogLifecycleOptions {
  readonly ref: RefObject<HTMLElement | null>;
  readonly enabled?: boolean;
  readonly modal?: boolean;
  readonly onClose?: () => void;
  readonly dismissOnEscape?: boolean;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  /** A noninteractive, aria-hidden scrim sibling that must remain pointer-dismissible. */
  readonly backdropRef?: RefObject<HTMLElement | null>;
}

interface ModalEntry {
  readonly panel: HTMLElement;
  readonly backdrop?: HTMLElement | null;
}
interface ModalState {
  readonly modals: ModalEntry[];
  readonly isolated: Map<HTMLElement, { inert: string | null; ariaHidden: string | null }>;
  isolationObserver?: MutationObserver;
  previousBodyOverflow: string;
}
const registryKey = Symbol.for("moss.ui.dialog-lifecycle.v1");

// External modules bundle their own @moss/ui copy. All copies in one document must share
// modal ordering and attribute snapshots; a module-local stack would let them fight.
function modalState(): ModalState {
  const owner = document as Document & { [registryKey]?: ModalState };
  return (owner[registryKey] ??= { modals: [], isolated: new Map(), previousBodyOverflow: "" });
}

function topModal(): ModalEntry | undefined {
  const { modals } = modalState();
  return modals
    .filter(({ panel }) => panel.isConnected)
    .reverse()
    .find(
      ({ panel }) =>
        !modals.some(
          (other) => other.panel !== panel && other.panel.isConnected && panel.contains(other.panel)
        )
    );
}

function restoreIsolation() {
  const { isolated } = modalState();
  for (const [node, before] of isolated) {
    if (node.getAttribute("inert") === "") {
      if (before.inert === null) node.removeAttribute("inert");
      else node.setAttribute("inert", before.inert);
    }
    if (node.getAttribute("aria-hidden") === "true") {
      if (before.ariaHidden === null) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", before.ariaHidden);
    }
  }
  isolated.clear();
}

function synchronizeIsolation() {
  const { isolated } = modalState();
  restoreIsolation();
  const entry = topModal();
  if (!entry) return;
  for (
    let node: HTMLElement | null = entry.panel;
    node && node !== document.body;
    node = node.parentElement
  ) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === node) continue;
      // Only a plain scrim can be exempt. A wrapper holding other interactive content cannot.
      if (
        sibling === entry.backdrop &&
        sibling.getAttribute("aria-hidden") === "true" &&
        sibling.tabIndex < 0 &&
        !sibling.querySelector(
          'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
        )
      )
        continue;
      isolated.set(sibling, {
        inert: sibling.getAttribute("inert"),
        ariaHidden: sibling.getAttribute("aria-hidden")
      });
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
  }
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
    )
  ).filter((element) => {
    if (
      element.tabIndex < 0 ||
      element.matches(":disabled") ||
      element.closest("[hidden], [inert]")
    )
      return false;
    for (
      let node: HTMLElement | null = element;
      node && node !== panel;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

/** Shared lifecycle for mounted dialogs and responsive modal surfaces. Attach the returned
 * onKeyDown to the surface and give it tabIndex={-1}. Nonmodal surfaces never trap focus. */
export function useDialogLifecycle(options: DialogLifecycleOptions) {
  const {
    ref,
    enabled = true,
    modal = true,
    initialFocusRef,
    returnFocusRef,
    backdropRef
  } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const openerRef = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)
  );

  const generationRef = useRef(0);
  useEffect(() => {
    const panel = ref.current;
    if (!enabled || !panel) return;
    const generation = ++generationRef.current;
    const state = modalState();
    const { modals } = state;
    // Refresh on every closed -> open transition, including an opener in an outer modal.
    // A child that mounted earlier in this commit is already inside this panel, so it must
    // not replace the opener captured before that child took focus.
    if (!panel.contains(document.activeElement)) {
      openerRef.current = document.activeElement as HTMLElement | null;
    }
    if (modal) {
      if (modals.length === 0) {
        state.previousBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        state.isolationObserver = new MutationObserver(synchronizeIsolation);
        state.isolationObserver.observe(document.body, { childList: true, subtree: true });
      }
      modals.push({ panel, backdrop: backdropRef?.current });
      // A previously open sibling may have isolated this surface. Remove the old isolation
      // before focus(), because native inert prevents focusing even a registered top modal.
      restoreIsolation();
    }
    const focusPanel = () => {
      const initial = initialFocusRef?.current;
      if (initial && panel.contains(initial) && !initial.matches(":disabled")) initial.focus();
      else panel.focus();
    };
    if ((!modal || topModal()?.panel === panel) && !panel.contains(document.activeElement))
      focusPanel();
    if (modal) synchronizeIsolation();
    const containFocus = (event: FocusEvent) => {
      if (
        modal &&
        topModal()?.panel === panel &&
        event.target instanceof Node &&
        !panel.contains(event.target)
      ) {
        focusPanel();
      }
    };
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (modal) {
        const index = modals.findIndex((entry) => entry.panel === panel);
        if (index !== -1) modals.splice(index, 1);
        synchronizeIsolation();
        if (modals.length === 0) {
          state.isolationObserver?.disconnect();
          state.isolationObserver = undefined;
          document.body.style.overflow = state.previousBodyOverflow;
        }
      }
      const target = returnFocusRef?.current ?? openerRef.current;
      // Let a replacement dialog establish focus before considering restoration. Never steal
      // focus from a newly opened surface or a control deliberately clicked outside a popover.
      queueMicrotask(() => {
        // StrictMode replays effects on the same mounted surface. Only the final active
        // generation may restore focus; a superseded cleanup must not undo replay setup.
        if (generationRef.current !== generation) return;
        const active = document.activeElement;
        if (
          target?.isConnected &&
          (active === document.body || active === null || panel.contains(active))
        ) {
          target.focus();
        }
      });
    };
  }, [enabled, modal, ref, initialFocusRef, returnFocusRef, backdropRef]);

  return (event: KeyboardEvent<HTMLElement>) => {
    const panel = ref.current;
    if (!enabled || !panel || event.defaultPrevented || (modal && topModal()?.panel !== panel))
      return;
    if (event.key === "Escape") {
      // Own Escape even while dismissal is disabled: an enclosing modal must not close.
      event.stopPropagation();
      event.preventDefault();
      if (optionsRef.current.dismissOnEscape !== false) optionsRef.current.onClose?.();
    }
    if (modal && event.key === "Tab") {
      const items = focusableElements(panel);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === panel)
      ) {
        event.preventDefault();
        first.focus();
      }
    }
  };
}
