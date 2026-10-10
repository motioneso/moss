// external-modules/finance/src/web/settings-api.ts
// Host routes behind the Finance Settings screen: action policy, module preferences and
// the admin-only bank key slots. Each helper returns null or false on any failure so the
// screen can revert and show an inline error.

export type Tier = "ask_each_time" | "trusted_auto";

export const TAGGED_FAMILIES = [
  "sorting",
  "moving_money",
  "sorting_new",
  "rules",
  "categories"
] as const;
export type TaggedFamily = (typeof TAGGED_FAMILIES)[number];
export type Tiers = Record<TaggedFamily, Tier>;

export type Step = "ask" | "routine" | "all";

// Mirrors the host's freedom presets: routine families, then new-thing families.
const ROUTINE: Record<Step, Tier> = {
  ask: "ask_each_time",
  routine: "trusted_auto",
  all: "trusted_auto"
};
const NEW: Record<Step, Tier> = {
  ask: "ask_each_time",
  routine: "ask_each_time",
  all: "trusted_auto"
};
const FAMILY_KIND: Record<TaggedFamily, "routine" | "new"> = {
  sorting: "routine",
  moving_money: "routine",
  sorting_new: "new",
  rules: "new",
  categories: "new"
};
export const STEP_NUMBER: Record<Step, 1 | 2 | 3> = { ask: 1, routine: 2, all: 3 };

export function tiersForStep(step: Step): Tiers {
  const out = {} as Tiers;
  for (const family of TAGGED_FAMILIES) {
    out[family] = (FAMILY_KIND[family] === "routine" ? ROUTINE : NEW)[step];
  }
  return out;
}

/** The preset the five tiers match, or "custom". */
export function detectStep(tiers: Tiers): Step | "custom" {
  for (const step of ["ask", "routine", "all"] as const) {
    const want = tiersForStep(step);
    if (TAGGED_FAMILIES.every((family) => tiers[family] === want[family])) return step;
  }
  return "custom";
}

export const DEFAULT_LIMIT_DOLLARS = 100;
export const MAX_LIMIT_DOLLARS = 100000;

/** Whole dollars from 0 to the cap, or null. A leading $ and commas are tolerated. */
export function parseLimit(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return value <= MAX_LIMIT_DOLLARS ? value : null;
}

async function send(
  method: string,
  url: string,
  body: unknown
): Promise<{ ok: boolean; json: () => Promise<unknown> } | null> {
  try {
    return await fetch(url, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    return null;
  }
}

async function readJson(response: { json: () => Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Stored tier per tagged family. A family with no stored row keeps the default (ask). */
export async function fetchTiers(): Promise<Tiers | null> {
  let response;
  try {
    response = await fetch("/api/ai/action-policy", { credentials: "include" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await readJson(response)) as {
    policies?: Array<{ moduleId: string; actionFamilyId: string; tier: string }>;
  } | null;
  if (!body || !Array.isArray(body.policies)) return null;
  const tiers = tiersForStep("ask");
  for (const policy of body.policies) {
    if (policy.moduleId !== "finance") continue;
    const family = policy.actionFamilyId as TaggedFamily;
    if (TAGGED_FAMILIES.includes(family) && policy.tier === "trusted_auto") {
      tiers[family] = "trusted_auto";
    }
  }
  return tiers;
}

export async function setFamilyTier(family: TaggedFamily, tier: Tier): Promise<boolean> {
  const response = await send("PATCH", `/api/ai/action-policy/finance/${family}`, { tier });
  return response?.ok === true;
}

export async function setStep(step: Step): Promise<boolean> {
  const response = await send("POST", "/api/ai/action-policy/finance/freedom", {
    step: STEP_NUMBER[step]
  });
  return response?.ok === true;
}

export async function fetchLimit(): Promise<number | null> {
  let response;
  try {
    response = await fetch("/api/modules/finance/preferences", { credentials: "include" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await readJson(response)) as {
    preferences?: Array<{ key: string; value?: unknown; default?: unknown }>;
  } | null;
  const entry = body?.preferences?.find((p) => p.key === "freedomLimitDollars");
  const value = entry?.value ?? entry?.default ?? DEFAULT_LIMIT_DOLLARS;
  return typeof value === "number" ? value : DEFAULT_LIMIT_DOLLARS;
}

export async function saveLimit(dollars: number): Promise<boolean> {
  const response = await send("PATCH", "/api/modules/finance/preferences", {
    freedomLimitDollars: dollars
  });
  return response?.ok === true;
}

export interface KeySlot {
  credentialId: string;
  displayName: string;
  configured: boolean;
}

/** Bank key slots, or null when the caller is not an admin or the request failed. */
export async function fetchKeySlots(): Promise<KeySlot[] | null> {
  let response;
  try {
    response = await fetch("/api/admin/modules/finance/credentials", { credentials: "include" });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await readJson(response)) as { credentials?: KeySlot[] } | null;
  return Array.isArray(body?.credentials) ? body.credentials : null;
}

export async function saveKey(credentialId: string, value: string): Promise<boolean> {
  const response = await send(
    "PUT",
    `/api/admin/modules/finance/credentials/${encodeURIComponent(credentialId)}`,
    { value }
  );
  return response?.ok === true;
}
