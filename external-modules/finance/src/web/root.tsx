import { UpcomingScreen } from "./screens/upcoming";
// external-modules/finance/src/web/root.tsx
// Module Root: chrome (eyebrow + heading), one polite live region for the whole
// surface, and the in-module router; jds-* primitives + layout-only fnm-* styles.
import {
  Segmented,
  useEffect,
  useMemo,
  useRef,
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
import { serialTools } from "./serial-tools";
import { invalidateQueries } from "./store";
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
  refreshKey?: number;
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const path = useModulePath();
  const tools = useMemo(() => (props.tools ? serialTools(props.tools) : undefined), [props.tools]);
  const lastRefresh = useRef(props.refreshKey);
  useEffect(() => {
    const previous = lastRefresh.current;
    lastRefresh.current = props.refreshKey;
    if (previous !== undefined && props.refreshKey !== undefined && previous !== props.refreshKey)
      invalidateQueries();
  }, [props.refreshKey]);
  // The old Feed and Budget paths now live at Transactions and the Budget home.
  useEffect(() => {
    if (path === "/budget") navigate("/");
  }, [path]);
  // On a phone the tab bar scrolls sideways; keep the open tab in view. The module stylesheet
  // and fonts can land after the first paint, so this reruns whenever the tabs change size.
  const tabs = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const bar = tabs.current;
    if (!bar) return;
    const reveal = () => {
      const active = bar.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!active) return;
      const barBox = bar.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      if (box.right > barBox.right) bar.scrollLeft += box.right - barBox.right;
      else if (box.left < barBox.left) bar.scrollLeft -= barBox.left - box.left;
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(bar);
    if (bar.firstElementChild) observer.observe(bar.firstElementChild);
    return () => observer.disconnect();
  }, [path]);
  return (
    <div className="fnm-root">
      <LiveRegion />
      <div className="fnm-tabs" ref={tabs}>
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
        <StartScreen tools={tools} hostActions={props.hostActions} />
      ) : path === "/" ? (
        <BudgetScreen tools={tools} />
      ) : path === "/transactions" ? (
        <TransactionsScreen tools={tools} />
      ) : path === "/accounts" ? (
        <AccountsScreen hostActions={props.hostActions} tools={tools} />
      ) : path === "/reports" ? (
        <ReportsScreen />
      ) : path === "/upcoming" ? (
        <UpcomingScreen tools={tools} />
      ) : path === "/settings" ? (
        <SettingsScreen tools={tools} />
      ) : null}
    </div>
  );
}
