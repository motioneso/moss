/** One-time recording capability attached to the existing named companion connection. */
export const RECORDING_CAPABILITY_POLICY_VERSION = 1 as const;

export interface RecordingCapabilityApproval {
  readonly policyVersion: 1;
  readonly revision: number;
}

export interface RecordingCapabilityAttemptInput {
  readonly requestKey: string;
  readonly proofHash: string;
  readonly policyVersion: 1;
}

export interface RecordingCapabilityAttempt {
  readonly attemptId: string;
  readonly expiresAt: string;
  readonly policyVersion: 1;
  readonly status: "pending" | "approved" | "denied" | "expired";
  readonly revision?: number;
}

export interface RecordingCapabilityDevice {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly state: "unapproved" | "approved" | "revoked";
  readonly revision: number;
  readonly policyVersion: 1;
  readonly pending?: {
    readonly attemptId: string;
    readonly expiresAt: string;
    readonly policyVersion: 1;
  };
}

export interface RecordingCapabilitiesResponse {
  readonly devices: readonly RecordingCapabilityDevice[];
}

export interface DecideRecordingCapabilityInput {
  readonly attemptId: string;
  readonly decision: "approve" | "deny";
  readonly policyVersion: 1;
}

export interface DecideRecordingCapabilityResponse {
  readonly status: "approved" | "denied";
  readonly revision?: number;
}
