import type { CompletedResult } from "@moss/shared";

type Side = Pick<CompletedResult["home"], "name" | "score">;

/** Bounded content checks; exact score alignment is asserted on the sourced card. */
export function hasUsefulSportsAnswer(
  reply: unknown,
  result: { readonly home: Side; readonly away: Side }
): boolean {
  if (typeof reply !== "string" || !reply.trim()) return false;
  if (/root =|cannot answer|unable to|couldn't (?:find|retrieve)/i.test(reply)) return false;
  const lower = reply.toLocaleLowerCase();
  if (![result.home, result.away].every((side) => lower.includes(side.name.toLocaleLowerCase())))
    return false;
  const { home, away } = result;
  if (home.score === null || away.score === null)
    return /unknown|unavailable|not (?:known|available)/i.test(reply);
  const normalized = reply.replace(/[−–—]/g, "-");
  return new RegExp(
    `\\b(?:${home.score}\\s*-\\s*${away.score}|${away.score}\\s*-\\s*${home.score})\\b`
  ).test(normalized);
}
