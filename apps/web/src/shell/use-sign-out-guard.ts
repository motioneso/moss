import { useCallback, useRef, useState } from "react";
import { hasSessionUnsavedChanges, type SessionUnsavedChangesStore } from "@moss/module-web-sdk";

export function useSignOutGuard(client: SessionUnsavedChangesStore, signOut: () => void) {
  const [confirming, setConfirming] = useState(false);
  const pendingConfirmation = useRef(false);
  const cancel = useCallback(() => {
    pendingConfirmation.current = false;
    setConfirming(false);
  }, []);
  const request = () => {
    if (hasSessionUnsavedChanges(client)) {
      pendingConfirmation.current = true;
      setConfirming(true);
    } else signOut();
  };
  const confirm = () => {
    if (!pendingConfirmation.current) return;
    pendingConfirmation.current = false;
    setConfirming(false);
    signOut();
  };
  return { confirming, request, cancel, confirm };
}
