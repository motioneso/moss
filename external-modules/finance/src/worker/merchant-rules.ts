import {
  NS,
  contentHash,
  normalizePayee,
  type FinanceStore,
  type MerchantRuleStore,
  type Rule
} from "../domain/index.js";
import type { WorkerPorts } from "./ports.js";
import { InputError } from "./validate.js";
export const RULES_MIGRATED_KEY = "rules:canonical-v1";

/** Tolerant runtime reads retain the old behavior; upgrade refuses malformed legacy data. */
export async function legacyMerchantRules(ports: WorkerPorts, strict = false): Promise<Rule[]> {
  const newest = new Map<string, { rule: Rule; key: string }>();
  for (const key of await ports.kv.list(NS.rules)) {
    const value = (await ports.kv.get(NS.rules, key)) as Partial<Rule> | null;
    if (!value) continue;
    if (
      typeof value.payeeKey !== "string" ||
      value.payeeKey.length === 0 ||
      value.payeeKey.length > 200 ||
      normalizePayee(value.payeeKey) !== value.payeeKey ||
      typeof value.categoryId !== "string" ||
      !value.categoryId ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      if (strict)
        throw new InputError(
          "invalid_legacy_rule",
          "An existing merchant rule needs repair before upgrading rules"
        );
      continue;
    }
    const rule = value as Rule,
      previous = newest.get(rule.payeeKey);
    if (
      !previous ||
      Date.parse(rule.createdAt) > Date.parse(previous.rule.createdAt) ||
      (Date.parse(rule.createdAt) === Date.parse(previous.rule.createdAt) && key > previous.key)
    )
      newest.set(rule.payeeKey, { rule, key });
  }
  return [...newest.values()].map(({ rule }) => rule);
}
export async function copyLegacyMerchantRules(
  ports: WorkerPorts,
  rules: MerchantRuleStore
): Promise<void> {
  if (await ports.kv.get(NS.meta, RULES_MIGRATED_KEY)) return;
  const legacy = await legacyMerchantRules(ports, true);
  if (
    legacy.length &&
    !(await rules.importLegacy(legacy.map((r) => ({ ...r, id: contentHash(r.payeeKey) }))))
  )
    throw new InputError(
      "invalid_legacy_rule",
      "An existing rule references an unavailable category; rules were not upgraded"
    );
  await ports.kv.set(NS.meta, RULES_MIGRATED_KEY, { at: ports.now().toISOString() });
}
export async function effectiveMerchantRules(
  ports: WorkerPorts,
  store: FinanceStore
): Promise<Rule[]> {
  const newest = new Map((await legacyMerchantRules(ports)).map((r) => [r.payeeKey, r]));
  for (const rule of (await store.rules?.all()) ?? []) {
    if (rule.enabled) newest.set(rule.payeeKey, rule);
    else newest.delete(rule.payeeKey);
  }
  return [...newest.values()];
}
export async function setCanonicalMerchantRule(
  ports: WorkerPorts,
  store: FinanceStore,
  merchant: string,
  categoryId: string,
  actor: "user" | "moss"
): Promise<{ ruleId: string; previousCategoryId: string | null }> {
  if (!store.rules)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before managing rules"
    );
  await copyLegacyMerchantRules(ports, store.rules);
  const payeeKey = normalizePayee(merchant),
    ruleId = contentHash(payeeKey);
  const previous = (await store.rules.all()).find((r) => r.id === ruleId);
  if (
    !payeeKey ||
    !(await store.rules.apply({
      id: ruleId,
      payeeKey,
      categoryId,
      enabled: true,
      expectedRevision: previous?.writeRevision ?? null,
      actor,
      at: ports.now().toISOString()
    }))
  )
    throw new InputError(
      "stale_rules",
      "The merchant rule or category changed; check saved rules before trying again"
    );
  return { ruleId, previousCategoryId: previous?.enabled ? previous.categoryId : null };
}
