import { UpcomingScreen } from "./screens/upcoming";
// external-modules/finance/src/web/root.tsx
// Module Root: chrome (eyebrow + heading), one polite live region for the whole
// surface, and the in-module router; jds-* primitives + layout-only fnm-* styles.
import {
  Segmented,
  useEffect,
  useSyncExternalStore,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { navigate, useModulePath } from "./router";
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

// Getting started and Settings retain a way back to the four primary views.
type Tab = "budget" | "transactions" | "accounts" | "reports" | "upcoming";
const TAB_PATHS: Record<Tab, string> = {
  budget: "/",
  transactions: "/transactions",
  accounts: "/accounts",
  upcoming: "/upcoming",
  reports: "/reports"
};

function tabFor(path: string): Tab | "none" {
  if (path === "/") return "budget";
  if (path === "/transactions") return "transactions";
  if (path === "/accounts") return "accounts";
  if (path === "/upcoming") return "upcoming";
  if (path === "/reports") return "reports";
  return "none";
}

export function Root(props: {
  hostActions: HostActions;
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const path = useModulePath();
  // The old Feed and Budget paths now live at Transactions and the Budget home.
  useEffect(() => {
    if (path === "/budget") navigate("/");
  }, [path]);
  return (
    <div className="fnm-root">
      <LiveRegion />
      <div className="fnm-tabs">
        <Segmented
          ariaLabel="Finance views"
          value={tabFor(path) as Tab}
          onChange={(tab: Tab) => navigate(TAB_PATHS[tab])}
          options={[
            { value: "budget", label: "Budget" },
            { value: "transactions", label: "Transactions" },
            { value: "accounts", label: "Accounts" },
            { value: "reports", label: "Reports" },
            { value: "upcoming", label: "Upcoming" }
          ]}
        />
      </div>
      {path === "/start" ? (
        <StartScreen tools={props.tools} hostActions={props.hostActions} />
      ) : path === "/" ? (
        <BudgetScreen tools={props.tools} />
      ) : path === "/transactions" ? (
        <TransactionsScreen tools={props.tools} />
      ) : path === "/accounts" ? (
        <AccountsScreen hostActions={props.hostActions} tools={props.tools} />
      ) : path === "/reports" ? (
        <ReportsScreen />
      ) : path === "/upcoming" ? (
        <UpcomingScreen tools={props.tools} />
      ) : path === "/settings" ? (
        <SettingsScreen />
      ) : null}
    </div>
  );
}
