import { useEffect, useRef, useState } from "react";
import type { ChatSurface } from "@moss/shared";

export interface ChatTransition {
  readonly generation: number;
  readonly surface: ChatSurface;
}

/** Serialize conversation switches and reject results from a surface that has since changed. */
export function useChatTransition(surface: ChatSurface, generation: { current: number }) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  useEffect(() => {
    generation.current += 1;
    pendingRef.current = false;
    setPending(false);
  }, [surface, generation]);

  const isCurrent = (transition: ChatTransition) =>
    transition.generation === generation.current && transition.surface === surfaceRef.current;
  return {
    pending,
    begin(): ChatTransition | undefined {
      if (pendingRef.current) return undefined;
      pendingRef.current = true;
      setPending(true);
      generation.current += 1;
      return { generation: generation.current, surface };
    },
    isCurrent,
    finish(transition: ChatTransition) {
      if (!isCurrent(transition)) return;
      pendingRef.current = false;
      setPending(false);
    }
  };
}
