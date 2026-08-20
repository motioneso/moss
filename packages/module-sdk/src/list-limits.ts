/**
 * The shape every module's list tool should return.
 *
 * #1723 item 3: Food's `food.meals.list` returned whatever the range held. That is fine for one
 * day and wrong as a pattern, because a tool result lands in a model context — an ordinary "how did
 * I eat last month" question could quietly cost hundreds of rows. The cap itself is easy; the parts
 * that are easy to get wrong, and so live here rather than in each module, are which end gets
 * dropped and whether the caller can tell that anything was.
 *
 * Validating the caller's `limit` deliberately stays with each module. Modules already own their
 * own input validators and their own error type that maps to a 400, and the SDK has no business
 * choosing one for them.
 *
 * Intl-free and `node:*`-free, so the barrel stays browser-safe.
 */

/**
 * The default and the ceiling in one number.
 *
 * One rather than two, because a caller asking for more than the ceiling has misunderstood the tool
 * rather than made a small mistake — and clamping silently would let it believe it had the whole
 * set. Modules validate `limit` against this and refuse anything above it.
 */
export const DEFAULT_LIST_LIMIT = 200;

/** A list tool's result: the page, plus enough to know what the page is a page of. */
export interface LimitedList<T> {
  readonly items: readonly T[];
  /**
   * True when `limit` cut the list short. Not optional: a caller that cannot tell the difference
   * between "these are all the records" and "these are the last 200" will draw wrong conclusions
   * from either, and this flag is the only thing that makes a truncated answer safe to reason about.
   */
  readonly truncated: boolean;
  /** How many records matched before the limit was applied. */
  readonly totalCount: number;
}

/**
 * Keeps the **most recent** `limit` items from a list already in ascending time order.
 *
 * Taking them off the front instead would answer a month-long range with only its oldest days,
 * which is the opposite of what someone asking about their own records wants — the recent end is
 * the part that is still actionable. Order within the returned page is unchanged.
 */
export function applyListLimit<T>(items: readonly T[], limit: number): LimitedList<T> {
  if (items.length <= limit) {
    return { items, truncated: false, totalCount: items.length };
  }
  return { items: items.slice(items.length - limit), truncated: true, totalCount: items.length };
}
