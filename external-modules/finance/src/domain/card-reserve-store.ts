/** Browser-safe port shapes. Runtime SQL and worker helpers stay in separate files. */
export interface CardReservePolicy {
  accountId: string;
  effectiveMonth: string;
}
export interface CardReserveAssignment {
  accountId: string;
  month: string;
  assignedCents: number;
}
export interface CardReserveStore {
  policies(): Promise<CardReservePolicy[]>;
  assignments(): Promise<CardReserveAssignment[]>;
}
