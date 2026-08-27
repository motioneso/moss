import type {
  ConfirmNewsSourceRequest,
  ConnectNewsCredentialedSourceRequest,
  ConnectNewsCredentialedSourceResponse,
  ConfirmNewsSourceResponse,
  CreateNewsPrefRequest,
  CreateNewsSourceExclusionRequest,
  CreateNewsSourceExclusionResponse,
  CreateNewsTopicRequest,
  CreateNewsTopicResponse,
  DeleteNewsCustomSourceResponse,
  DeleteNewsSourceExclusionResponse,
  DeleteNewsTopicResponse,
  GetNewsPersonalizationResponse,
  NewsCatalogResponse,
  NewsOverviewResponse,
  NewsPrefDto,
  NewsPrefsResponse,
  NewsSourceCredentialResponse,
  NewsSourceCredentialsResponse,
  NewsSourcePreviewRequest,
  NewsSourcePreviewResponse,
  ReplaceNewsSourceCredentialRequest,
  TriggerNewsRevalidationResponse,
  UpdateNewsTopicRequest,
  UpdateNewsTopicResponse
} from "@moss/shared";

import { requestJson } from "@moss/module-web-sdk";

export async function getNewsOverview(): Promise<NewsOverviewResponse> {
  return requestJson<NewsOverviewResponse>("/api/news/overview");
}

export async function getNewsCatalog(): Promise<NewsCatalogResponse> {
  return requestJson<NewsCatalogResponse>("/api/news/catalog");
}

export async function listNewsPrefs(): Promise<NewsPrefsResponse> {
  return requestJson<NewsPrefsResponse>("/api/news/prefs");
}

export async function createNewsPref(input: CreateNewsPrefRequest): Promise<{ pref: NewsPrefDto }> {
  return requestJson<{ pref: NewsPrefDto }>("/api/news/prefs", {
    method: "POST",
    body: input
  });
}

export async function deleteNewsPref(id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/news/prefs/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

// --- #953 personalization (Slice 1: reads + exclusion writes only) ----------

export async function getNewsPersonalization(): Promise<GetNewsPersonalizationResponse> {
  return requestJson<GetNewsPersonalizationResponse>("/api/news/personalization");
}

export async function createNewsSourceExclusion(
  input: CreateNewsSourceExclusionRequest
): Promise<CreateNewsSourceExclusionResponse> {
  return requestJson<CreateNewsSourceExclusionResponse>("/api/news/source-exclusions", {
    method: "POST",
    body: input
  });
}

export async function deleteNewsSourceExclusion(
  id: string
): Promise<DeleteNewsSourceExclusionResponse> {
  return requestJson<DeleteNewsSourceExclusionResponse>(
    `/api/news/source-exclusions/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

// --- #975 Slice 4 (Task 9): custom source/topic writes + revalidation retry --------------

export async function previewNewsSource(
  input: NewsSourcePreviewRequest
): Promise<NewsSourcePreviewResponse> {
  return requestJson<NewsSourcePreviewResponse>("/api/news/sources/preview", {
    method: "POST",
    body: input
  });
}

export async function confirmNewsSource(
  input: ConfirmNewsSourceRequest
): Promise<ConfirmNewsSourceResponse> {
  return requestJson<ConfirmNewsSourceResponse>("/api/news/sources", {
    method: "POST",
    body: input
  });
}

export async function deleteNewsCustomSource(id: string): Promise<DeleteNewsCustomSourceResponse> {
  return requestJson<DeleteNewsCustomSourceResponse>(
    `/api/news/sources/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

export async function createNewsTopic(
  input: CreateNewsTopicRequest
): Promise<CreateNewsTopicResponse> {
  return requestJson<CreateNewsTopicResponse>("/api/news/topics", {
    method: "POST",
    body: input
  });
}

export async function deleteNewsTopic(id: string): Promise<DeleteNewsTopicResponse> {
  return requestJson<DeleteNewsTopicResponse>(`/api/news/topics/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function updateNewsTopic(
  id: string,
  input: UpdateNewsTopicRequest
): Promise<UpdateNewsTopicResponse> {
  return requestJson<UpdateNewsTopicResponse>(`/api/news/topics/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input
  });
}

export async function triggerNewsRevalidation(): Promise<TriggerNewsRevalidationResponse> {
  return requestJson<TriggerNewsRevalidationResponse>("/api/news/revalidation", {
    method: "POST"
  });
}

// #2008 publisher credentials.
//
// SECURITY: the three write wrappers below take the key as a plain argument and hand it
// straight to the request body. None of them returns it, caches it, or logs it, and the key
// never appears in a URL - which is why the source id, not the key, is what gets interpolated
// into these paths. Paths mirror packages/news/src/manifest.ts.

export async function connectCredentialedNewsSource(
  input: ConnectNewsCredentialedSourceRequest
): Promise<ConnectNewsCredentialedSourceResponse> {
  return requestJson<ConnectNewsCredentialedSourceResponse>("/api/news/sources/credentialed", {
    method: "POST",
    body: input
  });
}

export async function replaceNewsSourceCredential(
  sourceId: string,
  input: ReplaceNewsSourceCredentialRequest
): Promise<NewsSourceCredentialResponse> {
  return requestJson<NewsSourceCredentialResponse>(
    `/api/news/sources/${encodeURIComponent(sourceId)}/credential`,
    { method: "POST", body: input }
  );
}

export async function revokeNewsSourceCredential(
  sourceId: string
): Promise<NewsSourceCredentialResponse> {
  return requestJson<NewsSourceCredentialResponse>(
    `/api/news/sources/${encodeURIComponent(sourceId)}/credential`,
    { method: "DELETE" }
  );
}

export async function listNewsSourceCredentials(): Promise<NewsSourceCredentialsResponse> {
  return requestJson<NewsSourceCredentialsResponse>("/api/news/credentials");
}
