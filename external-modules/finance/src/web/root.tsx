// external-modules/finance/src/web/root.tsx
// Module Root: chrome (eyebrow + heading), one polite live region for the whole
// surface, and the in-module router; jds-* primitives + layout-only fnm-* styles.
import {
  Segmented,
  useEffect,
  useSyncExternalStore,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { ModuleLink, navigate, useModulePath } from "./router";
import { AccountsScreen } from "./screens/accounts";
import { BudgetScreen } from "./screens/budget";
import { ReportsScreen } from "./screens/reports";
import { SettingsScreen } from "./screens/settings";
import { StartScreen } from "./screens/start";
import { TransactionsScreen } from "./screens/transactions";
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
        <ModuleLink to="/settings" variant="quiet" size="sm">
          Settings
        </ModuleLink>
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
        <TransactionsScreen />
      ) : path === "/accounts" ? (
        <AccountsScreen hostActions={props.hostActions} />
      ) : path === "/reports" ? (
        <ReportsScreen />
      ) : path === "/settings" ? (
        <SettingsScreen />
      ) : null}
    </div>
  );
}
