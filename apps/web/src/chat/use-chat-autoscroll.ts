import { type UIEvent, useCallback, useRef, useState } from "react";

const AUTOSCROLL_THRESHOLD_PX = 48;

export function useChatAutoscroll() {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const handleBodyScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom <= AUTOSCROLL_THRESHOLD_PX);
  }, []);
  const scrollToLatest = useCallback((behavior: ScrollBehavior) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);
  const jumpToLatest = useCallback(() => {
    setStickToBottom(true);
    scrollToLatest("smooth");
  }, [scrollToLatest]);
  return {
    bodyRef,
    stickToBottom,
    setStickToBottom,
    handleBodyScroll,
    scrollToLatest,
    jumpToLatest
  };
}
