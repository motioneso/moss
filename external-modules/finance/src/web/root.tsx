// external-modules/finance/src/web/root.tsx
// FIN-02 (#1147) Task 11: module Root — chrome (eyebrow + heading), one polite
// live region for the whole surface. FIN-03 (#1148) Task 4 adds the in-module
// router (job-search idiom): Feed at "/", Budget at "/budget"; jds-*
// primitives + layout-only fnm-* styles.
import {
  Segmented,
  useEffect,
  useSyncExternalStore,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { navigate, useModulePath } from "./router";
import { BudgetScreen } from "./screens/budget";
import { FeedScreen } from "./screens/feed";
import { ReportsScreen } from "./screens/reports";
import { StartScreen } from "./screens/start";
import { currentLiveMessage, EmptyState, subscribeLive } from "./states";

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

// The tab bar names Budget, Transactions and Accounts. Other pages (Getting started,
// Settings, Reports) show it with nothing selected so there is always a way back.
type Tab = "budget" | "transactions" | "accounts";
const TAB_PATHS: Record<Tab, string> = {
  budget: "/",
  transactions: "/transactions",
  accounts: "/accounts"
};

function tabFor(path: string): Tab | "none" {
  if (path === "/") return "budget";
  if (path === "/transactions") return "transactions";
  if (path === "/accounts") return "accounts";
  return "none";
}

// Stand-in until the Accounts screen lands.
function PendingScreen(props: { title: string }): ReactNodeLike {
  return <EmptyState title={props.title} body="This screen is not available yet." />;
}

export function Root(props: { hostActions: HostActions }): ReactNodeLike {
  const path = useModulePath();
  // The old Feed and Budget paths now live at Transactions and the Budget home.
  useEffect(() => {
    if (path === "/budget") navigate("/");
  }, [path]);
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
      <div className="fnm-tabs">
        <Segmented
          ariaLabel="Finance views"
          value={tabFor(path) as Tab}
          onChange={(tab: Tab) => navigate(TAB_PATHS[tab])}
          options={[
            { value: "budget", label: "Budget" },
            { value: "transactions", label: "Transactions" },
            { value: "accounts", label: "Accounts" }
          ]}
        />
      </div>
      {path === "/start" ? (
        <StartScreen hostActions={props.hostActions} />
      ) : path === "/" ? (
        <BudgetScreen />
      ) : path === "/transactions" ? (
        <FeedScreen hostActions={props.hostActions} />
      ) : path === "/accounts" ? (
        <PendingScreen title="Accounts" />
      ) : path === "/reports" ? (
        <ReportsScreen />
      ) : null}
    </div>
  );
}
