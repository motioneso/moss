import { useState } from "react";
import { useLocation } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Laptop, ShieldCheck } from "lucide-react";

import { Button, Card } from "@moss/ui";
import { COMPANION_PRODUCT_NAME, type PairAttemptSummaryResponse } from "@moss/shared";

import { ApiError, decideCompanionPairAttempt, getCompanionPairAttempt } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name.js";

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

function requestErrorMessage(error: unknown, deciding = false): string {
  if (error instanceof ApiError) {
    if (error.status === 400) {
      return "This request link couldn't be used. Reopen it from the Mac and review the connection details.";
    }
    if (error.status === 404) {
      return "That request is no longer open. Start a new one from the Mac and try again.";
    }
    if (error.status === 409) {
      return "That request was already answered. Start a new one from the Mac if you need to.";
    }
    if (error.status === 401 || error.status === 403) {
      return "Your account access couldn't be verified. Sign in again, then reopen the request from the Mac.";
    }
  }
  return deciding
    ? "Couldn't confirm your answer. Check the request again before trying to approve or decline."
    : "Couldn't check this request. Check your connection and try again.";
}

function canRetryRequest(error: unknown): boolean {
  return !(error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.status));
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
  return <LinkRequest key={code} code={code} />;
}

function LinkRequest({ code }: { readonly code: string }) {
  const assistantName = useAssistantName();
  const [decided, setDecided] = useState<"approved" | "denied" | null>(null);

  const attemptQuery = useQuery<PairAttemptSummaryResponse>({
    queryKey: queryKeys.companionPairAttempt(code),
    queryFn: () => getCompanionPairAttempt(code),
    enabled: code.length > 0 && decided === null,
    retry: false
  });

  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      decideCompanionPairAttempt({
        code,
        decision,
        ...(attemptQuery.data?.recordingPolicyVersion === 1
          ? { recordingPolicyVersion: 1 as const }
          : {})
      }),
    onSuccess: (result) => setDecided(result.status)
  });

  const deviceName = attemptQuery.data?.deviceName;
  const checking = attemptQuery.isFetching;
  const answerUnavailable = attemptQuery.isError || attemptQuery.isFetching || decide.isError;
  const retryRequest = () => {
    decide.reset();
    void attemptQuery.refetch();
  };

  // The shell already labels the page, so the heading says what this moment asks of you
  // rather than repeating that label.
  const heading = pickHeading(decided, attemptQuery.data?.status);

  return (
    <section className="page-stack" aria-label={`Link ${COMPANION_PRODUCT_NAME}`}>
      <Card padding="lg">
        <h1 className="jds-section-title">{heading}</h1>

        {code.length === 0 ? (
          <p role="alert">
            This link is missing its request code. Start again from {COMPANION_PRODUCT_NAME} on the
            Mac you want to connect.
          </p>
        ) : null}

        {checking ? <p role="status">Checking the request…</p> : null}

        {attemptQuery.isError && !checking ? (
          <div>
            <p role="alert">{requestErrorMessage(attemptQuery.error)}</p>
            {canRetryRequest(attemptQuery.error) ? (
              <Button variant="link" onClick={retryRequest}>
                Check request again
              </Button>
            ) : null}
          </div>
        ) : null}

        {decided === "approved" ? (
          <p role="status">
            <strong>{deviceName}</strong> is linked. Keep using this tab to start a meeting when
            you’re ready. You can sign the Mac out any time from Settings, under Active sessions.
          </p>
        ) : null}

        {decided === "denied" ? (
          <p role="status">Request declined. Nothing was linked and the Mac gets no access.</p>
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
                  {attemptQuery.data?.recordingPolicyVersion === 1 ? (
                    <li>Record meetings when you choose Start</li>
                  ) : null}
                </ul>
                <span>It never gets your password or your browser session.</span>
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--space-2)",
                marginTop: "var(--space-4)"
              }}
            >
              <Button
                variant="primary"
                onClick={() => decide.mutate("approve")}
                disabled={decide.isPending || answerUnavailable}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                onClick={() => decide.mutate("deny")}
                disabled={decide.isPending || answerUnavailable}
              >
                Decline
              </Button>
            </div>
            {decide.isPending ? (
              <p role="status">
                {decide.variables === "approve" ? "Approving this Mac…" : "Declining this request…"}
              </p>
            ) : null}
          </>
        ) : null}

        {decided === null && attemptQuery.data && attemptQuery.data.status !== "pending" ? (
          <p role="status">
            The request for <strong>{deviceName}</strong> was already answered. Start a new one from
            the Mac if you need to.
          </p>
        ) : null}

        {decide.isError ? (
          <div>
            <p role="alert">{requestErrorMessage(decide.error, true)}</p>
            {canRetryRequest(decide.error) ? (
              <Button variant="link" onClick={retryRequest}>
                Check request again
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </section>
  );
}
