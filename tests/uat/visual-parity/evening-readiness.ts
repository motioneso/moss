export interface EveningRenderedContract {
  readonly heading: string;
  readonly body: string;
}

const compact = (value: string): string => value.replace(/\s+/g, " ").trim();

const CANONICAL_MODULE = ["..", "..", "..", "apps", "web", "src", "today", "today-hero.js"].join(
  "/"
);
type SplitHeadline = (text: string) => { readonly headline: string; readonly rest: string };
let canonicalSplitHeadline: Promise<SplitHeadline> | undefined;

async function splitHeadline(text: string): Promise<ReturnType<SplitHeadline>> {
  canonicalSplitHeadline ??= import(CANONICAL_MODULE).then(
    (module) => (module as { readonly splitHeadline: SplitHeadline }).splitHeadline
  );
  return (await canonicalSplitHeadline)(text);
}

/** Validate the rendered contract used by TodayHero: h1 owns the first sentence and
 * the recap body owns only the remaining prose (or the full text when there is no split). */
export async function assertEveningRenderedContract(
  summaryText: string,
  rendered: EveningRenderedContract
): Promise<{ readonly headline: string; readonly body: string }> {
  const split = await splitHeadline(summaryText);
  const expectedBody = split.rest || split.headline;
  if (compact(rendered.heading) !== compact(split.headline))
    throw new Error(`parity evening: heading does not match split headline: ${rendered.heading}`);
  if (compact(rendered.body) !== compact(expectedBody))
    throw new Error(`parity evening: body does not match split prose: ${rendered.body}`);
  return { headline: split.headline, body: expectedBody };
}
