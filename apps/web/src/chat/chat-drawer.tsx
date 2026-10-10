import { randomUuid, requestJson } from "@moss/module-web-sdk";
import type { MeetingChatSelection, MeetingChatTurnResponse } from "@moss/shared";
import { HistoryList } from "./history-list";
import { useChatTransition, type ChatTransition } from "./use-chat-transition";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Clock,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  ShieldOff,
  SquarePen,
  X
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { BrandMark, Chip, IconButton, Menu } from "@moss/ui";

import {
  cancelChatTurn,
  beaconEndPrivateChat,
  clearChat,
  endPrivateChat,
  getChatPrivacyState,
  listChatThreadMessages,
  listChatThreads,
  lookupAiCapabilityRoute,
  resumeChat,
  sendChatTurn
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name.js";
import {
  DEFAULT_CHAT_SURFACE,
  type ChatAttachmentDto,
  type ChatSurface,
  type LookupAiCapabilityRouteResponse
} from "@moss/shared";
import { ChatModelPill } from "./chat-model-pill";
import { ChatEmptyState } from "./chat-empty-state";
import { Composer } from "./composer";
import { ConnectProviderEmpty } from "./connect-provider-empty";
import { Thread } from "@moss/ui";
import { trapFocus } from "../shell/command-palette";

import { RecordRow } from "./message-row";
import { isNoActiveChatModelError } from "../onboarding/chat-availability";
import {
  recordsFromMessages,
  shouldEndPrivateChatOnStreamDisconnect,
  type TranscriptRecord
} from "./use-chat-stream";
export { recordsFromMessages } from "./use-chat-stream";
import "../styles/kit-chat.css";
import "../styles/kit-chat-attach.css";
import "../styles/kit-chat-skills.css";

const PHONE_QUERY = "(max-width: 720px)";

export function ChatDrawer(props: {
  readonly meetingContext?: MeetingChatSelection & { readonly title: string };
  readonly onMeetingUnavailable?: () => void;
  readonly onRemoveMeetingContext?: () => void;
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
  /** Desktop docked chat only. Expanded chat replaces the page; undefined hides the button. */
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
}) {
  const generationRef = useRef(0);
  const transition = useChatTransition(props.surface, generationRef);
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    []
  );
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

  // #1780: local privacy actions outrank in-flight server reads, which could otherwise overwrite
  // the user's new private session with stale `incognito: false`. Reset this on a surface change.
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
    mutationFn: (vars: {
      readonly threadId: string;
      readonly surface: ChatSurface;
      readonly transition: ChatTransition;
    }) => resumeChat(vars.threadId, vars.surface),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(vars.surface) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat.privacy(vars.surface) });
      if (!transition.isCurrent(vars.transition)) return;
      props.clearRecords();
      setShowHistory(false);
      // #1090: resumed threads are always non-incognito (ChatRepository.listThreads filters
      // `incognito = false`) — clear the stale privateMode/privateEnded flags to match server truth.
      privateModeDecidedLocally.current = true;
      setPrivateMode(false);
      setPrivateEnded(false);
    },
    onError: (_error, vars) => {
      if (!transition.isCurrent(vars.transition)) return;
      setReviewThreadId(null);
      setShowHistory(true);
    },
    onSettled: (_data, _error, vars) => transition.finish(vars.transition)
  });

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [needsProvider, setNeedsProvider] = useState(false);
  // Lives here, not in the composer, so a queued second message survives the composer
  // unmounting and remounting mid-turn (e.g. closing and reopening the drawer) — it is drained
  // by the effect below the instant the turn ends, whether that end came from completion or
  // from the user clicking Stop.
  const [queuedSendText, setQueuedSendText] = useState<{
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
      !props.meetingContext &&
      pendingUser !== null &&
      props.records.some((r) => r.kind === "user" && r.text === pendingUser.text)
    ) {
      setPendingUser(null);
    }
  }, [props.records, pendingUser, props.meetingContext]);

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
    setQueuedSendText(null);
  }, [props.surface]);

  const chatRouteQuery = useQuery({
    queryKey: queryKeys.ai.capability("chat"),
    queryFn: () => lookupAiCapabilityRoute("chat"),
    enabled: props.open,
    retry: false
  });
  const lockedModelUnavailable = chatRouteQuery.data?.route?.reason === "admin-pin-unavailable";
  const chatAvailable = chatAvailableFromRoute(chatRouteQuery.data);
  const chatUnavailable = chatRouteQuery.isSuccess && !chatAvailable;
  const noModelAvailable = chatUnavailable && !lockedModelUnavailable;
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
    (text: string, attachments?: readonly ChatAttachmentDto[]): boolean => {
      const trimmed = text.trim();
      // #1133: attachment-only turns (chips, no text) are legal — block only when BOTH are empty.
      if (
        (!trimmed && !attachments?.length) ||
        isSending ||
        privateEnded ||
        activatingPrivate ||
        transition.pending ||
        historyActivationPending ||
        (Boolean(props.meetingContext) && reviewThreadId !== null)
      ) {
        return false;
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
      const generation = generationRef.current;
      void (async () => {
        try {
          const result = props.meetingContext
            ? await requestJson<MeetingChatTurnResponse>("/api/chat/turn", {
                method: "POST",
                body: {
                  text: trimmed,
                  surface: initiatingSurface,
                  meetingContext: {
                    meetingId: props.meetingContext.meetingId,
                    selectionId: props.meetingContext.selectionId
                  }
                }
              })
            : await sendChatTurn(
                trimmed,
                attachments?.map((attachment) => attachment.id),
                undefined,
                initiatingSurface
              );
          void queryClient.invalidateQueries({
            queryKey: queryKeys.chat.threads(initiatingSurface)
          });
          if (surfaceRef.current !== initiatingSurface || generation !== generationRef.current)
            return;
          setPendingUser(null);
          const postResponseRecords: readonly TranscriptRecord[] = [
            {
              kind: "user",
              text: trimmed,
              messageId: result.userMessageId,
              attachments,
              ...("meetingContext" in result ? { meetingContext: result.meetingContext } : {})
            },
            {
              kind: "reply",
              text: result.reply,
              messageId: result.assistantMessageId,
              sourceFreshness: "sourceFreshness" in result ? result.sourceFreshness : undefined,
              ...("meetingContext" in result
                ? {
                    meetingContext: result.meetingContext,
                    answerProvenance: result.answerProvenance,
                    answerProvenanceCitedIds: result.answerProvenanceCitedIds
                  }
                : {})
            }
          ];
          setFallbackRecords((current) =>
            reconcileFallbacks([...current, ...postResponseRecords], latestRecordsRef.current)
          );
        } catch (caught) {
          if (surfaceRef.current !== initiatingSurface || generation !== generationRef.current)
            return;
          setPendingUser(null);
          if (
            props.meetingContext &&
            caught &&
            typeof caught === "object" &&
            "status" in caught &&
            [401, 403, 404].includes(Number(caught.status))
          ) {
            props.onMeetingUnavailable?.();
            return;
          }
          if (props.meetingContext) {
            // Local failed attempts are distinct even when an older saved question matches.
            const failedQuestion = {
              kind: "user" as const,
              text: trimmed,
              messageId: randomUuid()
            };
            setFallbackRecords((current) => [...current, failedQuestion]);
          }
          if (isNoActiveChatModelError(caught)) {
            setNeedsProvider(true);
            return;
          }
          setSendError(caught instanceof Error ? caught.message : "Could not send message");
        } finally {
          if (surfaceRef.current === initiatingSurface && generation === generationRef.current) {
            setIsSending(false);
          }
        }
      })();
      return true;
    },
    [
      activatingPrivate,
      transition.pending,
      historyActivationPending,
      isSending,
      messagesQuery.data?.messages,
      privateEnded,
      queryClient,
      reviewThreadId,
      props.surface,
      props.meetingContext,
      props.onMeetingUnavailable
    ]
  );

  useEffect(() => {
    if (isSending || transition.pending || queuedSendText === null) return;
    const queued = queuedSendText;
    setQueuedSendText(null);
    if (queued.surface !== props.surface) return;
    sendMessage(queued.text);
  }, [queuedSendText, isSending, transition.pending, props.surface, sendMessage]);

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
      setQueuedSendText(null);
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

  // Dialog contract: focus enters the message box on open, Escape closes, and focus returns to
  // whatever opened the chat. On a phone the drawer covers the page, so Tab stays inside it.
  const asideRef = useRef<HTMLElement | null>(null);
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_QUERY).matches
  );
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_QUERY);
    if (!media) return;
    const sync = () => setPhone(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!props.open) return;
    const aside = asideRef.current;
    if (!aside) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusEntry = (): boolean => {
      const box = aside.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)");
      box?.focus();
      if (box && document.activeElement === box) return true;
      aside.focus();
      return false;
    };
    // The message box can mount (or remount) after the panel while the model check settles, which
    // drops focus to the page. Pull focus back until the user moves it themselves.
    const watcher = new MutationObserver(() => {
      const active = document.activeElement;
      if (active === aside || active === document.body) focusEntry();
      else if (active !== opener && aside.contains(active) && active?.tagName !== "TEXTAREA") {
        watcher.disconnect();
      }
    });
    focusEntry();
    watcher.observe(aside, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"]
    });
    const stopWatching = window.setTimeout(() => watcher.disconnect(), 3000);
    return () => {
      window.clearTimeout(stopWatching);
      watcher.disconnect();
      if (opener?.isConnected) opener.focus();
    };
  }, [props.open]);

  if (!props.open) {
    return null;
  }

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      // An open More menu handles its own Escape.
      if (asideRef.current?.querySelector('.chatd__head [aria-expanded="true"]')) return;
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key === "Tab" && phone) trapFocus(event, asideRef.current);
  };

  const startNewChat = () => {
    const change = transition.begin();
    if (!change) return;
    void (async () => {
      try {
        await clearChat({ surface: change.surface });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(change.surface) });
        if (!transition.isCurrent(change)) return;
        setReviewThreadId(null);
        setShowHistory(false);
        setIsSending(false);
        setSendError(null);
        setNeedsProvider(false);
        setQueuedSendText(null);
        setPendingUser(null);
        setFallbackRecords([]);
        privateModeDecidedLocally.current = true;
        setPrivateMode(false);
        setPrivateEnded(false);
        props.clearRecords();
      } catch (caught) {
        if (transition.isCurrent(change)) {
          setIsSending(false);
          setPendingUser(null);
          setQueuedSendText(null);
          setSendError(caught instanceof Error ? caught.message : "Could not start a new chat");
        }
      } finally {
        transition.finish(change);
      }
    })();
  };

  const switchToNewModelChat = (surface: ChatSurface) => {
    if (surface === surfaceRef.current) {
      startNewChat();
      return;
    }
    void clearChat({ surface });
  };

  const startPrivateChat = () => {
    const change = transition.begin();
    if (!change) return;
    setReviewThreadId(null);
    setShowHistory(false);
    setIsSending(false);
    setSendError(null);
    setNeedsProvider(false);
    setQueuedSendText(null);
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
        if (!transition.isCurrent(change)) return;
        setFallbackRecords([]);
        props.clearRecords();
        setPrivateMode(true);
      } catch (caught) {
        if (!transition.isCurrent(change)) return;
        setPrivateActivationError(
          caught instanceof Error ? caught.message : "Could not start a private chat"
        );
      } finally {
        if (transition.isCurrent(change)) {
          setActivatingPrivate(false);
        }
        transition.finish(change);
      }
    })();
  };

  const closePrivateChat = () => {
    const change = transition.begin();
    if (!change) return;
    privateModeDecidedLocally.current = true;
    closingPrivateChatRef.current = true;
    setPrivateMode(false);
    setPrivateEnded(false);
    const initiatingSurface = props.surface;
    void (async () => {
      try {
        await endPrivateChat(initiatingSurface);
        if (!transition.isCurrent(change)) return;
        props.clearRecords();
        setFallbackRecords([]);
      } catch (caught) {
        if (transition.isCurrent(change)) {
          // The close never reached the server, so this was never really "decided" — let the
          // privacy-query effect apply server truth again once the invalidated query refetches,
          // instead of permanently pinning the optimistic (wrong) "closed" state.
          privateModeDecidedLocally.current = false;
          setPrivateActivationError(
            caught instanceof Error ? caught.message : "Could not end private chat"
          );
        }
      } finally {
        if (transition.isCurrent(change)) {
          closingPrivateChatRef.current = false;
          void queryClient.invalidateQueries({
            queryKey: queryKeys.chat.privacy(initiatingSurface)
          });
        }
        transition.finish(change);
      }
    })();
  };

  /** #456 — stop the in-flight turn. The backend kills the engine + emits 'Stopped by user.' over
   *  SSE; the in-flight POST /turn then settles, clearing isSending in sendMessage's finally.
   *  Any already-queued next message (see queuedSendText above) is untouched — it still drains
   *  once isSending clears, stop or no stop. */
  const stopSending = (): void => {
    void cancelChatTurn(props.surface).catch(() => {
      // best-effort: the turn ends server-side regardless; a network error here just clears isSending.
    });
  };

  const queueSend = (text: string): void => {
    setQueuedSendText({ text, surface: props.surface });
  };

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      className={`chatd${props.docked ? " chatd--docked" : ""}${props.expanded ? " chatd--expanded" : ""}`}
      role="dialog"
      aria-modal={phone ? true : undefined}
      onKeyDown={onDialogKeyDown}
      aria-label={assistantName ? `Chat with ${assistantName}` : "Chat"}
    >
      <div className="chatd__head">
        <span className="chatd__mark">
          <BrandMark size={16} />
        </span>
        <div className="chatd__id">
          <div className="chatd__name">{assistantName || "Chat"}</div>
          <div className={`chatd__status${chatUnavailable ? " chatd__status--offline" : ""}`}>
            {lockedModelUnavailable && chatUnavailable
              ? "Model unavailable"
              : noModelAvailable
                ? "Not connected"
                : props.meetingContext
                  ? "Meeting questions only"
                  : "Here when you need me"}
          </div>
        </div>
        <IconButton
          aria-label="New chat"
          title="New chat"
          onClick={startNewChat}
          disabled={transition.pending}
        >
          <SquarePen aria-hidden="true" />
        </IconButton>
        {props.onToggleExpanded ? (
          <IconButton
            aria-label={props.expanded ? "Collapse chat" : "Expand chat"}
            title={props.expanded ? "Collapse" : "Expand"}
            onClick={props.onToggleExpanded}
          >
            {props.expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </IconButton>
        ) : null}
        <Menu
          triggerIcon={<MoreHorizontal aria-hidden="true" />}
          triggerLabel="More chat options"
          items={[
            {
              id: "history",
              icon: <Clock aria-hidden="true" />,
              label: showHistory ? "Hide history" : "History",
              ariaLabel: showHistory ? "Hide chat history" : "Show chat history",
              checked: showHistory
            },
            ...(props.surface === DEFAULT_CHAT_SURFACE
              ? [
                  {
                    id: "private",
                    icon: <ShieldOff aria-hidden="true" />,
                    label: privateMode ? "Leave private chat" : "Start private chat",
                    ariaLabel: privateMode ? "Leave private chat" : "Start private chat",
                    checked: privateMode
                  }
                ]
              : [])
          ]}
          onSelect={(id) => {
            if (id === "history") setShowHistory((prev) => !prev);
            else if (id === "private") (privateMode ? closePrivateChat : startPrivateChat)();
          }}
        />
        <IconButton aria-label="Close chat" title="Close" onClick={props.onClose}>
          <X aria-hidden="true" />
        </IconButton>
      </div>

      {props.meetingContext ? (
        <div className="chatd__head">
          <Chip
            onRemove={props.onRemoveMeetingContext ?? props.onClose}
            removeLabel="Remove meeting context"
          >
            About this meeting
            {props.meetingContext.title !== "About this meeting" ? (
              <span className="jds-sr-only">: {props.meetingContext.title}</span>
            ) : null}
          </Chip>
        </div>
      ) : null}
      <div className="chatd__body-wrap">
        <div className="chatd__body" ref={bodyRef} onScroll={handleBodyScroll}>
          {showHistory ? (
            <HistoryList
              selectedThreadId={reviewThreadId}
              threads={threadsQuery.data?.threads ?? []}
              onSelect={(id) => {
                const change = props.meetingContext ? undefined : transition.begin();
                if (!props.meetingContext && !change) return;
                setReviewThreadId(id);
                setShowHistory(false);
                if (change)
                  resumeMutation.mutate({
                    threadId: id,
                    surface: props.surface,
                    transition: change
                  });
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
              working={isWaiting}
              renderRecord={(record, _index, context) => (
                <RecordRow
                  approvalOutcomeShown={context.approvalOutcomeShown}
                  record={record}
                  meetingScoped={Boolean(props.meetingContext)}
                  focusActionRequestId={props.focusActionRequestId}
                  onActionRequestFocused={props.onActionRequestFocused}
                />
              )}
            />
          ) : noModelAvailable ? (
            <ConnectProviderEmpty isFounder={props.isFounder} />
          ) : props.meetingContext ? (
            <div className="chatd-empty">
              <div className="chatd-empty__title">Ask about this meeting</div>
              <div className="chatd-empty__sub">Meeting questions only</div>
            </div>
          ) : (
            <ChatEmptyState
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

      {props.meetingContext ? (
        <p className="jds-hint">Uses the transcript so far and your saved notes.</p>
      ) : null}
      <Composer
        placeholder={props.meetingContext ? "Ask about this meeting…" : undefined}
        textOnly={Boolean(props.meetingContext)}
        modelSelector={
          <ChatModelPill
            disabled={
              Boolean(props.meetingContext) ||
              privateEnded ||
              isSending ||
              historyActivationPending ||
              transition.pending
            }
            privateMode={privateMode}
            surface={props.surface}
            onCrossProviderSwitch={switchToNewModelChat}
          />
        }
        readOnly={
          privateEnded ||
          historyActivationPending ||
          (transition.pending && !activatingPrivate) ||
          (Boolean(props.meetingContext) && reviewing)
        }
        isFounder={props.isFounder}
        initialText={props.initialText}
        isSending={isSending}
        sendError={privateEnded ? "Private chat ended. Start a new chat to continue." : sendError}
        needsProvider={needsProvider}
        noModelAvailable={noModelAvailable}
        lockedModelUnavailable={lockedModelUnavailable}
        privateMode={privateMode}
        queuedText={queuedSendText?.surface === props.surface ? queuedSendText.text : null}
        onSend={sendMessage}
        onQueue={queueSend}
        onDiscardQueuedText={() => setQueuedSendText(null)}
        onStop={stopSending}
      />
    </aside>
  );
}

function sameTranscriptRecord(a: TranscriptRecord, b: TranscriptRecord): boolean {
  if (a.kind !== b.kind) return false;
  if (a.messageId && b.messageId) return a.messageId === b.messageId;
  return a.text === b.text;
}

// #1519: consume each matching live record once. Repeated identical text without message IDs
// (including user SSE echoes) must not retire multiple fallbacks and collapse distinct sends.
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
