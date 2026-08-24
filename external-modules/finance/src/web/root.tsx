// external-modules/finance/src/web/root.tsx
// FIN-02 (#1147) Task 11: module Root — chrome (eyebrow + heading), one polite
// live region for the whole surface. FIN-03 (#1148) Task 4 adds the in-module
// router (job-search idiom): Feed at "/", Budget at "/budget"; jds-*
// primitives + layout-only fnm-* styles.
import { useSyncExternalStore, type ReactNodeLike } from "@moss/module-web-sdk";
import { ModuleLink, useModulePath } from "./router";
import { BudgetScreen } from "./screens/budget";
import { FeedScreen } from "./screens/feed";
import { ReportsScreen } from "./screens/reports";
import { currentLiveMessage, subscribeLive } from "./states";

export type HostActions = { openAssistant: (input: { starterPrompt: string }) => void };

// One aria-live region at the root: queue-run confirmations and poll-loop
// outcomes announce here so screen readers hear async results without focus
// moves (job-search precedent).
function LiveRegion(): ReactNodeLike {
  const message = useSyncExternalStore(subscribeLive, currentLiveMessage, currentLiveMessage);
  return (
    <div aria-live="polite" role="status" className="fnm-visually-hidden">
      {message}
    </div>
  );
}

const TABS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "/", label: "Feed" },
  { to: "/budget", label: "Budget" },
  { to: "/reports", label: "Reports" }
];

export function Root(props: { hostActions: HostActions }): ReactNodeLike {
  const path = useModulePath();
  return (
    <div className="fnm-root">
      <LiveRegion />
      <header className="fnm-header">
        {/*
         * #1759 — a way back to this module's own settings, where the bank sign-in lives.
         * A plain anchor, not a router push: the module runtime hands a web surface React and
         * nothing else, so there is no host navigate to call (same reasoning as Food's link).
         */}
        <a
          className="jds-btn jds-btn--quiet jds-btn--sm fnm-settings-link"
          href="/settings?section=modules&module=finance"
        >
          Settings
        </a>
      </header>
      <nav className="fnm-chips" aria-label="Finance sections">
        {TABS.map((tab) => (
          <ModuleLink
            key={tab.to}
            to={tab.to}
            variant={path === tab.to ? "secondary" : "quiet"}
            size="sm"
            aria-current={path === tab.to ? "page" : undefined}
          >
            {tab.label}
          </ModuleLink>
        ))}
      </nav>
      {path === "/budget" ? (
        <BudgetScreen />
      ) : path === "/reports" ? (
        <ReportsScreen />
      ) : (
        <FeedScreen hostActions={props.hostActions} />
      )}
    </div>
  );
}
