// tests/uat/model-tier.ts
//
// #2732: Ben's ruling is that every UAT run against a real model uses the account's cheapest
// tier ("economy" in packages/ai/src/model-discovery.ts) to preserve usage. This file is the one
// place that decides which discovered model counts as "cheapest and usable" — a plain function,
// not a spec, so both real-chat specs and its own unit test can import it without registering
// stray Playwright tests (a spec file's top-level test() calls run just by being imported).

/** The subset of GET /api/ai/models's per-model fields this picker needs. */
export interface UatDiscoveredModel {
  readonly id: string;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly tier: string;
}

/**
 * The one model a real-chat UAT run should bind: active, chat-capable, and in the cheapest
 * ("economy") tier. Throws with a clear, specific message when no such model exists — never
 * silently widens to a pricier tier, per Ben's ruling.
 */
export function pickCheapestActiveChatModel(
  models: readonly UatDiscoveredModel[]
): UatDiscoveredModel {
  const eligible = models.filter(
    (model) =>
      model.status === "active" && model.capabilities.includes("chat") && model.tier === "economy"
  );
  if (eligible.length === 0) {
    throw new Error(
      "[uat real-chat] no active, chat-capable, economy-tier model was discovered; refusing to " +
        `fall back to a pricier tier (found ${models.length} model(s) total: ` +
        `${JSON.stringify(models.map((model) => ({ id: model.id, status: model.status, tier: model.tier })))})`
    );
  }
  // Discovery order is stable but not meaningful for cost; the first economy-tier match is as
  // good as any other economy-tier match.
  return eligible[0]!;
}
