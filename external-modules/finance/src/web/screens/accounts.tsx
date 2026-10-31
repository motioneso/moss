// external-modules/finance/src/web/screens/accounts.tsx
// #3177: the Accounts screen. One read (finance.accounts.list) gives accounts
// and banks; accounts-view.ts groups them by kind, assets before debts. Own
// accounts only: household balances are context, not the user's net worth.
//
// Reconnect and Connect a bank use the assistant's connection flow. Manual
// ledger forms use the optional host-mediated page tools handle. A row's name
// opens Transactions filtered to that account.
import { ManualTransferDialog } from "../manual-transfer";
import { ManualAccountManager } from "../account-management";
import {
  Button,
  Indicator,
  DisclosureToggle,
  Masthead,
  MastheadFigures,
  Menu,
  RowIndex,
  RowIndexItem,
  SectionHead,
  useState,
  type ExternalModuleToolsHandleV1,
  type ReactNodeLike
} from "@moss/module-web-sdk";
import { formatCents } from "../format";
import { MoreIcon } from "../icons";
import {
  buildAccountsView,
  type AccountGroup,
  type AccountsBank,
  type AccountsRow,
  type CurrencyTotal
} from "../accounts-view";
import { navigate } from "../router";
import { EmptyState, outcomeGate } from "../states";
import { ManualEntryDialog, type ManualAccountChoice } from "../manual-entry";
import { ImportDialog } from "../import-dialog";
import { ReconciliationDialog } from "../reconciliation-dialog";
import { announce } from "../states";
import { invalidateQueries, useToolQuery } from "../store";
// Structural copy of root.tsx HostActions; importing root would pull every screen into this graph.
type HostActions = { openAssistant: (input: { starterPrompt: string }) => void };

interface AccountsResult extends Record<string, unknown> {
  accounts?: Array<AccountsRow & { shared?: boolean }>;
  banks?: AccountsBank[];
  supportsManualManagement?: boolean;
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

const totalsLabel = (totals: CurrencyTotal[]): string =>
  totals
    .map(({ currency, cents }) => (cents === null ? "Unavailable" : formatCents(cents, currency)))
    .join(" · ");

const amountOrUnavailable = (cents: number | null, currency: string): string =>
  cents === null ? "Unavailable" : formatCents(cents, currency);

type RowAction = "entry" | "reconcile" | "import" | "manage";

function AccountActions(props: {
  name: string;
  manageable: boolean;
  onSelect: (action: RowAction) => void;
}): ReactNodeLike {
  const { name } = props;
  return (
    <Menu
      triggerVariant="icon"
      triggerIcon={<MoreIcon />}
      triggerLabel={`Actions for ${name}`}
      items={[
        { id: "entry", label: "Add transaction", ariaLabel: `Add transaction to ${name}` },
        { id: "reconcile", label: "Reconcile", ariaLabel: `Reconcile ${name}` },
        { id: "import", label: "Import CSV", ariaLabel: `Import CSV into ${name}` },
        ...(props.manageable
          ? [{ id: "manage", label: "Manage", ariaLabel: `Manage ${name}` }]
          : [])
      ]}
      onSelect={(id: string) => props.onSelect(id as RowAction)}
    />
  );
}

function AccountGroupTable(props: {
  group: AccountGroup;
  multiCurrency: boolean;
  manageable: boolean;
  onAction: (accountId: string, action: RowAction) => void;
}): ReactNodeLike {
  const { group } = props;
  const titleId = `fnm-accounts-${group.kind}`;
  return (
    <section aria-labelledby={titleId} className="fnm-block fnm-block--tight">
      <SectionHead
        title={group.title}
        titleId={titleId}
        meta={<span className="fnm-amount">{totalsLabel(group.totals)}</span>}
        rule
      />
      <table className="jds-table fnm-fixed" aria-labelledby={titleId}>
        <colgroup>
          <col />
          <col className="fnm-col-amount" />
          <col className="fnm-col-check" />
        </colgroup>
        <tbody>
          {group.rows.map((row) => (
            <tr key={row.accountId}>
              <td>
                <button
                  type="button"
                  className="jds-table__rowlink"
                  aria-label={`View transactions for ${row.name}`}
                  onClick={() =>
                    navigate(`/transactions?accountId=${encodeURIComponent(row.accountId)}`)
                  }
                >
                  {row.name}
                </button>
                {row.mask ? <span className="jds-hint">{` · xxx${row.mask}`}</span> : null}
                <div className="jds-table__sub">{row.source}</div>
              </td>
              <td className="jds-table__num">
                {formatCents(row.balanceCents, row.isoCurrency)}
                {props.multiCurrency ? (
                  <div className="jds-table__sub">{row.isoCurrency}</div>
                ) : null}
              </td>
              <td>
                {row.manual ? (
                  <AccountActions
                    name={row.name}
                    manageable={props.manageable}
                    onSelect={(action) => props.onAction(row.accountId, action)}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AccountsBody(props: {
  result: AccountsResult;
  hostActions: HostActions;
  onTransfer: () => void;
  onAddAccount: () => void;
  onAddEntry: (account: ManualAccountChoice) => void;
  onReconcile: (account: ManualAccountChoice) => void;
  onImport: (account: ManualAccountChoice) => void;
  onManage: (accountId: string) => void;
}): ReactNodeLike {
  const [showClosed, setShowClosed] = useState(false);
  const own = (props.result.accounts ?? []).filter((account) => !account.shared);
  const closed = own.filter((a) => a.source === "manual" && a.archivedAt);
  const active = own.filter((a) => !closed.includes(a));
  const addBank = (): void =>
    props.hostActions.openAssistant({ starterPrompt: "Connect my bank account" });
  if (own.length === 0) {
    return (
      <EmptyState
        title="Give your accounts a home"
        body="Add a manual account or connect a bank."
        action={
          <div className="fnm-chips">
            <Button variant="primary" size="sm" onClick={props.onAddAccount}>
              Add manual account
            </Button>
            <Button variant="secondary" size="sm" onClick={addBank}>
              Connect a bank
            </Button>
          </div>
        }
      />
    );
  }
  const view = buildAccountsView(active, props.result.banks ?? [], new Date());
  const multiCurrency = view.netWorthByCurrency.length > 1;
  const reconnect = (): void =>
    props.hostActions.openAssistant({ starterPrompt: "Reconnect my bank account" });
  const onAction = (accountId: string, action: RowAction): void => {
    if (action === "manage") return props.onManage(accountId);
    const account = own.find((row) => row.accountId === accountId);
    if (!account) return;
    if (action === "entry") props.onAddEntry(account);
    else if (action === "reconcile") props.onReconcile(account);
    else props.onImport(account);
  };
  return (
    <div className="fnm-stack">
      <div className="fnm-account-actions">
        <Button variant="secondary" onClick={props.onTransfer}>
          Record transfer
        </Button>
        <Menu
          triggerVariant="button"
          triggerContent="Add account"
          triggerLabel="Add account"
          items={[
            { id: "manual", label: "Manual account", ariaLabel: "Add manual account" },
            { id: "bank", label: "Connect a bank" }
          ]}
          onSelect={(id: string) => (id === "bank" ? addBank() : props.onAddAccount())}
        />
      </div>

      <div className="fnm-account-totals" aria-label="Account totals by currency">
        {view.netWorthByCurrency.map(({ currency, netWorthCents }) => {
          const sides = view.sidesByCurrency.find((side) => side.currency === currency);
          return (
            <Masthead
              key={currency}
              tone="field"
              eyebrow={multiCurrency ? `Net worth · ${currency}` : "Net worth"}
              title={amountOrUnavailable(netWorthCents, currency)}
              aside={
                sides ? (
                  <MastheadFigures
                    label={multiCurrency ? `Assets and debts, ${currency}` : "Assets and debts"}
                    items={[
                      { label: "Assets", value: amountOrUnavailable(sides.assetsCents, currency) },
                      { label: "Debts", value: amountOrUnavailable(sides.debtsCents, currency) }
                    ]}
                  />
                ) : undefined
              }
            />
          );
        })}
      </div>

      {view.netWorthByCurrency.some((total) => total.netWorthCents === null) ? (
        <p className="jds-hint" role="status">
          A combined balance exceeds supported precision. Its total is unavailable; individual
          account balances remain below.
        </p>
      ) : null}

      {view.banks
        .filter((bank) => bank.status === "error")
        .map((bank) => (
          <div key={bank.itemId} className="fnm-block fnm-block--tiny">
            <BankStatus
              status="error"
              label={`${bank.name} · ${bank.statusLabel}`}
              reconnect={bank.reconnect}
              onReconnect={reconnect}
            />
            {bank.message ? <p className="jds-hint">{bank.message}</p> : null}
          </div>
        ))}

      {view.groups.map((group) => (
        <AccountGroupTable
          key={group.kind}
          group={group}
          multiCurrency={multiCurrency}
          manageable={props.result.supportsManualManagement === true}
          onAction={onAction}
        />
      ))}

      {closed.length ? (
        <section aria-label="Closed manual accounts" className="fnm-block fnm-block--tight">
          <DisclosureToggle expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
            Closed accounts ({closed.length})
          </DisclosureToggle>
          {showClosed ? (
            <RowIndex density="compact">
              {closed.map((a) => (
                <RowIndexItem
                  key={a.accountId}
                  title={a.name}
                  meta={
                    <Button
                      variant="link"
                      aria-label={`Manage ${a.name}`}
                      onClick={() => props.onManage(a.accountId)}
                    >
                      Manage
                    </Button>
                  }
                />
              ))}
            </RowIndex>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function AccountsScreen(props: {
  hostActions: HostActions;
  tools?: ExternalModuleToolsHandleV1;
}): ReactNodeLike {
  const [editing, setEditing] = useState<ManualAccountChoice | null | undefined>(undefined);
  const [transferring, setTransferring] = useState(false);
  const [managed, setManaged] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState<ManualAccountChoice | null>(null);
  const [importing, setImporting] = useState<ManualAccountChoice | null>(null);
  const accounts = useToolQuery<AccountsResult>("finance.accounts.list");
  return (
    <section aria-label="Accounts" className="fnm-stack">
      {transferring ? (
        <ManualTransferDialog
          tools={props.tools}
          onClose={() => setTransferring(false)}
          onSaved={() => {
            setTransferring(false);
            invalidateQueries();
          }}
        />
      ) : null}

      {outcomeGate(
        accounts,
        (result) => (
          <AccountsBody
            result={result}
            hostActions={props.hostActions}
            onTransfer={() => setTransferring(true)}
            onAddAccount={() => setEditing(null)}
            onAddEntry={setEditing}
            onReconcile={setReconciling}
            onImport={setImporting}
            onManage={setManaged}
          />
        ),
        { loadingLabel: "Loading accounts" }
      )}
      {managed ? (
        <ManualAccountManager
          key={managed}
          accountId={managed}
          tools={props.tools}
          onClose={() => setManaged(null)}
          onSaved={() => {
            setManaged(null);
            invalidateQueries();
          }}
          onReconcile={(account) => {
            setManaged(null);
            setReconciling(account);
          }}
        />
      ) : null}
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
      {importing ? (
        <ImportDialog
          account={importing}
          tools={props.tools}
          onClose={() => setImporting(null)}
          onSaved={() => {
            setImporting(null);
            invalidateQueries();
            announce("Transactions imported.");
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
