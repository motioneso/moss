export interface TransferAccount {
  accountId: string;
  name: string;
  type: string;
  subtype: string | null;
  isoCurrency: string;
  balanceCents: number;
  openingDate: string;
  lastReconciledDate: string | null;
  revision: string;
}
export interface ManualTransfer {
  operationId: string;
  fromAccountId: string;
  toAccountId: string;
  fromRevision: string;
  toRevision: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  cleared: boolean;
  digest: string;
  today: string;
  at: string;
}
export type TransferResult = "created" | "unchanged" | "conflict" | "changed";
export interface ManualTransferStore {
  accounts(): Promise<TransferAccount[]>;
  create(input: ManualTransfer): Promise<TransferResult>;
}
