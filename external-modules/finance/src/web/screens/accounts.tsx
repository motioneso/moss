// external-modules/finance/src/web/screens/accounts.tsx
// #3177: the Accounts screen. One read (finance.accounts.list) gives accounts
// and banks; accounts-view.ts turns them into sections. Own accounts only:
// household balances are context, not the user's net worth.
//
// Reconnect and Add a bank hand off to the assistant, because connecting is a
// write tool and the REST invoke route only runs reads.
import {
  Button,
  Indicator,
  Masthead,
  RowIndex,
  RowIndexItem,
  SectionHead,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { formatCents } from "../format";
import { buildAccountsView, type AccountsBank, type AccountsRow } from "../accounts-view";
import { EmptyState, outcomeGate } from "../states";
import { useToolQuery } from "../store";
// Structural copy of root.tsx HostActions; importing root would pull every screen into this graph.
type HostActions = { openAssistant: (input: { starterPrompt: string }) => void };

interface AccountsResult extends Record<string, unknown> {
  accounts?: Array<AccountsRow & { shared?: boolean }>;
  banks?: AccountsBank[];
}

function BankStatus(props: {
  status: "ready" | "error";
  label: string;
  reconnect: boolean;
  onReconnect: () => void;
}): ReactNodeLike {
  return (
    <span className="fnm-bank-status-row">
      <Indicator status={props.status} label={props.label} />
      {props.reconnect ? (
        <Button size="sm" onClick={props.onReconnect}>
          Reconnect
        </Button>
      ) : null}
    </span>
  );
}

function AccountsBody(props: { result: AccountsResult; hostActions: HostActions }): ReactNodeLike {
  const own = (props.result.accounts ?? []).filter((account) => !account.shared);
  const addBank = (): void =>
    props.hostActions.openAssistant({ starterPrompt: "Connect my bank account" });
  if (own.length === 0) {
    return (
      <EmptyState
        title="Connect a bank"
        body="Balances and net worth appear here once a bank is connected."
        action={
          <Button variant="primary" size="sm" onClick={addBank}>
            Add a bank
          </Button>
        }
      />
    );
  }
  const view = buildAccountsView(own, props.result.banks ?? [], new Date());
  const reconnect = (): void =>
    props.hostActions.openAssistant({ starterPrompt: "Reconnect my bank account" });
  return (
    <div className="fnm-stack">
      <Masthead
        tone="field"
        eyebrow="Net worth"
        title={formatCents(view.netWorthCents, view.currency)}
      />
      {view.banks.map((bank) => {
        const status = (
          <BankStatus
            status={bank.status}
            label={bank.statusLabel}
            reconnect={bank.reconnect}
            onReconnect={reconnect}
          />
        );
        return (
          <section key={bank.itemId} className="fnm-stack" aria-label={bank.name}>
            <SectionHead
              title={bank.name}
              meta={<span className="fnm-bank-meta">{status}</span>}
              rule
            />
            <div className="fnm-bank-status">{status}</div>
            {bank.message ? <p className="jds-hint">{bank.message}</p> : null}
            <RowIndex variant="facts">
              {bank.accounts.map((account) => (
                <RowIndexItem
                  key={account.accountId}
                  title={
                    <span>
                      {account.name}
                      {account.mask ? (
                        <span className="jds-hint">{` · xxx${account.mask}`}</span>
                      ) : null}
                    </span>
                  }
                  meta={
                    <div className="fnm-bal">
                      <strong>{formatCents(account.balanceCents, view.currency)}</strong>
                      {bank.asOf ? <span className="jds-hint">{`As of ${bank.asOf}`}</span> : null}
                    </div>
                  }
                />
              ))}
            </RowIndex>
          </section>
        );
      })}
      <div>
        <Button variant="secondary" onClick={addBank}>
          Add a bank
        </Button>
      </div>
    </div>
  );
}

export function AccountsScreen(props: { hostActions: HostActions }): ReactNodeLike {
  const accounts = useToolQuery<AccountsResult>("finance.accounts.list");
  return (
    <section aria-label="Accounts">
      {outcomeGate(
        accounts,
        (result) => (
          <AccountsBody result={result} hostActions={props.hostActions} />
        ),
        { loadingLabel: "Loading accounts" }
      )}
    </section>
  );
}
