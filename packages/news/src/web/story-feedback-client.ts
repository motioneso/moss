import type {
  CreateUsefulnessFeedbackResponse,
  ListUsefulnessFeedbackResponse,
  UpdateUsefulnessFeedbackReasonRequest
} from "@moss/shared";

import { requestJson } from "@moss/module-web-sdk";

export async function listNewsStoryFeedback(): Promise<ListUsefulnessFeedbackResponse> {
  return requestJson<ListUsefulnessFeedbackResponse>("/api/me/usefulness-feedback?module=news");
}

export async function createNewsStoryFeedback(input: {
  readonly targetRef: string;
  readonly surface: "news" | "today";
  readonly kind: "more_like_this" | "less_like_this";
  readonly reason?: string;
}): Promise<CreateUsefulnessFeedbackResponse> {
  return requestJson<CreateUsefulnessFeedbackResponse>("/api/me/usefulness-feedback", {
    method: "POST",
    body: { targetKind: "news_story", ...input }
  });
}

export async function updateNewsStoryFeedback(
  id: string,
  input: UpdateUsefulnessFeedbackReasonRequest
): Promise<CreateUsefulnessFeedbackResponse> {
  return requestJson<CreateUsefulnessFeedbackResponse>(
    `/api/me/usefulness-feedback/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input }
  );
}

export async function removeNewsStoryFeedback(
  id: string
): Promise<CreateUsefulnessFeedbackResponse> {
  return requestJson<CreateUsefulnessFeedbackResponse>(
    `/api/me/usefulness-feedback/${encodeURIComponent(id)}/undo`,
    { method: "POST" }
  );
}
