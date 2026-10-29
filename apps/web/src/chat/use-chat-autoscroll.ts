import { type UIEvent, useCallback, useEffect, useRef, useState } from "react";

const AUTOSCROLL_THRESHOLD_PX = 48;

/**
 * Decides whether the view should keep following new content after a scroll event.
 *
 * A scroll event that does not move the view up comes from content growing under it or from our
 * own scroll-to-bottom, so it never turns following off. Only the user moving up can do that.
 */
export function nextStickToBottom(input: {
  readonly stick: boolean;
  readonly previousTop: number;
  readonly top: number;
  readonly distanceFromBottom: number;
}): boolean {
  if (input.distanceFromBottom <= AUTOSCROLL_THRESHOLD_PX) return true;
  return input.top >= input.previousTop ? input.stick : false;
}

export function useChatAutoscroll() {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottomState] = useState(true);
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const setStickToBottom = useCallback((value: boolean) => {
    stickRef.current = value;
    setStickToBottomState(value);
  }, []);
  const handleBodyScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const next = nextStickToBottom({
        stick: stickRef.current,
        previousTop: lastTopRef.current,
        top: el.scrollTop,
        distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight
      });
      lastTopRef.current = el.scrollTop;
      if (next !== stickRef.current) setStickToBottom(next);
    },
    [setStickToBottom]
  );
  const scrollToLatest = useCallback((behavior: ScrollBehavior) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);
  const jumpToLatest = useCallback(() => {
    setStickToBottom(true);
    scrollToLatest("smooth");
  }, [scrollToLatest, setStickToBottom]);

  // Messages grow in place (streamed text, reveal animations), so the record count alone never
  // changes. Any size change under the body while following scrolls to the new bottom.
  const [observedBody, setObservedBody] = useState<HTMLDivElement | null>(null);
  // The body mounts after the hook (the drawer renders it only when open), so poll the ref each
  // render and hand the element to the effect below through state.
  useEffect(() => {
    if (bodyRef.current !== observedBody) setObservedBody(bodyRef.current);
  });
  useEffect(() => {
    const el = observedBody;
    if (!el || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") {
      return;
    }
    const follow = () => {
      if (stickRef.current) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    };
    const resizeObserver = new ResizeObserver(follow);
    const observeChildren = () => {
      resizeObserver.disconnect();
      for (const child of Array.from(el.children)) resizeObserver.observe(child);
    };
    observeChildren();
    const mutationObserver = new MutationObserver(() => {
      observeChildren();
      follow();
    });
    mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [observedBody]);

  return {
    bodyRef,
    stickToBottom,
    setStickToBottom,
    handleBodyScroll,
    scrollToLatest,
    jumpToLatest
  };
}
