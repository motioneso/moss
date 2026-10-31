import type { MerchantRule } from "../domain/merchant-rules";
export interface RuleCategory {
  id: string;
  name: string;
  archived?: boolean;
}
export interface RulesView extends Record<string, unknown> {
  supported: boolean;
  ready: boolean;
  rules?: MerchantRule[];
  categories?: RuleCategory[];
  total?: number;
  limit?: number;
}
export interface RulePreview extends Record<string, unknown> {
  payeeKey: string;
  month: string;
  total: number;
  limit: number;
  existing: MerchantRule | null;
  examples: {
    id: string;
    name: string;
    date: string;
    amountCents: number;
    isoCurrency: string;
    categoryName: string;
    alreadyCategorized: boolean;
  }[];
}
