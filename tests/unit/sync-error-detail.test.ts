import { describe, expect, it } from "vitest";

import { GoogleApiError } from "../../packages/connectors/src/google-api-client.js";
import { toSyncErrorDetail } from "../../packages/connectors/src/google-sync-phases.js";

// #2804: the kept failure reason is bounded tokens only, never content or secrets.
describe("toSyncErrorDetail", () => {
  it("keeps status, provider reason, and operation from a refused call", () => {
    expect(
      toSyncErrorDetail(
        new GoogleApiError(
          "Gmail refused the message",
          403,
          "rateLimitExceeded",
          "gmail.messages.get"
        )
      )
    ).toEqual({ status: 403, reason: "rateLimitExceeded", operation: "gmail.messages.get" });
  });

  it("never carries the error message, so tokens in it cannot reach the sync record", () => {
    const detail = toSyncErrorDetail(
      new GoogleApiError(
        "refused (bearer secret-xyz must never be stored)",
        403,
        "rateLimitExceeded",
        "gmail.messages.list"
      )
    );
    expect(detail).toEqual({
      status: 403,
      reason: "rateLimitExceeded",
      operation: "gmail.messages.list"
    });
    expect(JSON.stringify(detail)).not.toContain("secret-xyz");
  });

  it("drops a reason that is not a short token, but keeps the status", () => {
    expect(
      toSyncErrorDetail(
        new GoogleApiError("no", 500, "rate limit, try again <script>", "gmail.messages.list")
      )
    ).toEqual({ status: 500, reason: null, operation: "gmail.messages.list" });
  });

  it("returns null when the error names nothing worth keeping", () => {
    expect(toSyncErrorDetail(new Error("plain failure"))).toBeNull();
  });
});
