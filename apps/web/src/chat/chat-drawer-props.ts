import type { ChatSurface, MeetingChatSelection } from "@moss/shared";
import type { TranscriptRecord } from "./use-chat-stream";

export interface ChatDrawerProps {
  readonly meetingContext?: MeetingChatSelection & { readonly title: string };
  readonly onMeetingUnavailable?: () => void;
  readonly onRemoveMeetingContext?: () => void;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly records: readonly TranscriptRecord[];
  readonly clearRecords: (mainThreadId?: string) => void;
  readonly streamErrorCount: number;
  readonly selectionPending?: boolean;
  readonly isFounder: boolean;
  readonly ownerId?: string;
  readonly unreadByThread?: Readonly<Record<string, number>>;
  readonly initialText?: string;
  readonly threadToOpen?: string | null;
  readonly onThreadOpenConsumed?: () => void;
  readonly focusActionRequestId?: string | null;
  readonly onActionRequestFocused?: () => void;
  readonly surface: ChatSurface;
  readonly docked?: boolean;
  readonly expanded?: boolean;
  readonly onToggleExpanded?: () => void;
}
