// Groups accounts into the sections the Accounts screen shows. Debts are negative.
const KINDS = [
  ["cash", "Cash"],
  ["investment", "Investments"],
  ["credit", "Credit cards"],
  ["loan", "Loans"],
  ["other", "Other"]
];

export const isDebt = (type) => type === "credit" || type === "loan";

export function accountKind(type, subtype) {
  if (type === "depository" || (type === "other" && subtype === "cash")) return "cash";
  return ["investment", "credit", "loan"].includes(type) ? type : "other";
}

const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function syncedAgo(lastSyncAt, now) {
  if (!lastSyncAt) return "Not synced yet";
  const elapsed = now.getTime() - new Date(lastSyncAt).getTime();
  if (Number.isNaN(elapsed)) return "Not synced yet";
  if (elapsed < 60_000) return "Synced just now";
  if (elapsed < 3_600_000) return `Synced ${plural(Math.floor(elapsed / 60_000), "minute")} ago`;
  if (elapsed < 86_400_000) return `Synced ${plural(Math.floor(elapsed / 3_600_000), "hour")} ago`;
  return `Synced ${plural(Math.floor(elapsed / 86_400_000), "day")} ago`;
}

function asOfDate(lastSyncAt) {
  const parsed = lastSyncAt ? new Date(lastSyncAt) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

const add = (map, key, cents) => map.set(key, (map.get(key) ?? 0) + cents);
const totals = (map) =>
  [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, cents: Number.isSafeInteger(cents) ? cents : null }));

export function buildAccountsView(accounts, banks, now) {
  const byItem = new Map();
  for (const a of accounts) {
    const key = a.source === "manual" ? "manual-account-group" : (a.itemId ?? "missing-item");
    byItem.set(key, [...(byItem.get(key) ?? []), a]);
  }
  const bankFor = new Map(banks.map((b) => [b.itemId, b]));
  const ids = [
    ...banks.map((b) => b.itemId),
    ...[...byItem.keys()].filter((id) => !bankFor.has(id))
  ].filter((id) => byItem.has(id));
  const net = new Map();
  const assets = new Map();
  const debts = new Map();
  const sections = ids.map((itemId, index) => {
    const bank = bankFor.get(itemId);
    const accountsHere = byItem.get(itemId).map((a) => {
      const balanceCents = (isDebt(a.type) ? -1 : 1) * a.balanceCents;
      add(net, a.isoCurrency, balanceCents);
      add(balanceCents < 0 ? debts : assets, a.isoCurrency, Math.abs(balanceCents));
      return {
        accountId: a.accountId,
        name: a.name,
        mask: a.mask,
        balanceCents,
        isoCurrency: a.isoCurrency,
        type: a.type,
        subtype: a.subtype
      };
    });
    if (itemId === "manual-account-group")
      return {
        itemId,
        name: "Manual accounts",
        status: "ready",
        statusLabel: "Recorded in Moss",
        asOf: null,
        message: null,
        reconnect: false,
        accounts: accountsHere
      };
    const status = bank?.status ?? "error";
    const known = bank?.institutionName?.trim();
    const name = known ? known : ids.length === 1 ? "Connected bank" : `Bank ${index + 1}`;
    if (status === "connected")
      return {
        itemId,
        name,
        status: "ready",
        statusLabel: syncedAgo(bank?.lastSyncAt ?? null, now),
        asOf: null,
        message: null,
        reconnect: false,
        accounts: accountsHere
      };
    return {
      itemId,
      name,
      status: "error",
      statusLabel: status === "reauth-required" ? "Sign-in expired" : "Connection problem",
      asOf: asOfDate(bank?.lastSyncAt ?? null),
      message: bank?.message ?? null,
      reconnect: status === "reauth-required",
      accounts: accountsHere
    };
  });
  const groups = KINDS.map(([kind, title]) => {
    const sum = new Map();
    const rows = [];
    for (const section of sections) {
      const manual = section.itemId === "manual-account-group";
      const state = section.asOf ? `As of ${section.asOf}` : section.statusLabel;
      for (const line of section.accounts) {
        if (accountKind(line.type, line.subtype) !== kind) continue;
        add(sum, line.isoCurrency, line.balanceCents);
        rows.push({ ...line, manual, source: manual ? "Manual" : `${section.name} · ${state}` });
      }
    }
    return { kind, title, totals: totals(sum), rows };
  }).filter((g) => g.rows.length > 0);
  return {
    banks: sections,
    groups,
    net: totals(net).map(({ currency, cents }) => ({
      currency,
      cents,
      assets: totals(assets).find((t) => t.currency === currency)?.cents ?? 0,
      debts: totals(debts).find((t) => t.currency === currency)?.cents ?? 0
    }))
  };
}
