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
        <div className="fnm-header__ident">
          <span className="jds-eyebrow">Module</span>
          <h1>Finance</h1>
        </div>
        {/*
         * #1759: every module page links to its own settings page. A plain anchor, not a
         * ModuleLink: ModuleLink routes inside the module, and this leaves it. The module
         * runtime hands a web surface React and nothing else, so there is no host navigate
         * to call — the cost is a full page load on click, which is the same trade Food
         * makes for the same link.
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
