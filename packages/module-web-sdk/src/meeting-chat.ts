/** Browser-safe host bridge. Opening a meeting never submits a turn. */
export interface OpenMeetingChatInput {
  readonly meetingId: string;
  readonly title: string;
}
export interface MeetingChatActions {
  readonly clearMeetingChat: (meetingId: string) => void;
  readonly openMeetingChat: (input: OpenMeetingChatInput) => void;
}
const unavailable: MeetingChatActions = { openMeetingChat: () => {}, clearMeetingChat: () => {} };
let useHostMeetingChat: () => MeetingChatActions = () => unavailable;
/** Host-only registration, once at module load, like the page-trail bridge. */
export function setMeetingChatHook(hook: () => MeetingChatActions): void {
  useHostMeetingChat = hook;
}
export function useMeetingChat(): MeetingChatActions {
  return useHostMeetingChat();
}
export function validMeetingChatInput(input: unknown): input is OpenMeetingChatInput {
  if (!input || typeof input !== "object") return false;
  const value = input as Partial<OpenMeetingChatInput>;
  return (
    typeof value.meetingId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.meetingId) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    value.title.length <= 300
  );
}
