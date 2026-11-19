// Pure helpers for the Reports screen. Amounts are whole cents.
const add = (into, from) => {
  for (const [k, v] of Object.entries(from ?? {})) into[k] = (into[k] ?? 0) + v;
};

/** Sums the person's months with every shared owner's months, month by month. */
export function mergeSpending(window, own, shared) {
  return window.map((month) => {
    const out = {
      month,
      byCategory: {},
      byPayee: {},
      cashFlow: { incomeCents: 0, outflowCents: 0, netCents: 0 }
    };
    for (const list of [own, ...shared.map((s) => s.months)]) {
      const m = (list ?? []).find((x) => x.month === month);
      if (!m) continue;
      add(out.byCategory, m.byCategory);
      add(out.byPayee, m.byPayee);
      out.cashFlow.incomeCents += m.cashFlow.incomeCents;
      out.cashFlow.outflowCents += m.cashFlow.outflowCents;
      out.cashFlow.netCents += m.cashFlow.netCents;
    }
    return out;
  });
}

/** The last full month, or the only month when the window has one. */
export const defaultBarMonth = (window) =>
  window.length > 1 ? window[window.length - 2] : (window[0] ?? "");

export const ranked = (map, limit = Infinity) =>
  Object.entries(map)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);

export const hasActivity = (months) =>
  months.some((m) => m.cashFlow.incomeCents !== 0 || m.cashFlow.outflowCents !== 0);

/** Points for a line scaled into a width by height box. */
export function trendPath(points, width, height, pad = 6) {
  if (points.length === 0) return "";
  const values = points.map((p) => p.totalCents);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i) =>
    points.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (points.length - 1);
  const y = (v) => height - pad - ((v - lo) * (height - 2 * pad)) / span;
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.totalCents).toFixed(1)}`)
    .join(" ");
}
