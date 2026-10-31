// external-modules/finance/src/web/screens/start.tsx
// Getting started (#3178): three steps (connect, sort, build a budget), each with
// its state. With no bank keys set, step 1 offers admins "Add bank keys" and tells
// everyone else they are waiting on their admin. Matches mockups 04-start and
// 04-start-no-keys.
import {
  Button,
  Indicator,
  Masthead,
  RowIndex,
  RowIndexItem,
  SectionHead,
  useEffect,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { fetchIsAdmin } from "../api";
import { LoadingState, outcomeGate } from "../states";
import { FirstBudget } from "./first-budget";
import { useToolQuery } from "../store";
import type { HostActions } from "../root";

export const SETTINGS_HREF = "/m/finance/settings";

export interface StartViewProps {
  keysConfigured: boolean;
  hasBank: boolean;
  isAdmin: boolean;
  hostActions: HostActions;
}

function connectStep(props: StartViewProps): ReactNodeLike {
  if (props.hasBank) return <Indicator status="ready" label="Connected" />;
  if (!props.keysConfigured) {
    return props.isAdmin ? (
      <a className="jds-btn" href={SETTINGS_HREF}>
        Add bank keys
      </a>
    ) : (
      <Indicator status="idle" label="Waiting on your admin" />
    );
  }
  return (
    <Button
      onClick={() => props.hostActions.openAssistant({ starterPrompt: "Connect my bank account" })}
    >
      Connect a bank
    </Button>
  );
}

export function StartView(props: StartViewProps): ReactNodeLike {
  return (
    <div className="fnm-stack">
      <Masthead
        tone="field"
        eyebrow="Finance"
        title="Run your money with Moss"
        lede="Start with a manual account or connect a bank, review your spending, and build your budget with Moss."
      />
      <section className="fnm-stack" aria-label="Start without a bank connection">
        <SectionHead title="Start without a bank connection" rule />
        <p>
          Keep a private manual account, add transactions or import a CSV, and reconcile your
          statements. No bank keys are needed.
        </p>
        <div>
          <a className="jds-btn jds-btn--primary" href="/m/finance/accounts">
            Add a manual account
          </a>
        </div>
      </section>
      <section className="fnm-stack">
        <SectionHead title="Connect a bank when you are ready" rule />
        <RowIndex density="compact">
          <RowIndexItem title="1. Connect a bank" meta={connectStep(props)} />
          <RowIndexItem
            title="2. Moss sorts your spending"
            meta={<Indicator status="idle" label="Next" />}
          />
          <RowIndexItem
            title="3. Build your budget together"
            meta={<Indicator status="idle" label="Then" />}
          />
        </RowIndex>
      </section>
    </div>
  );
}

export function StartScreen(props: {
  hostActions: HostActions;
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const status = useToolQuery<{
    keysConfigured?: boolean;
    hasBank?: boolean;
    hasManualAccount?: boolean;
  }>("finance.setup.status");
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void fetchIsAdmin().then((admin) => {
      if (live) setIsAdmin(admin);
    });
    return () => {
      live = false;
    };
  }, []);
  if (isAdmin === null) return <LoadingState label="Loading" />;
  return outcomeGate(
    status,
    (result) => {
      const view = (
        <StartView
          keysConfigured={result.keysConfigured !== false}
          hasBank={result.hasBank === true}
          isAdmin={isAdmin}
          hostActions={props.hostActions}
        />
      );
      // Manual history and connected-bank history can both build a first budget.
      return result.hasBank === true || result.hasManualAccount === true ? (
        <FirstBudget tools={props.tools} hostActions={props.hostActions} fallback={view} />
      ) : (
        view
      );
    },
    { loadingLabel: "Loading" }
  );
}
