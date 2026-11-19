/* global HTMLSelectElement */
// Loads Reports and runs its actions. A newer request always replaces an older one still in flight.
export function createReports({ api, render, goTab }) {
  const s = {
    months: 6,
    currency: "",
    barMonth: "",
    spend: null,
    net: null,
    spendError: false,
    netError: false,
    open: { sources: false, history: false, monthly: false, category: false, payee: false },
    historyPage: 0,
    detail: null
  };
  let seq = 0;

  async function load() {
    const mine = ++seq;
    s.spendError = false;
    s.netError = false;
    s.spend = null;
    s.net = null;
    s.historyPage = 0;
    render();
    const q = new URLSearchParams({ months: String(s.months) });
    if (s.currency) q.set("currency", s.currency);
    const [spend, net] = await Promise.allSettled([
      api.call("GET", `/finance/reports/spending?${q}`),
      api.call("GET", `/finance/reports/net-worth?${q}`)
    ]);
    if (mine !== seq) return;
    if (spend.status === "fulfilled") s.spend = spend.value;
    else s.spendError = true;
    if (net.status === "fulfilled") s.net = net.value;
    else s.netError = true;
    if (s.spend?.currency && !s.currency) s.currency = s.spend.currency;
    render();
  }

  async function loadDetail() {
    const d = s.detail;
    const mine = ++seq;
    d.data = null;
    d.error = false;
    render();
    const q = new URLSearchParams({ month: d.month, currency: s.spend?.currency ?? s.currency, group: d.group, offset: String(d.offset), months: String(s.months) });
    if (d.key) q.set("key", d.key);
    try {
      const data = await api.call("GET", `/finance/reports/transactions?${q}`);
      if (mine === seq) d.data = data;
    } catch {
      if (mine === seq) d.error = true;
    }
    render();
  }

  function click(act, el) {
    switch (act) {
      case "rpt-reload": return void load(), true;
      case "rpt-toggle": s.open[el.dataset.id] = !s.open[el.dataset.id]; render(); return true;
      case "rpt-more": s.open[el.dataset.id] = !s.open[el.dataset.id]; render(); return true;
      case "rpt-hist-newer": s.historyPage -= 1; render(); return true;
      case "rpt-hist-older": s.historyPage += 1; render(); return true;
      case "rpt-add-account": goTab("accounts", "add=account"); return true;
      case "rpt-detail": {
        const { group, key, month } = el.dataset;
        const title = group === "income" ? "Income" : group === "outflow" ? "Outflow" : key;
        s.detail = { group, key, month, offset: 0, data: null, error: false, title: `Report transactions · ${title}` };
        void loadDetail();
        return true;
      }
      case "rpt-detail-reload": void loadDetail(); return true;
      case "rpt-page-next": s.detail.offset += 50; void loadDetail(); return true;
      case "rpt-page-prev": s.detail.offset = Math.max(0, s.detail.offset - 50); void loadDetail(); return true;
      case "dialog-close": s.detail = null; render(); return true;
      default: return false;
    }
  }

  function change(el) {
    if (!(el instanceof HTMLSelectElement) || !el.dataset.rpt) return false;
    if (el.dataset.rpt === "months") {
      s.months = Number(el.value);
      void load();
    } else if (el.dataset.rpt === "currency") {
      s.currency = el.value;
      void load();
    } else {
      s.barMonth = el.value;
      render();
    }
    return true;
  }

  return { state: s, load, click, change, hasDialog: () => Boolean(s.detail), closeDialog: () => ((s.detail = null), render()) };
}
