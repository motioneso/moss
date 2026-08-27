import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, Button } from "@moss/module-web-sdk";
import {
  NEWS_CREDENTIAL_MESSAGES,
  type NewsPublisherConnectionOfferDto,
  type NewsSourceCredentialStatusDto
} from "@moss/shared";

import { connectCredentialedNewsSource, replaceNewsSourceCredential } from "../web/news-client.js";
import { newsQueryKeys } from "../web/query-keys.js";

/* #2008: the one place in News where somebody types a secret. Its own file because
   settings/index.tsx is already 526 lines against the 1000-line gate.

   SECURITY, and every line below follows from it: the key exists in exactly one place, a ref
   that is cleared the moment the request is handed off, and it is never put into React state,
   into the query client, into a URL, or into browser storage. */

export type CredentialOutcome = keyof typeof NEWS_CREDENTIAL_MESSAGES;

/**
 * The route reports a typed outcome; this turns it into the sentence the user reads. It reads
 * the shared constants rather than restating them, so the screen cannot drift from what the
 * route actually returned. An unrecognised value falls back to generic copy and never shows the
 * raw value - the same rule PREVIEW_REJECTION_COPY already follows in add-source.tsx.
 */
export function credentialOutcomeMessage(outcome: string): string {
  const known = NEWS_CREDENTIAL_MESSAGES as Record<string, string>;
  return known[outcome] ?? "That did not work. Try again.";
}

export function credentialStatusBadge(status: NewsSourceCredentialStatusDto["status"]): {
  readonly label: string;
  readonly tone: "pine" | "amber" | "neutral";
} {
  switch (status) {
    case "configured":
      return { label: "Connected", tone: "pine" };
    case "revoked":
      // Amber, not neutral: a revoked key means this source has quietly stopped delivering.
      return { label: "Access revoked", tone: "amber" };
    default:
      return { label: "No key", tone: "neutral" };
  }
}

/**
 * An ApiError from the credential routes carries the fixed outcome sentence the route chose.
 * Surface that verbatim; anything else gets generic copy, because a raw error body could
 * repeat something the publisher said back to us.
 */
function requestFailureMessage(error: unknown): string {
  if (error instanceof ApiError && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }
  return "That did not work. Try again.";
}

export type ConnectPublisherMode =
  | { readonly kind: "connect" }
  | { readonly kind: "replace"; readonly sourceId: string };

export function ConnectPublisherForm({
  offer,
  mode,
  onDone,
  onCancel
}: {
  readonly offer: NewsPublisherConnectionOfferDto;
  readonly mode: ConnectPublisherMode;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  // The key lives here and nowhere else. A ref is used rather than useState because a state
  // value would be captured in the mutation's `variables`, which React Query keeps readable
  // after the request settles - the key would still be in memory long after it was needed.
  const keyRef = useRef("");
  // Only whether the box has something in it drives the button, never the value itself.
  const [hasKey, setHasKey] = useState(false);
  const [authorised, setAuthorised] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const boxId = `nw-cred-key-${offer.connectionId}`;
  const consentId = `nw-cred-ok-${offer.connectionId}`;

  function forgetKey(): void {
    keyRef.current = "";
    setHasKey(false);
  }

  // Leaving the screen - navigating away, cancelling, the source list re-rendering - must not
  // leave the key sitting in a closure.
  useEffect(
    () => () => {
      keyRef.current = "";
    },
    []
  );

  const submit = useMutation({
    mutationFn: async (apiKey: string) => {
      if (mode.kind === "replace") {
        return replaceNewsSourceCredential(mode.sourceId, { apiKey });
      }
      return connectCredentialedNewsSource({ connectionId: offer.connectionId, apiKey });
    },
    onSuccess: (result) => {
      setOutcome(result.message);
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.credentials });
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.personalization });
      void queryClient.invalidateQueries({ queryKey: newsQueryKeys.overview });
      onDone();
    },
    onError: (error) => setOutcome(requestFailureMessage(error))
  });

  // Drops the mutation's own copy of the argument once the request has settled, either way.
  useEffect(() => {
    if (submit.isSuccess || submit.isError) submit.reset();
  }, [submit.isSuccess, submit.isError, submit]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const apiKey = keyRef.current;
    if (!apiKey || !authorised || submit.isPending) return;
    setOutcome(null);
    forgetKey();
    submit.mutate(apiKey);
  }

  const busy = submit.isPending;

  return (
    <form className="nw-set__connect" onSubmit={onSubmit}>
      <p className="nw-set__connect-name">{offer.publisherName}</p>
      <p className="nw-set__connect-where">
        Your key is sent only to <strong>{offer.requestHost}</strong>. {offer.accessSummary}
      </p>
      {offer.termsUrl ? (
        <p className="nw-set__connect-terms">
          <a href={offer.termsUrl} target="_blank" rel="noreferrer noopener">
            Read {offer.publisherName}&apos;s terms
          </a>
        </p>
      ) : null}

      <label className="nw-set__exlabel" htmlFor={boxId}>
        Access key
      </label>
      {/* No `value` and no `defaultValue`: this box is never filled from server data, so a
          stored key can never be put back on screen. It starts empty and ends empty. */}
      <input
        id={boxId}
        className="jds-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        placeholder="Paste your key"
        onChange={(event) => {
          keyRef.current = event.target.value;
          setHasKey(event.target.value.length > 0);
        }}
      />

      <label className="nw-set__connect-consent" htmlFor={consentId}>
        <input
          id={consentId}
          type="checkbox"
          checked={authorised}
          disabled={busy}
          onChange={(event) => setAuthorised(event.target.checked)}
        />
        <span>I have permission to use this key here.</span>
      </label>

      <div className="nw-set__addrow">
        <Button type="submit" size="sm" disabled={busy || !hasKey || !authorised}>
          {busy ? "Connecting…" : mode.kind === "replace" ? "Save key" : "Connect"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            forgetKey();
            setOutcome(null);
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>

      {outcome ? (
        <p className="nw-set__connect-outcome" role="status">
          {outcome}
        </p>
      ) : null}
    </form>
  );
}
