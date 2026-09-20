import { useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Laptop, ShieldCheck } from "lucide-react";

import { Button, Card } from "@moss/ui";
import { COMPANION_PRODUCT_NAME, type PairAttemptSummaryResponse } from "@moss/shared";

import { decideCompanionPairAttempt, getCompanionPairAttempt } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";

/**
 * The screen a Mac sends someone to when it wants to link (#2560).
 *
 * The Mac never sees this page and never learns who is signed in here. It holds a secret
 * the server has only a digest of, and the code in this URL is what lets the browser name
 * the waiting Mac. Approving binds the signed-in account to that attempt; the Mac then
 * trades its secret for a credential of its own.
 */
export function LinkTrailMarkerPage() {
  const [params] = useSearchParams();
  const code = params.get("code") ?? "";
  const assistantName = useAssistantName();
  const [decided, setDecided] = useState<"approved" | "denied" | null>(null);

  const attemptQuery = useQuery<PairAttemptSummaryResponse>({
    queryKey: queryKeys.companionPairAttempt(code),
    queryFn: () => getCompanionPairAttempt(code),
    enabled: code.length > 0,
    retry: false
  });

  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") => decideCompanionPairAttempt({ code, decision }),
    onSuccess: (result) => setDecided(result.status)
  });

  const deviceName = attemptQuery.data?.deviceName;

  return (
    <section className="page-stack" aria-label={`Link ${COMPANION_PRODUCT_NAME}`}>
      <Card padding="lg">
        <h1>Link a Mac</h1>

        {code.length === 0 ? (
          <p>
            This link is missing its request code. Start again from {COMPANION_PRODUCT_NAME} on the
            Mac you want to connect.
          </p>
        ) : null}

        {attemptQuery.isLoading ? <p>Checking the request…</p> : null}

        {attemptQuery.isError ? (
          <p>
            That request is no longer open. Requests last ten minutes, so start a new one from the
            Mac and try again.
          </p>
        ) : null}

        {decided === "approved" ? (
          <p>
            <strong>{deviceName}</strong> is linked. You can close this page, and sign the Mac out
            any time from Settings, under Active sessions.
          </p>
        ) : null}

        {decided === "denied" ? (
          <p>Request declined. Nothing was linked and the Mac gets no access.</p>
        ) : null}

        {decided === null && attemptQuery.data?.status === "pending" ? (
          <>
            <p style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)" }}>
              <Laptop size={18} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span>
                <strong>{deviceName}</strong> is asking to connect to your {assistantName} account.
                Approve it only if you started this on that Mac.
              </span>
            </p>
            <p style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)" }}>
              <ShieldCheck size={18} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span>
                A linked Mac can check in and rename itself. It cannot read your data, and it never
                gets your password or your browser session.
              </span>
            </p>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button
                variant="primary"
                onClick={() => decide.mutate("approve")}
                disabled={decide.isPending}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                onClick={() => decide.mutate("deny")}
                disabled={decide.isPending}
              >
                Decline
              </Button>
            </div>
          </>
        ) : null}

        {decided === null && attemptQuery.data && attemptQuery.data.status !== "pending" ? (
          <p>That request was already answered. Start a new one from the Mac if you need to.</p>
        ) : null}

        {decide.isError ? <p>Something went wrong answering the request. Try again.</p> : null}
      </Card>
    </section>
  );
}
