import { useState } from "react";
import { useLocation } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Laptop, ShieldCheck } from "lucide-react";

import { Button, Card } from "@moss/ui";
import { COMPANION_PRODUCT_NAME, type PairAttemptSummaryResponse } from "@moss/shared";

import { decideCompanionPairAttempt, getCompanionPairAttempt } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";

/**
 * The heading for the state the screen is in. The shell already labels the page, so this
 * says what the moment asks of you instead of repeating that label.
 */
function pickHeading(
  decided: "approved" | "denied" | null,
  status: PairAttemptSummaryResponse["status"] | undefined
): string {
  if (decided === "approved") return "That Mac is connected";
  if (decided === "denied") return "Nothing was connected";
  if (status === "pending") return "Do you recognise this Mac?";
  return "Connect a Mac to your account";
}

/**
 * What a newly linked Mac may do. Shown on the approval screen so the person agrees to exactly
 * this, and kept in one place so the copy cannot drift from the screen's test.
 */
export const APPROVAL_CAPABILITIES: readonly string[] = [
  "check in and rename itself",
  "read which focus block you have on right now",
  "report which app is in front while a focus block is on",
  "receive a decision about whether to nudge you"
];

/**
 * The screen a Mac sends someone to when it wants to link (#2560).
 *
 * The Mac never sees this page and never learns who is signed in here. It holds a secret
 * the server has only a digest of, and the code in this link is what lets the browser name
 * the waiting Mac. Approving binds the signed-in account to that attempt; the Mac then
 * trades its secret for a credential of its own.
 */
export function LinkTrailMarkerPage() {
  // The code arrives in the fragment, which the browser keeps to itself. Reading it from
  // the query string instead would mean the server logged it on every page load.
  const { hash } = useLocation();
  const code = new URLSearchParams(hash.replace(/^#/, "")).get("code") ?? "";
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

  // The shell already labels the page, so the heading says what this moment asks of you
  // rather than repeating that label.
  const heading = pickHeading(decided, attemptQuery.data?.status);

  return (
    <section className="page-stack" aria-label={`Link ${COMPANION_PRODUCT_NAME}`}>
      <Card padding="lg">
        <h1>{heading}</h1>

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
            <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-2)" }}>
              <ShieldCheck size={18} aria-hidden="true" style={{ flexShrink: 0 }} />
              <div>
                <span>A linked Mac will be able to:</span>
                <ul style={{ margin: "var(--space-1) 0 0", paddingLeft: "var(--space-4)" }}>
                  {APPROVAL_CAPABILITIES.map((capability) => (
                    <li key={capability}>{capability}</li>
                  ))}
                </ul>
                <span>It never gets your password or your browser session.</span>
              </div>
            </div>
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
