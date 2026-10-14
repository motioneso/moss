export interface ResponsibilityProposalBinding {
  readonly id: string;
  readonly kind: string;
  readonly version: number;
  readonly fingerprint: string;
}

/** Exact, inert agreement terms. Execution is deliberately unavailable in this stage. */
export interface BoundedActionScope {
  readonly operation: "tasks.updateStatus";
  readonly taskId: string;
  readonly taskTitle: string;
  readonly status: "done";
  readonly dueAt: string;
  readonly timeZone: string;
  readonly destinationThreadId: string;
}
export interface ApprovedActionScopeDto {
  readonly id: string;
  readonly version: number;
  readonly state: "not_active";
  readonly approvedAt: string;
  readonly scope: BoundedActionScope;
}
