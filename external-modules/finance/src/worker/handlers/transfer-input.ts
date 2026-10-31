import type { TransferResult } from "../../domain/manual-transfers.js";
import { InputError, readString } from "../validate.js";
export function transferId(input: Record<string, unknown>, key: string): string {
  const value = readString(input, key, { required: true });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new InputError(`${key} must be a transfer UUID`);
  return value;
}
export function transferRevision(input: Record<string, unknown>, key: string): string {
  const value = readString(input, key, { required: true });
  if (!/^[a-f0-9]{32}$/.test(value))
    throw new InputError("Review both saved accounts and the transfer before recording a change");
  return value;
}
export function transferOutcome(result: TransferResult, operationId: string) {
  if (result === "changed")
    throw new InputError(
      "transfer_changed",
      "These saved ledgers or the original recording changed, or no longer accept this movement. No transfer was recorded; review the saved records."
    );
  if (result === "conflict")
    throw new InputError(
      "transfer_conflict",
      "This operation identity belongs to different saved details. Check account history before starting a new transfer."
    );
  return { status: "ok", transferId: operationId, unchanged: result === "unchanged" };
}
