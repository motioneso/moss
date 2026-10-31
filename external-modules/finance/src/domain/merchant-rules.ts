export interface MerchantRule {
  id: string;
  payeeKey: string;
  categoryId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  writeRevision: string;
}
export interface MerchantRuleChange {
  id: string;
  payeeKey: string;
  categoryId: string;
  enabled: boolean;
  expectedRevision: string | null;
  actor: "user" | "moss";
  at: string;
}
export interface MerchantRuleStore {
  all(): Promise<MerchantRule[]>;
  apply(change: MerchantRuleChange): Promise<boolean>;
  /** Stores each rule whose category exists and skips the rest. */
  importLegacy(
    rules: { id: string; payeeKey: string; categoryId: string; createdAt: string }[]
  ): Promise<void>;
  undo(activityId: string, writeRevision: string, at: string): Promise<boolean>;
}
