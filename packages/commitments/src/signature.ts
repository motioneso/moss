import crypto from "node:crypto";
import type { CommitmentCandidateKind, CommitmentSourceKind } from "./types.js";

export interface SignatureInput {
  readonly kind: CommitmentCandidateKind;
  readonly counterpartyLabel: string | null;
  readonly title: string;
  readonly dueLocalDate: string | null;
  readonly sourceKind: CommitmentSourceKind;
  readonly sourceRef: string;
}

export function buildCandidateSignature(input: SignatureInput): string {
  const parts = [
    input.kind,
    normalize(input.counterpartyLabel ?? ""),
    normalize(input.title),
    input.dueLocalDate ?? "",
    input.sourceKind,
    sha8(input.sourceRef)
  ];
  return parts.join("|");
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function sha8(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}
