import { randomUuid, requestJson } from "@moss/module-web-sdk";
import type { MeetingChatSelection, MeetingChatTurnResponse } from "@moss/shared";
import { SideChatOverlay } from "./side-chat-overlay";
import {
  initialChatDrafts,
  moveUnselectedDraft,
  saveChatDrafts,
  seedChatDraft,
  unselectedDraftKey
} from "./chat-draft-storage";
import { useChatTransition, type ChatTransition } from "./use-chat-transition";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Maximize2, Minimize2, MoreHorizontal, ShieldOff, X } from "lucide-react";
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
const PRIVATE_DRAFT_KEY = "__private__";

export function ChatDrawer(props: {
  readonly meetingContext?: MeetingChatSelection & { readonly title: string };
  readonly onMeetingUnavailable?: () => void;
  readonly onRemoveMeetingContext?: () => void;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly records: readonly TranscriptRecord[];
  readonly clearRecords: () => void;
  readonly streamErrorCount: number;
  readonly selectionPending?: boolean;
  /** #369: the founder set the instance up — tailors the empty-chat connect copy. */
  readonly isFounder: boolean;
  /** Durable drafts are scoped to this signed-in owner. */
  readonly ownerId?: string;
  /** #368: optional pre-filled, never auto-sent composer starter. */
  readonly initialText?: string;
  readonly focusActionRequestId?: string | null;
  readonly onActionRequestFocused?: () => void;
  readonly surface: ChatSurface;
  /** #1756: docks beside running drafts on desktop; phones keep the normal overlay drawer. */
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
  const [conversationOverlayOpen, setConversationOverlayOpen] = useState(false);
  const [drafts, setDrafts] = useState(() =>
    initialChatDrafts(props.ownerId, props.surface, props.initialText)
  );
  const focusComposerAfterNewSideChat = useRef(false);
  const [privateMode, setPrivateMode] = useState(false);
  const [privateEnded, setPrivateEnded] = useState(false);
  const [activatingPrivate, setActivatingPrivate] = useState(false);
  const [privateActivationError, setPrivateActivationError] = useState<string | null>(null);

  // #1780: local privacy actions outrank in-flight server reads, which could otherwise overwrite
  // the user's new private session with stale `incognito: false`. Reset this on a surface change.
  const privateModeDecidedLocally = useRef(false);
  /** #1521: suppress server truth only while private close is in flight, then restore it. */
  const closingPrivateChatRef = useRef(false);

  const privacyStateQuery = useQuery({
    queryKey: queryKeys.chat.privacy(props.surface),
    queryFn: () => getChatPrivacyState(props.surface),
    enabled: props.open,
    // "always": the global QueryClient has a 15s staleTime; `true` skips a recently invalidated
    // refetch after focus, exactly when #1521 needs the request to reach the server.
    refetchOnWindowFocus: "always"
  });

  useEffect(() => {
    if (!privacyStateQuery.isSuccess) return;
    if (privateModeDecidedLocally.current) return;
    if (closingPrivateChatRef.current) return;
    setPrivateMode(privacyStateQuery.data.incognito);
    // `dataUpdatedAt` catches an unchanged refetch after a failed close, where structural sharing
    // keeps the same `data` reference but #1521 must still apply the server-confirmed state.
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
      // #1090: resumed threads are always non-incognito (ChatRepository.listThreads filters
      // `incognito = false`) — clear the stale privateMode/privateEnded flags to match server truth.
      privateModeDecidedLocally.current = true;
      setPrivateMode(false);
      setPrivateEnded(false);
    },
    onError: (_error, vars) => {
      if (!transition.isCurrent(vars.transition)) return;
      setReviewThreadId(null);
      setConversationOverlayOpen(true);
    },
    onSettled: (_data, _error, vars) => transition.finish(vars.transition)
  });

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [needsProvider, setNeedsProvider] = useState(false);
  // Kept here so a queued turn survives composer remounts and drains after its first turn ends.
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
    setConversationOverlayOpen(false);
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
  const sendPending = isSending || transition.pending || Boolean(props.selectionPending);
  const historyActivationPending =
    reviewThreadId !== null && (resumeMutation.isPending || !messagesQuery.isSuccess);
  const mainThreadId = threadsQuery.data?.threads.find((thread) => thread.isMain)?.id;
  const selectedThreadId =
    reviewThreadId ?? privacyStateQuery.data?.threadId ?? mainThreadId ?? null;
  const fallbackDraftKey = unselectedDraftKey(props.surface);
  const draftKey =
    privateMode || activatingPrivate ? PRIVATE_DRAFT_KEY : (selectedThreadId ?? fallbackDraftKey);
  useEffect(() => saveChatDrafts(props.ownerId, drafts), [drafts, props.ownerId]);

  useEffect(() => {
    if (!selectedThreadId) return;
    setDrafts((current) => moveUnselectedDraft(current, fallbackDraftKey, selectedThreadId));
  }, [fallbackDraftKey, selectedThreadId]);

  useEffect(() => {
    if (!props.initialText) return;
    setDrafts((current) =>
      seedChatDraft(current, selectedThreadId ?? fallbackDraftKey, props.initialText)
    );
  }, [fallbackDraftKey, props.initialText, selectedThreadId]);

  /** #400: unified synchronous send entrypoint; its IIFE always clears sending state. */
  const sendMessage = useCallback(
    (text: string, attachments?: readonly ChatAttachmentDto[]): void => {
      const trimmed = text.trim();
      // #1133: attachment-only turns (chips, no text) are legal — block only when BOTH are empty.
      if (
        (!trimmed && !attachments?.length) ||
        sendPending ||
        privateEnded ||
        activatingPrivate ||
        historyActivationPending ||
        (Boolean(props.meetingContext) && reviewThreadId !== null)
      ) {
        return;
      }
      if (reviewThreadId !== null) {
        setFallbackRecords(recordsFromMessages(messagesQuery.data?.messages ?? []));
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
          if (reviewThreadId !== null) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.chat.messages(reviewThreadId, initiatingSurface)
            });
          }
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
    },
    [
      activatingPrivate,
      historyActivationPending,
      sendPending,
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
    if (sendPending || queuedSendText === null) return;
    const queued = queuedSendText;
    setQueuedSendText(null);
    if (queued.surface !== props.surface) return;
    sendMessage(queued.text);
  }, [queuedSendText, sendPending, props.surface, sendMessage]);

  const reviewing = reviewThreadId !== null;
  const displayRecords = reviewing
    ? recordsFromMessages(messagesQuery.data?.messages ?? [])
    : props.records;
  const visibleFallbackRecords = reconcileFallbacks(fallbackRecords, displayRecords);

  // Appended after persisted records so a turn remains visible while its selected thread refetches.
  const effectiveRecords: readonly TranscriptRecord[] = [
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

  const isWaiting = isSending || pendingUser !== null;

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

  // Switching conversations (or reopening the drawer) re-pins the newly shown transcript.
  useEffect(() => {
    setStickToBottom(true);
    if (props.open) {
      scrollToLatest("auto");
    }
  }, [reviewThreadId, props.open, scrollToLatest]);

  // Jump straight to the bottom whenever a new record/loading indicator lands while the user
  // hasn't scrolled away.
  useEffect(() => {
    if (stickToBottom) {
      scrollToLatest("auto");
    }
  }, [effectiveRecords.length, isWaiting, reviewThreadId, scrollToLatest, stickToBottom]);

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
  useEffect(() => {
    if (!focusComposerAfterNewSideChat.current || !props.open) return;
    const box = asideRef.current?.querySelector<HTMLTextAreaElement>("textarea:not(:disabled)");
    if (!box) return;
    box.focus();
    focusComposerAfterNewSideChat.current = false;
  }, [historyActivationPending, props.open, reviewThreadId, transition.pending]);

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

  const startNewSideChat = () => {
    const change = transition.begin();
    if (!change) return;
    void (async () => {
      try {
        await clearChat({ surface: change.surface });
        const state = await getChatPrivacyState(change.surface);
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(change.surface) });
        if (!transition.isCurrent(change)) return;
        setReviewThreadId(state.threadId ?? null);
        focusComposerAfterNewSideChat.current = true;
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
          setSendError(
            caught instanceof Error ? caught.message : "Could not start a new side chat"
          );
        }
      } finally {
        transition.finish(change);
      }
    })();
  };

  const switchToNewModelChat = (surface: ChatSurface) => {
    if (surface === surfaceRef.current) {
      startNewSideChat();
      return;
    }
    void clearChat({ surface });
  };

  const startPrivateChat = () => {
    const change = transition.begin();
    if (!change) return;
    setReviewThreadId(null);
    setIsSending(false);
    setSendError(null);
    setNeedsProvider(false);
    setQueuedSendText(null);
    setPendingUser(null);
    setPrivateEnded(false);
    setPrivateActivationError(null);
    setActivatingPrivate(true);
    setDrafts(({ [PRIVATE_DRAFT_KEY]: _privateDraft, ...persistentDrafts }) => persistentDrafts);
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
    setDrafts(({ [PRIVATE_DRAFT_KEY]: _privateDraft, ...persistentDrafts }) => persistentDrafts);
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

  /** #456: stop lets the pending turn settle; a queued next turn still drains afterward. */
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
        {props.onToggleExpanded ? (
          <IconButton
            aria-label={props.expanded ? "Collapse chat" : "Expand chat"}
            title={props.expanded ? "Collapse" : "Expand"}
            onClick={props.onToggleExpanded}
          >
            {props.expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </IconButton>
        ) : null}
        <SideChatOverlay
          key={props.surface}
          disabled={transition.pending}
          open={conversationOverlayOpen}
          selectedThreadId={selectedThreadId}
          threads={threadsQuery.data?.threads ?? []}
          loading={threadsQuery.isPending}
          error={threadsQuery.isError}
          onRetry={() => void threadsQuery.refetch()}
          onNewSideChat={startNewSideChat}
          onOpenChange={setConversationOverlayOpen}
          onSelect={(id) => {
            const change = props.meetingContext ? undefined : transition.begin();
            if (!props.meetingContext && !change) return;
            if (isSending) void cancelChatTurn(props.surface);
            setFallbackRecords([]);
            setPendingUser(null);
            setIsSending(false);
            setQueuedSendText(null);
            setSendError(null);
            setReviewThreadId(id);
            if (change) {
              resumeMutation.mutate({ threadId: id, surface: props.surface, transition: change });
            }
          }}
        />
        <Menu
          triggerIcon={<MoreHorizontal aria-hidden="true" />}
          triggerLabel="More chat options"
          items={[
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
            if (id === "private") (privateMode ? closePrivateChat : startPrivateChat)();
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
        <div
          className="chatd__body"
          inert={conversationOverlayOpen ? true : undefined}
          ref={bodyRef}
          onScroll={handleBodyScroll}
        >
          {activatingPrivate ? (
            <div className="chatd-private is-activating">
              <span>Starting private chat…</span>
            </div>
          ) : null}
          {privateActivationError ? (
            <div className="chatd-private is-error">
              <span>{privateActivationError}</span>
              <button type="button" onClick={() => setPrivateActivationError(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          {privateMode && !reviewing ? (
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
          {effectiveRecords.length > 0 ? (
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
          ) : messagesQuery.isError ? (
            <div className="chatd-empty" role="alert">
              <div className="chatd-empty__title">Could not load conversation.</div>
              <button
                aria-label="Retry conversation"
                type="button"
                onClick={() => void messagesQuery.refetch()}
              >
                Retry
              </button>
            </div>
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
          props.selectionPending ||
          historyActivationPending ||
          (transition.pending && !activatingPrivate) ||
          (Boolean(props.meetingContext) && reviewing)
        }
        isFounder={props.isFounder}
        initialText={props.initialText}
        draft={drafts[draftKey] ?? ""}
        onDraftChange={(draft) => setDrafts((current) => ({ ...current, [draftKey]: draft }))}
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
