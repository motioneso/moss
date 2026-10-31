import { FLEX_POOL, flexForMonth, type FlexPolicy } from "../../domain/flex.js";
import type { FinanceStore } from "../../domain/store-port.js";
import { InputError } from "../validate.js";
export async function assertCategoryFunding(
  store: FinanceStore,
  month: string,
  ids: readonly string[]
) {
  const flex = flexForMonth((await store.flex?.policies()) ?? [], month);
  if (flex?.active && ids.some((id) => flex.flexIds.includes(id)))
    throw new InputError(
      "flex_member",
      "Change the flexible pool total instead of funding a pooled category"
    );
}
export async function assertEnvelopeDraft(store: FinanceStore, month: string) {
  if (flexForMonth((await store.flex?.policies()) ?? [], month)?.active)
    throw new InputError(
      "flex_active",
      "Use Budget to fund the active flexible pool instead of starting a category draft"
    );
}
export function storedFlexTotal(
  id: string,
  total: number,
  ledger: Record<string, number>,
  flex: FlexPolicy | null
) {
  if (id !== FLEX_POOL || !flex?.active) return total;
  const base = flex.flexIds.reduce((sum, key) => sum + BigInt(ledger[key] ?? 0), 0n);
  const delta = BigInt(total) - base;
  if (delta > BigInt(Number.MAX_SAFE_INTEGER) || delta < BigInt(Number.MIN_SAFE_INTEGER))
    throw new InputError("Amount exceeds supported precision");
  return Number(delta);
}
