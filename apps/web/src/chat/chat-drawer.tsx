import { randomUuid, requestJson } from "@moss/module-web-sdk";
import type { MeetingChatSelection, MeetingChatTurnResponse } from "@moss/shared";
import { findOwnerMainThread, SideChatOverlay } from "./side-chat-overlay";
import { loadChatDrafts, saveChatDrafts } from "./chat-draft-storage";
import { useChatTransition, type ChatTransition } from "./use-chat-transition";
import { useInitialCallerDraft } from "./use-initial-caller-draft";
import { useChatSelectionConfirmation } from "./use-chat-selection-confirmation";
import { useChatDraftBinding } from "./use-chat-draft-binding";
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
import { BrandMark, Button, Chip, IconButton, Menu } from "@moss/ui";
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
  reconcileFallbacks,
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
  readonly isFounder: boolean;
  readonly ownerId?: string;
  readonly initialText?: string;
  readonly focusActionRequestId?: string | null;
  readonly onActionRequestFocused?: () => void;
  readonly surface: ChatSurface;
  readonly docked?: boolean;
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
  const latestRecordsRef = useRef(props.records);
  latestRecordsRef.current = props.records;
  const [reviewThreadId, setReviewThreadId] = useState<string | null>(null);
  const [liveThreadId, setLiveThreadId] = useState<string | null>(null);
  const [conversationOverlayOpen, setConversationOverlayOpen] = useState(false);
  const [drafts, setDrafts] = useState(() => loadChatDrafts(props.ownerId));
  const callerDraft = useInitialCallerDraft(props.initialText, props.surface, generationRef);
  const selection = useChatSelectionConfirmation(props.surface, generationRef);
  const focusComposerAfterNewSideChat = useRef(false);
  const [privateMode, setPrivateMode] = useState(false);
  const [privateEnded, setPrivateEnded] = useState(false);
  const [activatingPrivate, setActivatingPrivate] = useState(false);
  const [privateActivationError, setPrivateActivationError] = useState<string | null>(null);
  const privateModeDecidedLocally = useRef(false);
  const closingPrivateChatRef = useRef(false);
  const privacyStateQuery = useQuery({
    queryKey: queryKeys.chat.privacy(props.surface),
    queryFn: () => getChatPrivacyState(props.surface),
    enabled: props.open,
    refetchOnWindowFocus: "always"
  });
  useEffect(() => {
    if (!privacyStateQuery.isSuccess) return;
    if (privateModeDecidedLocally.current) return;
    if (closingPrivateChatRef.current) return;
    setPrivateMode(privacyStateQuery.data.incognito);
  }, [privacyStateQuery.isSuccess, privacyStateQuery.data, privacyStateQuery.dataUpdatedAt]);
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
      selection.confirm(vars.threadId, vars.transition);
      callerDraft.bind(vars.threadId, vars.surface, vars.transition.generation, true);
      props.clearRecords();
      privateModeDecidedLocally.current = true;
      setPrivateMode(false);
      setPrivateEnded(false);
    },
    onError: (_error, vars) => {
      if (!transition.isCurrent(vars.transition)) return;
      callerDraft.retire(vars.surface, vars.transition.generation);
      setReviewThreadId(null);
      setLiveThreadId(null);
      setConversationOverlayOpen(true);
    },
    onSettled: (_data, _error, vars) => transition.finish(vars.transition)
  });
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [needsProvider, setNeedsProvider] = useState(false);
  const [queuedSendText, setQueuedSendText] = useState<{
    readonly text: string;
    readonly surface: ChatSurface;
  } | null>(null);
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
  useEffect(() => {
    if (
      !props.meetingContext &&
      pendingUser !== null &&
      props.records.some((r) => r.kind === "user" && r.text === pendingUser.text)
    ) {
      setPendingUser(null);
    }
  }, [props.records, pendingUser, props.meetingContext]);
  useEffect(() => {
    privateModeDecidedLocally.current = false;
    closingPrivateChatRef.current = false;
    setFallbackRecords([]);
    setPendingUser(null);
    setPrivateMode(false);
    setPrivateEnded(false);
    setReviewThreadId(null);
    setLiveThreadId(null);
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
  const chatUnavailable = chatRouteQuery.isSuccess && !chatAvailableFromRoute(chatRouteQuery.data);
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
  const mainThreadId = findOwnerMainThread(threadsQuery.data?.threads ?? [], props.ownerId)?.id;
  const confirmedSelection = selection.current;
  const moduleIdentityPending =
    props.surface !== DEFAULT_CHAT_SURFACE && !confirmedSelection && !privacyStateQuery.isSuccess;
  const selectedThreadId =
    reviewThreadId ??
    (confirmedSelection
      ? confirmedSelection.threadId
      : (privacyStateQuery.data?.threadId ?? mainThreadId ?? null));
  const draftBinding = useChatDraftBinding({
    surface: props.surface,
    drafts,
    setDrafts,
    privateMode,
    activatingPrivate,
    selectedThreadId,
    mainThreadId,
    hasConfirmedSelection: Boolean(confirmedSelection),
    confirmedThreadId: confirmedSelection?.threadId ?? null,
    privacyThreadId: privacyStateQuery.isSuccess ? privacyStateQuery.data.threadId : undefined,
    generation: generationRef
  });
  const visibleCallerDraft =
    privateMode || (privacyStateQuery.data?.incognito && !privateModeDecidedLocally.current)
      ? ""
      : callerDraft.textFor(selectedThreadId, drafts[draftBinding.draftKey]);
  const composerTarget = {
    destination: draftBinding.draftKey,
    generation: generationRef.current,
    surface: props.surface,
    threadId: selectedThreadId
  };
  const changeComposerDraft = (action: Parameters<typeof draftBinding.changeDraft>[0]) =>
    callerDraft.apply(action, composerTarget, draftBinding.changeDraft);
  useEffect(() => saveChatDrafts(props.ownerId, drafts), [drafts, props.ownerId]);
  useEffect(() => {
    const threadId = confirmedSelection
      ? confirmedSelection.threadId
      : privacyStateQuery.data?.threadId;
    if (threadId && !transition.pending) {
      callerDraft.bind(threadId, props.surface, generationRef.current, Boolean(confirmedSelection));
    }
  }, [
    callerDraft,
    confirmedSelection,
    privacyStateQuery.data,
    privacyStateQuery.isSuccess,
    props.surface,
    transition.pending
  ]);
  useEffect(() => {
    if (
      !confirmedSelection ||
      confirmedSelection.threadId !== null ||
      !privacyStateQuery.isSuccess ||
      !privacyStateQuery.data.threadId ||
      privacyStateQuery.dataUpdatedAt <= confirmedSelection.confirmedAt
    ) {
      return;
    }
    selection.confirm(privacyStateQuery.data.threadId, {
      surface: props.surface,
      generation: generationRef.current
    });
  }, [
    confirmedSelection,
    privacyStateQuery.data,
    privacyStateQuery.dataUpdatedAt,
    privacyStateQuery.isSuccess,
    props.surface,
    selection
  ]);
  const sendMessage = useCallback(
    (text: string, attachments?: readonly ChatAttachmentDto[]): void => {
      const trimmed = text.trim();
      if (
        (!trimmed && !attachments?.length) ||
        sendPending ||
        privateEnded ||
        activatingPrivate ||
        moduleIdentityPending ||
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
      const initiatingThreadId = confirmedSelection?.threadId ?? reviewThreadId;
      callerDraft.dispatch(trimmed, initiatingSurface, generation);
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
          void queryClient.invalidateQueries({
            queryKey: queryKeys.chat.privacy(initiatingSurface)
          });
          if (reviewThreadId !== null) {
            void queryClient.invalidateQueries({
              queryKey: queryKeys.chat.messages(reviewThreadId, initiatingSurface)
            });
          }
          if (surfaceRef.current !== initiatingSurface || generation !== generationRef.current)
            return;
          if (initiatingThreadId === null) {
            void getChatPrivacyState(initiatingSurface)
              .then((state) => {
                if (
                  state.threadId &&
                  surfaceRef.current === initiatingSurface &&
                  generation === generationRef.current
                ) {
                  selection.confirm(state.threadId, { surface: initiatingSurface, generation });
                }
              })
              .catch(() => undefined);
          }
          callerDraft.retire(initiatingSurface, generation);
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
      moduleIdentityPending,
      sendPending,
      messagesQuery.data?.messages,
      confirmedSelection?.threadId,
      privateEnded,
      queryClient,
      reviewThreadId,
      props.surface,
      props.meetingContext,
      props.onMeetingUnavailable
    ]
  );
  useEffect(() => {
    if (sendPending || moduleIdentityPending || queuedSendText === null) return;
    const queued = queuedSendText;
    setQueuedSendText(null);
    if (queued.surface !== props.surface) return;
    sendMessage(queued.text);
  }, [moduleIdentityPending, queuedSendText, sendPending, props.surface, sendMessage]);
  const reviewing = reviewThreadId !== null;
  const persistedRecords = reviewing ? recordsFromMessages(messagesQuery.data?.messages ?? []) : [];

  // A side chat started here shows its stored history plus the live turn not yet stored. A
  // reopened thread shows stored history only, so the previous thread's stream never shows under it.
  const liveTail =
    reviewing &&
    liveThreadId === reviewThreadId &&
    !historyActivationPending &&
    !props.meetingContext
      ? reconcileFallbacks(props.records, persistedRecords)
      : [];
  const displayRecords = reviewing ? [...persistedRecords, ...liveTail] : props.records;
  const visibleFallbackRecords = reconcileFallbacks(fallbackRecords, displayRecords);
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
  useEffect(() => {
    setStickToBottom(true);
    if (props.open) {
      scrollToLatest("auto");
    }
  }, [reviewThreadId, props.open, scrollToLatest]);
  useEffect(() => {
    if (stickToBottom) {
      scrollToLatest("auto");
    }
  }, [effectiveRecords.length, isWaiting, reviewThreadId, scrollToLatest, stickToBottom]);
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
  if (!props.open) return null;
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
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
    callerDraft.retire(change.surface);
    void (async () => {
      try {
        await clearChat({ surface: change.surface });
        const state = await getChatPrivacyState(change.surface);
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(change.surface) });
        if (!transition.isCurrent(change)) return;
        selection.confirm(state.threadId ?? null, change);
        if (state.threadId)
          callerDraft.bind(state.threadId, change.surface, change.generation, true);
        setReviewThreadId(state.threadId ?? null);
        setLiveThreadId(state.threadId ?? null);
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
          callerDraft.retire(change.surface, change.generation);
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
    callerDraft.retire(change.surface);
    setReviewThreadId(null);
    setLiveThreadId(null);
    setIsSending(false);
    setSendError(null);
    setNeedsProvider(false);
    setQueuedSendText(null);
    setPendingUser(null);
    setPrivateEnded(false);
    setPrivateActivationError(null);
    setActivatingPrivate(true);
    setDrafts(({ [PRIVATE_DRAFT_KEY]: _privateDraft, ...persistentDrafts }) => persistentDrafts);
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
  const stopSending = (): void => void cancelChatTurn(props.surface).catch(() => {});
  const queueSend = (text: string): void => {
    if (moduleIdentityPending) return;
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
        <div
          className="chatd-overlay-background"
          inert={conversationOverlayOpen ? true : undefined}
        >
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
        </div>
        <SideChatOverlay
          key={props.surface}
          disabled={transition.pending}
          open={conversationOverlayOpen}
          ownerId={props.ownerId}
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
            callerDraft.retire(props.surface);
            if (isSending) void cancelChatTurn(props.surface);
            setFallbackRecords([]);
            setPendingUser(null);
            setIsSending(false);
            setQueuedSendText(null);
            setSendError(null);
            setReviewThreadId(id);
            setLiveThreadId(null);
            if (change) {
              resumeMutation.mutate({ threadId: id, surface: props.surface, transition: change });
            }
          }}
        />
        <div
          className="chatd-overlay-background"
          inert={conversationOverlayOpen ? true : undefined}
        >
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
      </div>
      {props.meetingContext ? (
        <div className="chatd__head" inert={conversationOverlayOpen ? true : undefined}>
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
          {moduleIdentityPending && privacyStateQuery.isError ? (
            <div className="chatd-empty" role="alert">
              <div className="chatd-empty__title">Could not load module conversation.</div>
              <Button
                aria-label="Retry conversation identity"
                size="sm"
                type="button"
                variant="quiet"
                onClick={() => void privacyStateQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : null}
          {messagesQuery.isError ? (
            <div className="chatd-empty" role="alert">
              <div className="chatd-empty__title">Could not load conversation.</div>
              <Button
                aria-label="Retry conversation"
                size="sm"
                type="button"
                variant="quiet"
                onClick={() => void messagesQuery.refetch()}
              >
                Retry
              </Button>
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
            inert={conversationOverlayOpen ? true : undefined}
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
      <div className="chatd-overlay-background" inert={conversationOverlayOpen ? true : undefined}>
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
            moduleIdentityPending ||
            historyActivationPending ||
            (transition.pending && !activatingPrivate) ||
            (Boolean(props.meetingContext) && reviewing)
          }
          isFounder={props.isFounder}
          initialText={visibleCallerDraft || undefined}
          draft={visibleCallerDraft || drafts[draftBinding.draftKey] || ""}
          onDraftChange={changeComposerDraft}
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
      </div>
    </aside>
  );
}
export function chatAvailableFromRoute(data: LookupAiCapabilityRouteResponse | undefined): boolean {
  return data?.route?.available === true;
}
