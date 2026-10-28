// external-modules/finance/src/web/screens/accounts.tsx
// #3177: the Accounts screen. One read (finance.accounts.list) gives accounts
// and banks; accounts-view.ts turns them into sections. Own accounts only:
// household balances are context, not the user's net worth.
//
// Reconnect and Add a bank retain the assistant's connection flow. Manual
// ledger forms use the optional host-mediated page tools handle.
import {
  Button,
  Indicator,
  Masthead,
  RowIndex,
  RowIndexItem,
  SectionHead,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { formatCents } from "../format";
import { buildAccountsView, type AccountsBank, type AccountsRow } from "../accounts-view";
import { EmptyState, outcomeGate } from "../states";
import { ManualEntryDialog, type ManualAccountChoice } from "../manual-entry";
import { ReconciliationDialog } from "../reconciliation-dialog";
import { announce } from "../states";
import { invalidateQueries, useToolQuery } from "../store";
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

function AccountsBody(props: {
  result: AccountsResult;
  hostActions: HostActions;
  onAddEntry: (account: ManualAccountChoice) => void;
  onReconcile: (account: ManualAccountChoice) => void;
}): ReactNodeLike {
  const own = (props.result.accounts ?? []).filter((account) => !account.shared);
  const addBank = (): void =>
    props.hostActions.openAssistant({ starterPrompt: "Connect my bank account" });
  if (own.length === 0) {
    return (
      <EmptyState
        title="Give your accounts a home"
        body="Add a manual account to start recording money, or connect a bank. Balances stay separate for each currency."
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
      <div className="fnm-account-totals" aria-label="Account totals by currency">
        {view.netWorthByCurrency.map(({ currency, netWorthCents }) => (
          <Masthead
            key={currency}
            tone="field"
            eyebrow={`Net worth · ${currency}`}
            title={netWorthCents === null ? "Unavailable" : formatCents(netWorthCents, currency)}
          />
        ))}
      </div>
      <p className="jds-caption">
        Current manual ledger and latest bank balances, with debts subtracted. Each currency is kept
        separate; no exchange-rate conversion is applied.
      </p>
      {view.netWorthByCurrency.some((total) => total.netWorthCents === null) ? (
        <p className="jds-hint" role="status">
          A combined balance exceeds supported precision. Its total is unavailable; individual
          account balances remain below.
        </p>
      ) : null}
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
                      <strong>{formatCents(account.balanceCents, account.isoCurrency)}</strong>
                      <span className="jds-hint">{account.isoCurrency}</span>
                      {own.find((row) => row.accountId === account.accountId)?.source ===
                      "manual" ? (
                        <div className="fnm-account-actions">
                          <Button
                            variant="link"
                            aria-label={`Add transaction to ${account.name}`}
                            onClick={() => {
                              const original = own.find(
                                (row) => row.accountId === account.accountId
                              )!;
                              props.onAddEntry(original);
                            }}
                          >
                            Add transaction
                          </Button>
                          <Button
                            variant="link"
                            aria-label={`Reconcile ${account.name}`}
                            onClick={() =>
                              props.onReconcile(
                                own.find((row) => row.accountId === account.accountId)!
                              )
                            }
                          >
                            Reconcile
                          </Button>
                        </div>
                      ) : null}
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

export function AccountsScreen(props: {
  hostActions: HostActions;
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const [editing, setEditing] = useState<ManualAccountChoice | null | undefined>(undefined);
  const [reconciling, setReconciling] = useState<ManualAccountChoice | null>(null);
  const accounts = useToolQuery<AccountsResult>("finance.accounts.list");
  return (
    <section aria-label="Accounts" className="fnm-stack">
      <SectionHead
        title="Accounts"
        meta={
          <Button variant="secondary" onClick={() => setEditing(null)}>
            Add manual account
          </Button>
        }
        rule
      />
      {outcomeGate(
        accounts,
        (result) => (
          <AccountsBody
            result={result}
            hostActions={props.hostActions}
            onAddEntry={setEditing}
            onReconcile={setReconciling}
          />
        ),
        { loadingLabel: "Loading accounts" }
      )}
      {editing !== undefined ? (
        <ManualEntryDialog
          tools={props.tools}
          account={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            invalidateQueries();
            announce(editing ? "Transaction saved." : "Manual account added.");
          }}
        />
      ) : null}
      {reconciling ? (
        <ReconciliationDialog
          account={reconciling}
          tools={props.tools}
          onClose={() => setReconciling(null)}
          onSaved={() => {
            setReconciling(null);
            invalidateQueries();
            announce("Statement reconciled.");
          }}
        />
      ) : null}
    </section>
  );
}
