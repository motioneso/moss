import { useRef } from "react";
import { Button, Dialog } from "@moss/ui";

import type { OnboardingStatusResponse } from "@moss/shared";

import { hasConnectedProvider } from "./chat-availability.js";

/**
 * #369 — "Skip setup" must not silently dead-end into a chat that can't answer. When no provider
 * is connected, skipping is still allowed but it must be HONEST: confirm the consequence first.
 *
 * `needsSkipConfirm` is true ⇔ chat would NOT work after the skip: no provider has reached the
 * `ready` install state and the chat route is not usable (members inherit the shared setup).
 * Once chat is usable, skipping is harmless — confirm nothing.
 */
export function needsSkipConfirm(
  status: OnboardingStatusResponse | undefined,
  chatAvailable = false
): boolean {
  return !chatAvailable && !hasConnectedProvider(status);
}

/** Verbatim consequence copy (spec-locked). Exported so tests/callers share one source. */
export const SKIP_CONSEQUENCE_COPY =
  "Chat won't work until you connect a provider. You can do it later in Settings.";

/**
 * Presentational skip-consequence confirmation. PURE: it renders the consequence and routes the
 * user's choice to the caller's `onConfirm` / `onCancel` handlers. It NEVER calls the skip
 * mutation itself, and the caller must NOT invoke the mutation from inside a setState updater
 * (StrictMode double-fires updaters → the destructive skip would run twice — settings-confirm trap).
 */
export function SkipConfirmDialog(props: {
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly pending: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title="Skip setup without connecting a provider?"
      description={SKIP_CONSEQUENCE_COPY}
      initialFocusRef={cancelRef}
      onClose={() => {
        if (!props.pending) props.onCancel();
      }}
      footer={
        <>
          <Button ref={cancelRef} variant="quiet" disabled={props.pending} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button disabled={props.pending} onClick={props.onConfirm}>
            Skip anyway
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
