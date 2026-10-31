import { safeCents } from "./values.js";
/** Exact integer hundredths, independent of display locale and floating point division. */
export function centsToAmountInput(cents: number): string {
  const value = BigInt(safeCents(cents));
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
