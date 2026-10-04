import { setMeetingChatHook, type OpenMeetingChatInput } from "@moss/module-web-sdk";
import { createContext, useContext } from "react";

export interface ChatControls {
  readonly clearMeetingChat?: (meetingId: string) => void;
  readonly openMeetingChat?: (input: OpenMeetingChatInput) => void;
  /** Open the chat drawer without submitting a new user turn. */
  readonly openChat: () => void;
  /** Open the chat drawer and send `prompt` as a turn. */
  readonly openChatWith: (prompt: string) => void;
  /**
   * #916 — open the drawer with a module-authored `draft` as an EDITABLE composer draft. Never
   * auto-sends; the user reviews and submits. Distinct from `openChatWith`, which auto-sends.
   */
  readonly openAssistantWithDraft: (draft: string) => void;
  readonly pendingNotesDelete?: {
    readonly actionRequestId: string;
    readonly summary: string;
  } | null;
  readonly openActionRequest?: (actionRequestId: string) => void;
}

const ChatControlsContext = createContext<ChatControls | null>(null);

export const ChatControlsProvider = ChatControlsContext.Provider;

export function useChatControls(): ChatControls {
  const ctx = useContext(ChatControlsContext);
  if (!ctx) {
    throw new Error("useChatControls must be used within ChatControlsProvider");
  }
  return ctx;
}

setMeetingChatHook(() => {
  const controls = useChatControls();
  return {
    openMeetingChat: (input) => controls.openMeetingChat?.(input),
    clearMeetingChat: (meetingId) => controls.clearMeetingChat?.(meetingId)
  };
});
