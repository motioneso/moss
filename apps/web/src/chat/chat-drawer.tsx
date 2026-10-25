import { VoiceInputThread } from "./voice-requests";
import type { ChatDrawerProps } from "./chat-drawer-props";
import { randomUuid, requestJson } from "@moss/module-web-sdk";
import type { MeetingChatTurnResponse } from "@moss/shared";
import { findOwnerMainThread, SideChatOverlay } from "./side-chat-overlay";
import { loadChatDrafts, saveChatDrafts } from "./chat-draft-storage";
import { shownMainThread } from "./drawer-main-landing";
import { useChatTransition, type ChatTransition } from "./use-chat-transition";
import { useInitialCallerDraft } from "./use-initial-caller-draft";
import { useChatSelectionConfirmation } from "./use-chat-selection-confirmation";
import { useChatDraftBinding } from "./use-chat-draft-binding";
import { useChatAutoscroll } from "./use-chat-autoscroll";
import { useReadChatMessages } from "./use-chat-unread";
import { usePhoneLayout } from "./use-phone-layout";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Maximize2, Minimize2, MoreHorizontal, ShieldOff, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
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
  resumeChat,
  sendChatTurn
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name.js";
import { DEFAULT_CHAT_SURFACE, type ChatAttachmentDto, type ChatSurface } from "@moss/shared";
import { ChatModelPill } from "./chat-model-pill";
import { ChatWaitingIndicator } from "./chat-waiting-indicator";
import { ChatPrivateStatus } from "./chat-private-status";
import { ChatConversationError, ChatEmptyState } from "./chat-empty-state";
import { Composer } from "./composer";
import { ConnectProviderEmpty } from "./connect-provider-empty";
import { useChatRoute } from "./use-chat-route";
import { trapFocus } from "../shell/command-palette";
import { RecordRow } from "./message-row";
import { isNoActiveChatModelError } from "../onboarding/chat-availability";
import {
  mergeFallbacks,
  reconcileFallbacks,
  recordsFromMessages,
  shouldEndPrivateChatOnStreamDisconnect,
  type TranscriptRecord
} from "./use-chat-stream";
export { recordsFromMessages } from "./use-chat-stream";
import "../styles/kit-chat.css";
import "../styles/kit-chat-attach.css";
import "../styles/kit-chat-skills.css";
const PRIVATE_DRAFT_KEY = "__private__";
export function ChatDrawer(props: ChatDrawerProps) {
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
  const {
    bodyRef,
    stickToBottom,
    setStickToBottom,
    handleBodyScroll,
    scrollToLatest,
    jumpToLatest
  } = useChatAutoscroll();
  const { mutate: resume, isPending: resumePending } = useMutation({
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
      props.clearRecords(vars.threadId);
      if (vars.threadId === mainThreadId) setLiveThreadId(vars.threadId);
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

  const { lockedModelUnavailable, chatUnavailable, rechecking } = useChatRoute(props.open);
  const noModelAvailable = chatUnavailable && !lockedModelUnavailable && !rechecking;
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
    reviewThreadId !== null && (resumePending || !messagesQuery.isSuccess);
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
    (text: string, attachments?: readonly ChatAttachmentDto[]): boolean => {
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
        return false;
      }
      const initiatingThreadId = confirmedSelection?.threadId ?? reviewThreadId;
      if (reviewThreadId !== null) {
        const persisted = recordsFromMessages(messagesQuery.data?.messages ?? []);
        setFallbackRecords((current) => {
          const arrivals = [...props.records, ...reconcileFallbacks(current, props.records)].filter(
            (record) => record.background && record.backgroundThreadId === initiatingThreadId
          );
          return [...persisted, ...reconcileFallbacks(arrivals, persisted)];
        });
      }
      setSendError(null);
      setNeedsProvider(false);
      setIsSending(true);
      setPendingUser({ text: trimmed, attachments });
      const initiatingSurface = props.surface;
      const generation = generationRef.current;
      if (initiatingThreadId !== null && liveThreadId !== initiatingThreadId) {
        props.clearRecords(initiatingThreadId);
        setLiveThreadId(initiatingThreadId);
      }
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
                  // The first turn can create Main after startup hydrated an empty account.
                  props.clearRecords(state.threadId);
                  setLiveThreadId(state.threadId);
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
              // Send time on this device, so a ring receipt can be ordered against the turn.
              createdAt: new Date().toISOString(),
              attachments,
              ...("meetingContext" in result ? { meetingContext: result.meetingContext } : {})
            },
            {
              kind: "reply",
              text: result.reply,
              messageId: result.assistantMessageId,
              visualReply: "visualReply" in result ? result.visualReply : undefined,
              visualFallbackText:
                "visualFallbackText" in result ? result.visualFallbackText : undefined,
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
          // Keep saved IDs for read receipts; display reconciliation removes stream duplicates.
          setFallbackRecords((current) => [...current, ...postResponseRecords]);
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
      return true;
    },
    [
      activatingPrivate,
      historyActivationPending,
      moduleIdentityPending,
      sendPending,
      messagesQuery.data?.messages,
      confirmedSelection?.threadId,
      liveThreadId,
      props.clearRecords,
      props.records,
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

  // Reopened chats accept only background arrivals for their confirmed destination.
  // The previous chat's live turn stays hidden until a new live thread is bound.
  const liveTail =
    reviewing && !historyActivationPending && !props.meetingContext
      ? reconcileFallbacks(
          liveThreadId === reviewThreadId
            ? props.records
            : props.records.filter(
                (record) =>
                  confirmedSelection?.threadId === reviewThreadId &&
                  record.background &&
                  record.backgroundThreadId === reviewThreadId
              ),
          persistedRecords
        )
      : [];
  const displayRecords = reviewing ? [...persistedRecords, ...liveTail] : props.records;
  const effectiveRecords: readonly TranscriptRecord[] = [
    ...mergeFallbacks(fallbackRecords, displayRecords),
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
  useReadChatMessages({
    ownerId: props.ownerId,
    threadId: selectedThreadId,
    visible:
      props.open &&
      !props.meetingContext &&
      !conversationOverlayOpen &&
      !privateMode &&
      !privacyStateQuery.data?.incognito &&
      !historyActivationPending &&
      !props.selectionPending &&
      !transition.pending &&
      props.surface === DEFAULT_CHAT_SURFACE &&
      privacyStateQuery.isSuccess,
    records: [...effectiveRecords, ...fallbackRecords]
  });
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
  // Runs after the scroll-to-latest effects so a linked message wins the first scroll.
  const focusedMessageId = useRef<string | null>(null);
  useEffect(() => {
    const id = props.focusMessageId;
    if (!props.open || !id) {
      // The drawer stays mounted while closed, so a reopened link must focus again.
      focusedMessageId.current = null;
      return;
    }
    if (props.threadToOpen || focusedMessageId.current === id) return;
    const target = bodyRef.current?.querySelector<HTMLElement>("[data-linked-message]");
    if (!target) return;
    focusedMessageId.current = id;
    setStickToBottom(false);
    target.scrollIntoView({ block: "center" });
    target.focus();
  }, [
    effectiveRecords,
    props.open,
    props.focusMessageId,
    props.threadToOpen,
    bodyRef,
    setStickToBottom
  ]);
  const asideRef = useRef<HTMLElement | null>(null);
  const phone = usePhoneLayout();
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
  const selectThread = useCallback(
    (id: string) => {
      const change = props.meetingContext ? undefined : transition.begin();
      if (!props.meetingContext && !change) return;
      callerDraft.retire(props.surface);
      if (isSending) void cancelChatTurn(props.surface);
      setFallbackRecords([]);
      setPendingUser(null);
      setIsSending(false);
      setQueuedSendText(null);
      setSendError(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chat.messages(id, props.surface)
      });
      setReviewThreadId(id);
      setLiveThreadId(null);
      if (change) {
        resume({ threadId: id, surface: props.surface, transition: change });
      }
    },
    [props.meetingContext, props.surface, transition, callerDraft, isSending, resume, queryClient]
  );
  useEffect(() => {
    if (!props.open || !props.threadToOpen || transition.pending) return;
    props.onThreadOpenConsumed?.();
    selectThread(props.threadToOpen);
  }, [
    props.open,
    props.threadToOpen,
    props.onThreadOpenConsumed,
    transition.pending,
    selectThread
  ]);

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
        props.clearRecords(state.threadId);
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
        const landedOnMain = await shownMainThread(initiatingSurface, mainThreadId);
        if (!transition.isCurrent(change)) return;
        props.clearRecords(landedOnMain);
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
            <div
              className={`chatd__status${chatUnavailable && !rechecking ? " chatd__status--offline" : ""}`}
            >
              {rechecking
                ? "Checking connection"
                : lockedModelUnavailable && chatUnavailable
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
          unreadByThread={props.unreadByThread}
          selectedThreadId={selectedThreadId}
          threads={threadsQuery.data?.threads ?? []}
          loading={threadsQuery.isPending}
          error={threadsQuery.isError}
          onRetry={() => void threadsQuery.refetch()}
          onNewSideChat={startNewSideChat}
          onOpenChange={setConversationOverlayOpen}
          onSelect={selectThread}
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
          <ChatPrivateStatus
            activating={activatingPrivate}
            error={privateActivationError}
            active={privateMode && !reviewing}
            ended={privateEnded}
            onDismissError={() => setPrivateActivationError(null)}
            onEnd={closePrivateChat}
          />
          {moduleIdentityPending && privacyStateQuery.isError ? (
            <ChatConversationError
              moduleConversation
              onRetry={() => void privacyStateQuery.refetch()}
            />
          ) : null}
          {messagesQuery.isError ? (
            <ChatConversationError onRetry={() => void messagesQuery.refetch()} />
          ) : null}
          <VoiceInputThread
            ownerId={props.ownerId}
            surface={props.surface}
            mainThreadId={mainThreadId}
            selectedThreadId={selectedThreadId}
            privateMode={
              privateMode ||
              Boolean(privacyStateQuery.data?.incognito) ||
              Boolean(props.meetingContext)
            }
            selectionPending={
              transition.pending ||
              Boolean(props.selectionPending) ||
              historyActivationPending ||
              conversationOverlayOpen ||
              activatingPrivate ||
              privacyStateQuery.isFetching
            }
            privacyConfirmed={privacyStateQuery.isSuccess}
            records={effectiveRecords}
            working={isWaiting}
            renderRecord={(record, _index, context) => (
              <RecordRow
                approvalOutcomeShown={context.approvalOutcomeShown}
                record={record}
                meetingScoped={Boolean(props.meetingContext)}
                focusActionRequestId={props.focusActionRequestId}
                onActionRequestFocused={props.onActionRequestFocused}
                linkedMessageId={props.focusMessageId}
              />
            )}
          >
            {rechecking ? (
              <div className="chatd-empty" aria-busy="true" />
            ) : noModelAvailable ? (
              <ConnectProviderEmpty isFounder={props.isFounder} />
            ) : props.meetingContext ? (
              <div className="chatd-empty">
                <div className="chatd-empty__title">Ask about this meeting</div>
                <div className="chatd-empty__sub">
                  Ask about the transcript or your saved notes.
                </div>
              </div>
            ) : (
              <ChatEmptyState
                onSend={sendMessage}
                isSending={isSending}
                lockedModelUnavailable={lockedModelUnavailable}
              />
            )}
          </VoiceInputThread>
          {isWaiting ? <ChatWaitingIndicator assistantName={assistantName} /> : null}
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
            rechecking ||
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
