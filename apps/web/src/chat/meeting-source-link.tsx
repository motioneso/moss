import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { requestJson } from "@moss/module-web-sdk";
import type { AnswerSourceSupportCard, MeetingChatCoverage } from "@moss/shared";

export function meetingCoverageLabel(coverage: MeetingChatCoverage): string {
  const time = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return `Cutoff ${time(coverage.cutoffMs)} · ${coverage.throughMs === null ? "No transcript evidence" : `Latest included ${time(coverage.throughMs)}`} · Revision ${coverage.transcriptRevision}${coverage.containsProvisional ? " · Includes provisional text" : ""}${coverage.omittedSegments > 0 ? " · Partial context" : ""}`;
}

/** Follow only an exact transcript route returned by the authorized provenance endpoint. */
export function validMeetingEvidencePath(path: unknown): path is string {
  if (typeof path !== "string" || !path.startsWith("/meetings?")) return false;
  const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const revision = Number(query.get("segmentRevision"));
  const start = Number(query.get("startCharacter"));
  const end = Number(query.get("endCharacter"));
  return (
    uuid.test(query.get("id") ?? "") &&
    uuid.test(query.get("segmentId") ?? "") &&
    ["segmentRevision", "startCharacter", "endCharacter"].every(
      (key) => query.getAll(key).length === 1 && /^\d+$/.test(query.get(key) ?? "")
    ) &&
    [revision, start, end].every(Number.isSafeInteger) &&
    revision > 0 &&
    end > start
  );
}

export function MeetingSourceLink(props: {
  readonly card: AnswerSourceSupportCard;
  readonly messageId?: string;
}) {
  const navigate = useNavigate();
  const [state, setState] = useState<"ready" | "loading" | "unavailable">("ready");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const open = async () => {
    if (!props.messageId || !props.card.canDereference) {
      setState("unavailable");
      return;
    }
    setState("loading");
    try {
      const result = await requestJson<{ deepLinkPath?: string; unavailableReason?: string }>(
        `/api/chat/messages/${encodeURIComponent(props.messageId)}/provenance/${encodeURIComponent(props.card.supportId)}/dereference`
      );
      if (!active.current) return;
      if (result.unavailableReason || !validMeetingEvidencePath(result.deepLinkPath)) {
        setState("unavailable");
        return;
      }
      setState("ready");
      navigate(result.deepLinkPath);
    } catch {
      if (active.current) setState("unavailable");
    }
  };
  return (
    <button
      type="button"
      role="listitem"
      className="source-chip"
      disabled={state === "loading"}
      onClick={() => void open()}
      aria-label={
        state === "unavailable"
          ? "Source unavailable"
          : `Open transcript at ${props.card.sourceLabel}`
      }
    >
      {state === "unavailable"
        ? "Source unavailable"
        : state === "loading"
          ? "Opening source…"
          : props.card.sourceLabel}
    </button>
  );
}
