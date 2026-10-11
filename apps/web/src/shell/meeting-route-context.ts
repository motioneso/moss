import { validMeetingChatInput } from "@moss/module-web-sdk";

/** Only an actual meeting route creates context; arbitrary query strings never select a meeting. */
export function meetingIdOnRoute(pathname: string, search: string): string | null {
  if (pathname !== "/meetings") return null;
  const params = new URLSearchParams(search);
  if (params.getAll("id").length !== 1) return null;
  const meetingId = params.get("id");
  return validMeetingChatInput({ meetingId, title: "About this meeting" }) ? meetingId : null;
}
