// external-modules/finance/src/web/states.tsx
// FIN-02 (#1147) Task 11: authored loading/empty/error/disabled/degraded
// states shared by the feed (job-search precedent: every route funnels its
// query snapshot through one gate so the states stay consistent). Text-only —
// no icons, no animation, so prefers-reduced-motion needs no special casing.
import { Card, type ReactNodeLike } from "@moss/module-web-sdk";
import type { QuerySnapshot } from "./store";

export function LoadingState(props: { label: string }): ReactNodeLike {
  return (
    <Card sunken role="status">
      <div className="fnm-state">
        <span className="jds-eyebrow">Loading</span>
        <p>{props.label}…</p>
      </div>
    </Card>
  );
}

export function EmptyState(props: {
  title: string;
  body: string;
  action?: ReactNodeLike;
}): ReactNodeLike {
  return (
    <Card sunken>
      <div className="fnm-state">
        <span className="jds-eyebrow">Nothing here yet</span>
        <h2>{props.title}</h2>
        <p>{props.body}</p>
        {props.action ?? null}
      </div>
    </Card>
  );
}

export function ErrorState(props: { message: string }): ReactNodeLike {
  return (
    <Card sunken role="alert">
      <div className="fnm-state">
        <span className="jds-eyebrow">Something went wrong</span>
        <p>{props.message}</p>
      </div>
    </Card>
  );
}

// Disable removes actions without deleting data: fixed copy, no buttons,
// no assistant handoff from a disabled surface (job-search spec ruling).
export function DisabledState(): ReactNodeLike {
  return (
    <Card sunken role="status">
      <div className="fnm-state">
        <span className="jds-eyebrow">Module off</span>
        <h2>Finance is turned off</h2>
        <p>
          This module was disabled on the server. Your data is preserved; an administrator can
          re-enable it under Settings.
        </p>
      </div>
    </Card>
  );
}

export function DegradedState(props: { detail: string }): ReactNodeLike {
  return (
    <Card sunken role="status">
      <div className="fnm-state">
        <span className="jds-eyebrow">Partially unavailable</span>
        <p>{props.detail}</p>
      </div>
    </Card>
  );
}

// Shared render ladder: the feed funnels its query snapshot through this so
// the five authored states are consistent.
export function outcomeGate<T extends Record<string, unknown>>(
  snapshot: QuerySnapshot<T>,
  render: (result: T) => ReactNodeLike,
  opts?: { loadingLabel?: string }
): ReactNodeLike {
  if (snapshot.status === "loading") {
    return <LoadingState label={opts?.loadingLabel ?? "Loading"} />;
  }
  const outcome = snapshot.outcome;
  if (outcome.kind === "disabled") return <DisabledState />;
  if (outcome.kind === "blocked") {
    return <DegradedState detail="This data needs confirmation in the assistant." />;
  }
  if (outcome.kind === "error") return <ErrorState message={outcome.message} />;
  const status = (outcome.result as { status?: unknown }).status;
  if (status === "error") {
    return <DegradedState detail="This section could not load safely. Try again later." />;
  }
  return <>{render(outcome.result)}</>;
}

// Tiny aria-live announcer: queue runs and similar async outcomes push a
// message here; the Root renders one polite live region for the whole surface.
const liveListeners = new Set<() => void>();
let liveMessage = "";

export function announce(message: string): void {
  liveMessage = message;
  for (const listener of liveListeners) listener();
}

export function subscribeLive(onChange: () => void): () => void {
  liveListeners.add(onChange);
  return () => {
    liveListeners.delete(onChange);
  };
}

export function currentLiveMessage(): string {
  return liveMessage;
}
