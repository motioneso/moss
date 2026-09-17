// VP-P0: known study-vs-product dimension gaps deferred to later slices.
export interface DeclaredSizeMismatch {
  readonly name: string;
  readonly capturedSize: string;
  readonly mockupSize: string;
}

export const DECLARED_SIZE_MISMATCHES: readonly DeclaredSizeMismatch[] = [
  { name: "1440-automatic-read.png", capturedSize: "1060x936", mockupSize: "1120x910" },
  { name: "1440-automatic-review.png", capturedSize: "1060x891", mockupSize: "1120x910" },
  { name: "1440-proposed-read.png", capturedSize: "1060x936", mockupSize: "1120x910" },
  { name: "1440-proposed-review.png", capturedSize: "1060x891", mockupSize: "1120x910" },
  { name: "partial-review.png", capturedSize: "1060x891", mockupSize: "1120x910" },
  { name: "1440-news.png", capturedSize: "1060x936", mockupSize: "1120x910" },
  { name: "1440-0.png", capturedSize: "1060x936", mockupSize: "1080x890" },
  { name: "1440-1.png", capturedSize: "1060x936", mockupSize: "1080x890" },
  { name: "1440-2.png", capturedSize: "1060x861", mockupSize: "1080x890" },
  { name: "1440-3.png", capturedSize: "1060x713", mockupSize: "1080x890" },
  { name: "changed-plan-review.png", capturedSize: "1060x713", mockupSize: "1080x890" },
  { name: "changed-plan-saved.png", capturedSize: "1060x838", mockupSize: "1080x890" },
  {
    name: "changed-plan-handoff-phone.png",
    capturedSize: "375x850",
    mockupSize: "375x1000"
  }
];
