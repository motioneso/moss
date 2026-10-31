import type { ManualTransfer, TransferResult } from "./manual-transfers.js";
export interface TransferReview {
  transferId: string;
  fromAccountId: string;
  fromName: string;
  toAccountId: string;
  toName: string;
  date: string;
  amountCents: number;
  isoCurrency: string;
  sourceRevision: string;
  intact: boolean;
  correctedBy: { transferId: string; date: string } | null;
  correctsTransferId: string | null;
}
export interface TransferCorrection extends ManualTransfer {
  originalTransferId: string;
  sourceRevision: string;
}
export interface TransferCorrectionStore {
  read(transferId: string): Promise<TransferReview | null>;
  reverse(input: TransferCorrection): Promise<TransferResult>;
}
