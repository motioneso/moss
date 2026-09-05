import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock, MessageSquareText, ShieldOff, SquarePen, X } from "lucide-react";
import { type UIEvent, useCallback, useEffect, useRef, useState } from "react";

import { EmptyState as JdsEmptyState } from "@moss/ui";

import { BrandMark } from "../shell/brand-mark";

import {
  cancelChatTurn,
  beaconEndPrivateChat,
  clearChat,
  endPrivateChat,
  getChatPrivacyState,
  listCalendarEvents,
  listChatThreadMessages,
  listChatThreads,
  listTasks,
  lookupAiCapabilityRoute,
  resumeChat,
  sendChatTurn
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import {
  DEFAULT_CHAT_SURFACE,
  type ChatAttachmentDto,
  type ChatMessageDto,
  type ChatSurface,
  type LocaleSettingsDto,
  type LookupAiCapabilityRouteResponse
} from "@moss/shared";
import { formatDate, useUserLocale } from "../locale/locale-format";
import { ChatModelPill } from "./chat-model-pill";
import { Composer } from "./composer";
import { ConnectProviderEmpty } from "./connect-provider-empty";
import { Thread } from "./message-row";
import { buildChatSeeds } from "./seeds";
import { isNoActiveChatModelError } from "../onboarding/chat-availability";
import {
  shouldEndPrivateChatOnStreamDisconnect,
  type ChatRecordKind,
  type TranscriptRecord
} from "./use-chat-stream";
import "../styles/kit-chat.css";
import "../styles/kit-chat-attach.css";
import "../styles/kit-chat-skills.css";

export function ChatDrawer(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly records: readonly TranscriptRecord[];
  readonly clearRecords: () => void;
  readonly streamErrorCount: number;
  /** #369: the founder set the instance up — tailors the empty-chat connect copy. */
  readonly isFounder: boolean;
  /**
   * #368: optional pre-filled composer text (the onboarding setup-check starter).
   * Seeds the input on mount only; it is NEVER auto-sent — the user reviews and presses send.
   */
  readonly initialText?: string;
  readonly focusActionRequestId?: string | null;
  readonly onActionRequestFocused?: () => void;
  readonly surface: ChatSurface;
  /**
   * #1756: docks the drawer beside a running draft's page instead of opening as the global
   * overlay. Desktop-width only — the CSS falls back to the ordinary overlay at the mobile
   * breakpoint, since the phone chat always stays the app's normal pop-up drawer.
   */
  readonly docked?: boolean;
}) {
  const queryClient = useQueryClient();
  const assistantName = useAssistantName("");
  const surfaceRef = useRef(props.surface);
  surfaceRef.current = props.surface;
  // #1520/1139-C: latest-value ref so an SSE-only records tick can't change sendMessage's
  // identity and retrigger the queued-drain effect below.
  const latestRecordsRef = useRef(props.records);
  latestRecordsRef.current = props.records;
  const [reviewThreadId, setReviewThreadId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [privateMode, setPrivateMode] = useState(false);
  const [privateEnded, setPrivateEnded] = useState(false);
  const [activatingPrivate, setActivatingPrivate] = useState(false);
  const [privateActivationError, setPrivateActivationError] = useState<string | null>(null);

  /**
   * #1780: two things write `privateMode` — the query below, which seeds it from the server when the
   * drawer opens, and the local handlers, which set it from what the user just did. Nothing ordered
   * them. A privacy response still in flight when the user pressed the toggle landed second and wrote
   * its now-stale `incognito: false` over a session that had already been switched to private, so the
   * drawer showed "not private" for a session the server considered private. That is the one direction
   * this flag must never be wrong in.
   *
   * The user's action wins. Once anything local has decided the flag for this surface, seeding stops
   * applying; a surface change clears it, because the new surface has its own server truth to seed
   * from and none of the old surface's decisions carry over.
   */
  const privateModeDecidedLocally = useRef(false);
  /**
   * #1521: transient, unlike `privateModeDecidedLocally` above. True only while a
   * `closePrivateChat` end-request is in flight, so the privacy-query effect below stays
   * silent for that window but resumes writing server truth once the request settles —
   * a failed close reverts instead of leaving the UI permanently claiming "closed".
   */
  const closingPrivateChatRef = useRef(false);

  const privacyStateQuery = useQuery({
    queryKey: queryKeys.chat.privacy(props.surface),
    queryFn: () => getChatPrivacyState(props.surface),
    enabled: props.open,
    // "always" (not just `true`): the global QueryClient has a 15s staleTime, so a plain `true`
    // would skip the refetch whenever focus follows a recent fetch (e.g. right after this same
    // query was just invalidated by closePrivateChat) -- exactly the window #1521 needs a real
    // focus event to be able to reach.
    refetchOnWindowFocus: "always"
  });

  useEffect(() => {
    if (!privacyStateQuery.isSuccess) return;
    if (privateModeDecidedLocally.current) return;
    if (closingPrivateChatRef.current) return;
    setPrivateMode(privacyStateQuery.data.incognito);
    // `dataUpdatedAt` (not just `data`) is required: TanStack Query's default structural
    // sharing keeps the same `data` reference when a refetch's content is unchanged (e.g. a
    // repeat `incognito: true` after a failed close), so depending on `data` alone would miss
    // exactly the case #1521 needs to catch — a refetch confirming the close never really
    // happened.
  }, [privacyStateQuery.isSuccess, privacyStateQuery.data, privacyStateQuery.dataUpdatedAt]);

  // #633: autoscroll by default; pause on manual scroll-away, resume (jump to latest) on demand.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const AUTOSCROLL_THRESHOLD_PX = 48;

  const handleBodyScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom <= AUTOSCROLL_THRESHOLD_PX);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // The history list shows most-recent-first, so "the top" (not the bottom) is where opening
  // it should land.
  const scrollToTop = useCallback((behavior: ScrollBehavior) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: 0, behavior });
  }, []);

  const jumpToLatest = useCallback(() => {
    setStickToBottom(true);
    scrollToLatest("smooth");
  }, [scrollToLatest]);

  const resumeMutation = useMutation({
    mutationFn: (vars: { readonly threadId: string; readonly surface: ChatSurface }) =>
      resumeChat(vars.threadId, vars.surface),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(vars.surface) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.privacy(vars.surface) });
      if (vars.surface !== surfaceRef.current) return;
      props.clearRecords();
      setShowHistory(false);
      // #1090: resumed threads are always non-incognito (ChatRepository.listThreads filters
      // `incognito = false`) — clear the stale privateMode/privateEnded flags to match server truth.
      privateModeDecidedLocally.current = true;
      setPrivateMode(false);
      setPrivateEnded(false);
    },
    onError: (_error, vars) => {
      if (vars.surface !== surfaceRef.current) return;
      setReviewThreadId(null);
      setShowHistory(true);
    }
  });

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [needsProvider, setNeedsProvider] = useState(false);
  const [drainAfterStopText, setDrainAfterStopText] = useState<{
    readonly text: string;
    readonly surface: ChatSurface;
  } | null>(null);

  // #1133: object (not bare string) so an attachment-only send — empty text, chips only —
  // still renders an optimistic user row while the turn is in flight.
  const [pendingUser, setPendingUser] = useState<{
    readonly text: string;
    readonly attachments?: readonly ChatAttachmentDto[];
  } | null>(null);
  const [fallbackRecords, setFallbackRecords] = useState<readonly TranscriptRecord[]>([]);

  useEffect(() => {
    if (!privateMode) return;
    const endPrivate = () => beaconEndPrivateChat();
    window.addEventListener("beforeunload", endPrivate);
    return () => window.removeEventListener("beforeunload", endPrivate);
  }, [privateMode]);

  // #399: clear the optimistic record once the SSE stream delivers the matching user record (text
  // check handles SSE pre-arriving before send). Safe to double-fire in StrictMode — idempotent.
  useEffect(() => {
    if (
      pendingUser !== null &&
      props.records.some((r) => r.kind === "user" && r.text === pendingUser.text)
    ) {
      setPendingUser(null);
    }
  }, [props.records, pendingUser]);

  // #1533: switching surfaces (e.g. drawer <-> module-embedded chat) must not leak state from the
  // previous surface — reset all locally-derived state unconditionally on every surface change.
  useEffect(() => {
    // #1780: the new surface has its own server truth, so let the privacy query seed it again.
    privateModeDecidedLocally.current = false;
    closingPrivateChatRef.current = false;
    setFallbackRecords([]);
    setPendingUser(null);
    setPrivateMode(false);
    setPrivateEnded(false);
    setReviewThreadId(null);
    setShowHistory(false);
    setIsSending(false);
    setSendError(null);
    setNeedsProvider(false);
    setActivatingPrivate(false);
    setPrivateActivationError(null);
    setDrainAfterStopText(null);
  }, [props.surface]);

  const chatRouteQuery = useQuery({
    queryKey: queryKeys.ai.capability("chat"),
    queryFn: () => lookupAiCapabilityRoute("chat"),
    enabled: props.open,
    retry: false
  });
  const lockedModelUnavailable = chatRouteQuery.data?.route?.reason === "admin-pin-unavailable";
  const chatAvailable = chatAvailableFromRoute(chatRouteQuery.data);
  const threadsQuery = useQuery({
    queryKey: queryKeys.chat.threads(props.surface),
    queryFn: () => listChatThreads(props.surface),
    enabled: props.open
  });
  const messagesQuery = useQuery({
    queryKey: queryKeys.chat.messages(reviewThreadId ?? "", props.surface),
    queryFn: () => listChatThreadMessages(reviewThreadId ?? "", props.surface),
    enabled: props.open && reviewThreadId !== null
  });
  const historyActivationPending =
    reviewThreadId !== null && (resumeMutation.isPending || !messagesQuery.isSuccess);

  /**
   * Unified send path for both the seed buttons and the manual composer (#400).
   * The IIFE keeps the function signature synchronous so call sites need no `void`/`async`.
   * try/finally guarantees isSending is ALWAYS cleared — this is the core wedge fix.
   */
  const sendMessage = useCallback(
    (text: string, attachments?: readonly ChatAttachmentDto[]): void => {
      const trimmed = text.trim();
      // #1133: attachment-only turns (chips, no text) are legal — block only when BOTH are empty.
      if (
        (!trimmed && !attachments?.length) ||
        isSending ||
        privateEnded ||
        activatingPrivate ||
        historyActivationPending
      ) {
        return;
      }
      if (reviewThreadId !== null) {
        setFallbackRecords(recordsFromMessages(messagesQuery.data?.messages ?? []));
        setReviewThreadId(null);
      }
      setSendError(null);
      setNeedsProvider(false);
      setIsSending(true);
      setPendingUser({ text: trimmed, attachments });
      const initiatingSurface = props.surface;
      void (async () => {
        try {
          const result = await sendChatTurn(
            trimmed,
            attachments?.map((attachment) => attachment.id),
            undefined,
            initiatingSurface
          );
          void queryClient.invalidateQueries({
            queryKey: queryKeys.chat.threads(initiatingSurface)
          });
          if (surfaceRef.current !== initiatingSurface) return;
          setPendingUser(null);
          const postResponseRecords: readonly TranscriptRecord[] = [
            { kind: "user", text: trimmed, messageId: result.userMessageId, attachments },
            {
              kind: "reply",
              text: result.reply,
              messageId: result.assistantMessageId,
              sourceFreshness: result.sourceFreshness
            }
          ];
          setFallbackRecords((current) =>
            reconcileFallbacks([...current, ...postResponseRecords], latestRecordsRef.current)
          );
        } catch (caught) {
          if (surfaceRef.current !== initiatingSurface) return;
          setPendingUser(null);
          if (isNoActiveChatModelError(caught)) {
            setNeedsProvider(true);
            return;
          }
          setSendError(caught instanceof Error ? caught.message : "Could not send message");
        } finally {
          if (surfaceRef.current === initiatingSurface) {
            setIsSending(false);
          }
        }
      })();
    },
    [
      activatingPrivate,
      historyActivationPending,
      isSending,
      messagesQuery.data?.messages,
      privateEnded,
      queryClient,
      reviewThreadId
    ]
  );

  useEffect(() => {
    if (isSending || drainAfterStopText === null) return;
    const queued = drainAfterStopText;
    setDrainAfterStopText(null);
    if (queued.surface !== props.surface) return;
    sendMessage(queued.text);
  }, [drainAfterStopText, isSending, props.surface, sendMessage]);

  const reviewing = reviewThreadId !== null;
  const displayRecords = reviewing
    ? recordsFromMessages(messagesQuery.data?.messages ?? [])
    : props.records;
  const visibleFallbackRecords = reconcileFallbacks(fallbackRecords, displayRecords);

  // Merge the optimistic user record into the live feed (#399, live mode only — history review
  // uses fetched messages directly). Appended AFTER the older fallback records since it's the
  // newest item; splicing it before them rendered a just-sent message above prior turns (#664).
  const effectiveRecords: readonly TranscriptRecord[] = reviewing
    ? displayRecords
    : [
        ...displayRecords,
        ...visibleFallbackRecords,
        ...(pendingUser
          ? [
              {
                kind: "user" as const,
                text: pendingUser.text,
                attachments: pendingUser.attachments
              }
            ]
          : [])
      ];

  const isWaiting = !reviewing && (isSending || pendingUser !== null);

  useEffect(() => {
    if (
      shouldEndPrivateChatOnStreamDisconnect({
        privateMode,
        privateEnded,
        streamErrorCount: props.streamErrorCount
      })
    ) {
      setPrivateEnded(true);
      setIsSending(false);
      setPendingUser(null);
      setDrainAfterStopText(null);
    }
  }, [privateEnded, privateMode, props.streamErrorCount]);

  // #633: switching what's displayed (new chat, opening a history row, toggling the history
  // list, or the drawer itself (re)opening — #638) always re-pins to the start of the
  // newly-shown content: the top for the most-recent-first history list, the bottom for a
  // transcript.
  useEffect(() => {
    if (showHistory) {
      setStickToBottom(false);
      if (props.open) {
        scrollToTop("auto");
      }
      return;
    }
    setStickToBottom(true);
    if (props.open) {
      scrollToLatest("auto");
    }
  }, [reviewThreadId, showHistory, props.open, scrollToLatest, scrollToTop]);

  // #633: jump straight to the bottom (no animation) whenever a new record/loading indicator
  // lands while the user hasn't scrolled away. Never fires while the history list is showing —
  // that list opens pinned to the top, not the bottom.
  useEffect(() => {
    if (showHistory) return;
    if (stickToBottom) {
      scrollToLatest("auto");
    }
  }, [effectiveRecords.length, isWaiting, reviewThreadId, showHistory]);

  if (!props.open) {
    return null;
  }

  const startNewChat = () => {
    setReviewThreadId(null);
    setShowHistory(false);
    setIsSending(false);
    setSendError(null);
    setNeedsProvider(false);
    setDrainAfterStopText(null);
    setPendingUser(null);
    setFallbackRecords([]);
    privateModeDecidedLocally.current = true;
    setPrivateMode(false);
    setPrivateEnded(false);
    void clearChat({ surface: props.surface });
    props.clearRecords();
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(props.surface) });
  };

  const switchToNewModelChat = (surface: ChatSurface) => {
    if (surface === surfaceRef.current) {
      startNewChat();
      return;
    }
    void clearChat({ surface });
  };

  const startPrivateChat = () => {
    setReviewThreadId(null);
    setShowHistory(false);
    setIsSending(false);
    setSendError(null);
    setNeedsProvider(false);
    setDrainAfterStopText(null);
    setPendingUser(null);
    setPrivateEnded(false);
    setPrivateActivationError(null);
    setActivatingPrivate(true);
    // #1780: claimed at the click, not when the request comes back — the whole point is to outrank a
    // privacy response that was already in flight before the user asked for a private chat.
    privateModeDecidedLocally.current = true;
    const initiatingSurface = props.surface;
    void (async () => {
      try {
        await clearChat({ incognito: true, surface: initiatingSurface });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.chat.threads(initiatingSurface)
        });
        if (surfaceRef.current !== initiatingSurface) return;
        setFallbackRecords([]);
        props.clearRecords();
        setPrivateMode(true);
      } catch (caught) {
        if (surfaceRef.current !== initiatingSurface) return;
        setPrivateActivationError(
          caught instanceof Error ? caught.message : "Could not start a private chat"
        );
      } finally {
        if (surfaceRef.current === initiatingSurface) {
          setActivatingPrivate(false);
        }
      }
    })();
  };

  const closePrivateChat = () => {
    privateModeDecidedLocally.current = true;
    closingPrivateChatRef.current = true;
    setPrivateMode(false);
    setPrivateEnded(false);
    props.clearRecords();
    setFallbackRecords([]);
    const initiatingSurface = props.surface;
    void (async () => {
      try {
        await endPrivateChat(initiatingSurface);
      } catch (caught) {
        if (surfaceRef.current === initiatingSurface) {
          // The close never reached the server, so this was never really "decided" — let the
          // privacy-query effect apply server truth again once the invalidated query refetches,
          // instead of permanently pinning the optimistic (wrong) "closed" state.
          privateModeDecidedLocally.current = false;
          setPrivateActivationError(
            caught instanceof Error ? caught.message : "Could not end private chat"
          );
        }
      } finally {
        if (surfaceRef.current === initiatingSurface) {
          closingPrivateChatRef.current = false;
          void queryClient.invalidateQueries({
            queryKey: queryKeys.chat.privacy(initiatingSurface)
          });
        }
      }
    })();
  };

  /** #456 — stop the in-flight turn. The backend kills the engine + emits 'Stopped by user.' over
   *  SSE; the in-flight POST /turn then settles, clearing isSending in sendMessage's finally. */
  const stopSending = (queuedText: string | null): void => {
    if (queuedText !== null) {
      setDrainAfterStopText({ text: queuedText, surface: props.surface });
    }
    void cancelChatTurn(props.surface).catch(() => {
      // best-effort: the turn ends server-side regardless; a network error here just clears isSending.
    });
  };

  return (
    <aside
      className={props.docked ? "chatd chatd--docked" : "chatd"}
      role="dialog"
      aria-label={assistantName ? `Chat with ${assistantName}` : "Chat"}
    >
      <div className="chatd__head">
        <span className="chatd__mark">
          <BrandMark size={16} />
        </span>
        <div className="chatd__id">
          <div className="chatd__name">{assistantName || "Chat"}</div>
          <div className="chatd__status">Here when you need me</div>
        </div>
        <button
          aria-label="New chat"
          className="chatd__hbtn"
          title="New chat"
          type="button"
          onClick={startNewChat}
        >
          <SquarePen size={16} aria-hidden="true" />
        </button>
        {props.surface === DEFAULT_CHAT_SURFACE && (
          <button
            aria-label="Start private chat"
            aria-pressed={privateMode}
            className={`chatd__hbtn${privateMode ? " is-on" : ""}`}
            title="Private chat"
            type="button"
            onClick={startPrivateChat}
          >
            <ShieldOff size={16} aria-hidden="true" />
          </button>
        )}
        <button
          aria-label={showHistory ? "Hide chat history" : "Show chat history"}
          aria-pressed={showHistory}
          className={`chatd__hbtn${showHistory ? " is-on" : ""}`}
          title={showHistory ? "Hide history" : "History"}
          type="button"
          onClick={() => setShowHistory((prev) => !prev)}
        >
          <Clock size={16} aria-hidden="true" />
        </button>
        <button
          aria-label="Close chat"
          className="chatd__hbtn"
          title="Close"
          type="button"
          onClick={props.onClose}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="chatd__body-wrap">
        <div className="chatd__body" ref={bodyRef} onScroll={handleBodyScroll}>
          {showHistory ? (
            <HistoryList
              selectedThreadId={reviewThreadId}
              threads={threadsQuery.data?.threads ?? []}
              onSelect={(id) => {
                setReviewThreadId(id);
                setShowHistory(false);
                resumeMutation.mutate({ threadId: id, surface: props.surface });
              }}
              activating={resumeMutation.isPending}
            />
          ) : null}
          {!showHistory && activatingPrivate ? (
            <div className="chatd-private is-activating">
              <span>Starting private chat…</span>
            </div>
          ) : null}
          {!showHistory && privateActivationError ? (
            <div className="chatd-private is-error">
              <span>{privateActivationError}</span>
              <button type="button" onClick={() => setPrivateActivationError(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          {!showHistory && privateMode && !reviewing ? (
            <div className={`chatd-private${privateEnded ? " is-ended" : ""}`}>
              <span>
                {privateEnded
                  ? "Private chat ended. Start a new chat to continue."
                  : "Private chat: not saved to history. Approved actions still keep records."}
              </span>
              <button type="button" onClick={closePrivateChat}>
                End
              </button>
            </div>
          ) : null}
          {showHistory ? null : effectiveRecords.length > 0 ? (
            <Thread
              records={effectiveRecords}
              focusActionRequestId={props.focusActionRequestId}
              onActionRequestFocused={props.onActionRequestFocused}
              working={isWaiting}
            />
          ) : chatRouteQuery.isSuccess && !chatAvailable && !lockedModelUnavailable ? (
            <ConnectProviderEmpty isFounder={props.isFounder} />
          ) : (
            <EmptyState
              onSend={sendMessage}
              isSending={isSending}
              lockedModelUnavailable={lockedModelUnavailable}
            />
          )}
          {isWaiting ? (
            <div
              className="chatd-loading"
              aria-live="polite"
              aria-label={assistantName ? `${assistantName} is thinking` : "Assistant is thinking"}
            >
              <span className="chatd-msg__av">
                <BrandMark size={14} />
              </span>
              <svg
                className="chatd-loading__bar"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 14 32 4"
                fill="currentColor"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path opacity="0.8" transform="translate(0 0)" d="M2 14 V18 H6 V14z">
                  <animateTransform
                    attributeName="transform"
                    type="translate"
                    values="0 0; 24 0; 0 0"
                    dur="2s"
                    begin="0"
                    repeatCount="indefinite"
                    keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8"
                    calcMode="spline"
                  />
                </path>
                <path opacity="0.5" transform="translate(0 0)" d="M0 14 V18 H8 V14z">
                  <animateTransform
                    attributeName="transform"
                    type="translate"
                    values="0 0; 24 0; 0 0"
                    dur="2s"
                    begin="0.1s"
                    repeatCount="indefinite"
                    keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8"
                    calcMode="spline"
                  />
                </path>
                <path opacity="0.25" transform="translate(0 0)" d="M0 14 V18 H8 V14z">
                  <animateTransform
                    attributeName="transform"
                    type="translate"
                    values="0 0; 24 0; 0 0"
                    dur="2s"
                    begin="0.2s"
                    repeatCount="indefinite"
                    keySplines="0.2 0.2 0.4 0.8;0.2 0.2 0.4 0.8"
                    calcMode="spline"
                  />
                </path>
              </svg>
            </div>
          ) : null}
        </div>
        {!stickToBottom ? (
          <button
            aria-label="Jump to latest message"
            className="chatd__jump"
            type="button"
            onClick={jumpToLatest}
          >
            <ChevronDown size={14} aria-hidden="true" />
            Jump to latest
          </button>
        ) : null}
      </div>

      <Composer
        modelSelector={
          <ChatModelPill
            disabled={privateEnded || isSending || historyActivationPending}
            privateMode={privateMode}
            surface={props.surface}
            onCrossProviderSwitch={switchToNewModelChat}
          />
        }
        readOnly={privateEnded || historyActivationPending}
        isFounder={props.isFounder}
        initialText={props.initialText}
        isSending={isSending}
        sendError={privateEnded ? "Private chat ended. Start a new chat to continue." : sendError}
        needsProvider={needsProvider}
        lockedModelUnavailable={lockedModelUnavailable}
        privateMode={privateMode}
        onSend={sendMessage}
        onStop={stopSending}
      />
    </aside>
  );
}

function HistoryList(props: {
  readonly threads: readonly {
    readonly id: string;
    readonly title: string;
    readonly lastActiveAt: string;
    readonly lastMessagePreview: string | null;
  }[];
  readonly selectedThreadId: string | null;
  readonly onSelect: (threadId: string) => void;
  readonly activating: boolean;
}) {
  const locale = useUserLocale();
  if (props.threads.length === 0) {
    return (
      <div className="chatd-sess chatd-sess--empty">
        <JdsEmptyState
          icon={<MessageSquareText size={18} aria-hidden="true" />}
          title="No past conversations yet."
        />
      </div>
    );
  }
  return (
    <div className="chatd-sess">
      <div className="chatd-sess__hd">History</div>
      {props.threads.map((thread) => (
        <button
          className={`chatd-sess__row${props.selectedThreadId === thread.id ? " is-selected" : ""}`}
          disabled={props.activating}
          key={thread.id}
          type="button"
          onClick={() => props.onSelect(thread.id)}
        >
          <span className="chatd-sess__ic">
            <MessageSquareText size={14} aria-hidden="true" />
          </span>
          <span className="chatd-sess__main">
            <span className="chatd-sess__title">{thread.title}</span>
            {thread.lastMessagePreview ? (
              <span className="chatd-sess__preview">{thread.lastMessagePreview}</span>
            ) : null}
          </span>
          <span className="chatd-sess__when">
            {relativeThreadTime(thread.lastActiveAt, locale)}
          </span>
        </button>
      ))}
    </div>
  );
}

function sameTranscriptRecord(a: TranscriptRecord, b: TranscriptRecord): boolean {
  if (a.kind !== b.kind) return false;
  if (a.messageId && b.messageId) return a.messageId === b.messageId;
  return a.text === b.text;
}

// #1519: a pending-record fallback must be retired by AT MOST ONE live record, never by every
// live record that happens to match it. sameTranscriptRecord alone can't guarantee that — when
// two fallbacks share identical (kind, text) and neither the live record nor one of the fallbacks
// carries a messageId (true of every "kind: user" SSE echo, which never carries one), a single
// live record's arrival would otherwise satisfy the predicate against BOTH fallbacks at once and
// collapse them together — the exact flicker this issue exists to prevent, just relocated from the
// reply bubble to the user bubble. Consuming each matched live record once (in fallback order)
// keeps the reconciliation one-to-one.
function reconcileFallbacks(
  fallbacks: readonly TranscriptRecord[],
  liveRecords: readonly TranscriptRecord[]
): readonly TranscriptRecord[] {
  const unmatched = [...liveRecords];
  return fallbacks.filter((fallback) => {
    const idx = unmatched.findIndex((record) => sameTranscriptRecord(record, fallback));
    if (idx === -1) return true;
    unmatched.splice(idx, 1);
    return false;
  });
}

export function chatAvailableFromRoute(data: LookupAiCapabilityRouteResponse | undefined): boolean {
  return data?.route?.available === true;
}

export function recordsFromMessages(messages: readonly ChatMessageDto[]): TranscriptRecord[] {
  return messages.flatMap((message) => {
    const actionResults = message.activity.flatMap((event): TranscriptRecord[] =>
      event.kind === "action_result" && event.outcome
        ? [
            {
              kind: "action_result",
              text: event.text,
              toolName: event.toolName,
              outcome: event.outcome
            }
          ]
        : []
    );
    return [
      ...message.activity.flatMap((event): TranscriptRecord[] =>
        event.kind === "action_result"
          ? []
          : [{ kind: safeActivityKind(event.kind), text: event.text }]
      ),
      ...message.tools.map((tool) => ({
        kind: "tool" as const,
        text: tool.name
      })),
      {
        kind:
          message.role === "user"
            ? ("user" as const)
            : message.status === "error"
              ? ("error" as const)
              : ("reply" as const),
        text: message.body,
        messageId: message.id,
        // #1133: history user rows re-show the chips saved in tool_metadata.attachments.
        attachments: message.role === "user" ? message.attachments : undefined,
        answerProvenance: message.answerProvenance,
        answerProvenanceCitedIds: message.answerProvenanceCitedIds,
        sourceFreshness: message.role === "assistant" ? message.sourceFreshness : undefined
      },
      ...actionResults
    ];
  });
}

function safeActivityKind(kind: string): ChatRecordKind {
  if (kind === "thinking" || kind === "tool" || kind === "status" || kind === "action_result") {
    return kind;
  }
  return "status";
}

function relativeThreadTime(value: string, locale: LocaleSettingsDto): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return formatDate(value, locale, { month: "short", day: "numeric" });
}

function EmptyState(props: {
  readonly onSend: (text: string) => void;
  readonly isSending: boolean;
  readonly lockedModelUnavailable: boolean;
}) {
  const tasksQuery = useQuery({ queryKey: queryKeys.tasks.list, queryFn: () => listTasks() });
  const eventsQuery = useQuery({
    queryKey: queryKeys.calendar.list,
    queryFn: () => listCalendarEvents()
  });
  const locale = useUserLocale();

  const seeds = buildChatSeeds(
    tasksQuery.data?.tasks ?? [],
    eventsQuery.data?.events ?? [],
    locale
  );

  return (
    <div className="chatd-empty">
      <span className="chatd-empty__mark">
        <BrandMark size={22} />
      </span>
      <div className="chatd-empty__title">What can I help with?</div>
      <div className="chatd-empty__sub">
        Ask about your day, your tasks, or anything you&apos;ve told me.
      </div>
      <div className="chatd-sugg">
        {seeds.map((seed) => (
          <button
            className="chatd-sugg__btn"
            disabled={props.isSending || props.lockedModelUnavailable}
            key={seed}
            type="button"
            onClick={() => props.onSend(seed)}
          >
            {seed}
          </button>
        ))}
      </div>
    </div>
  );
}
