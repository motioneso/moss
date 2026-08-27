import type {
  ConfirmSportsSourceRequest,
  ConfirmSportsSourceAssignmentsRequest,
  ConfirmSportsSourceRecipeRequest,
  ConfirmSportsSourceResponse,
  CreateUsefulnessFeedbackRequest,
  CreateUsefulnessFeedbackResponse,
  CreateSportsFollowRequest,
  ListUsefulnessFeedbackResponse,
  PreviewSportsSourceRequest,
  PreviewSportsSourceAssignmentsRequest,
  PreviewSportsSourceAssignmentsResponse,
  PreviewSportsSourceRecipeResponse,
  PreviewSportsSourceResponse,
  SportsCatalogResponse,
  SportsCustomSourceDto,
  SportsNewsSourcesResponse,
  SportsFollowDto,
  SportsFollowsResponse,
  SportsOverviewResponse,
  SportsStandingsResponse,
  UpdateUsefulnessFeedbackReasonRequest,
  UpdateSportsEspnCoverageRequest,
  UpdateSportsEspnCoverageResponse
} from "@moss/shared";

import { requestJson } from "@moss/module-web-sdk";

export async function getSportsOverview(): Promise<SportsOverviewResponse> {
  return requestJson<SportsOverviewResponse>("/api/sports/overview");
}

export async function getSportsCatalog(): Promise<SportsCatalogResponse> {
  return requestJson<SportsCatalogResponse>("/api/sports/catalog");
}

export async function listSportsFollows(): Promise<SportsFollowsResponse> {
  return requestJson<SportsFollowsResponse>("/api/sports/follows");
}

export async function getStandingsByLeague(
  competitionKey: string
): Promise<SportsStandingsResponse> {
  return requestJson<SportsStandingsResponse>(
    `/api/sports/standings?competitionKey=${encodeURIComponent(competitionKey)}`
  );
}

export async function createSportsFollow(
  input: CreateSportsFollowRequest
): Promise<{ follow: SportsFollowDto }> {
  return requestJson<{ follow: SportsFollowDto }>("/api/sports/follows", {
    method: "POST",
    body: input
  });
}

export async function deleteSportsFollow(id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/sports/follows/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function createSportsStoryFeedback(
  input: CreateUsefulnessFeedbackRequest
): Promise<CreateUsefulnessFeedbackResponse> {
  return requestJson<CreateUsefulnessFeedbackResponse>("/api/me/usefulness-feedback", {
    method: "POST",
    body: input
  });
}

export async function listSportsStoryFeedback(): Promise<ListUsefulnessFeedbackResponse> {
  return requestJson<ListUsefulnessFeedbackResponse>(
    "/api/me/usefulness-feedback?module=sports&status=active"
  );
}

export async function updateSportsStoryFeedbackReason(
  id: string,
  input: UpdateUsefulnessFeedbackReasonRequest
): Promise<CreateUsefulnessFeedbackResponse> {
  return requestJson<CreateUsefulnessFeedbackResponse>(
    `/api/me/usefulness-feedback/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input }
  );
}

export async function undoSportsStoryFeedback(
  id: string
): Promise<CreateUsefulnessFeedbackResponse> {
  return requestJson<CreateUsefulnessFeedbackResponse>(
    `/api/me/usefulness-feedback/${encodeURIComponent(id)}/undo`,
    { method: "POST" }
  );
}

// #1572: custom public news sources by team and league.

export async function listSportsSources(): Promise<SportsNewsSourcesResponse> {
  return requestJson<SportsNewsSourcesResponse>("/api/sports/sources");
}

export async function updateSportsEspnCoverage(
  input: UpdateSportsEspnCoverageRequest
): Promise<UpdateSportsEspnCoverageResponse> {
  return requestJson<UpdateSportsEspnCoverageResponse>("/api/sports/sources/espn/coverage", {
    method: "PUT",
    body: input
  });
}

export async function previewSportsSource(
  input: PreviewSportsSourceRequest
): Promise<PreviewSportsSourceResponse> {
  return requestJson<PreviewSportsSourceResponse>("/api/sports/sources/preview", {
    method: "POST",
    body: input
  });
}

export async function confirmSportsSource(
  input: ConfirmSportsSourceRequest
): Promise<ConfirmSportsSourceResponse> {
  return requestJson<ConfirmSportsSourceResponse>("/api/sports/sources", {
    method: "POST",
    body: input
  });
}

export async function previewSportsSourceAssignments(
  id: string,
  input: PreviewSportsSourceAssignmentsRequest
): Promise<PreviewSportsSourceAssignmentsResponse> {
  return requestJson<PreviewSportsSourceAssignmentsResponse>(
    `/api/sports/sources/${encodeURIComponent(id)}/assignments/preview`,
    { method: "POST", body: input }
  );
}

export async function confirmSportsSourceAssignments(
  id: string,
  input: ConfirmSportsSourceAssignmentsRequest
): Promise<{ source: SportsCustomSourceDto }> {
  return requestJson<{ source: SportsCustomSourceDto }>(
    `/api/sports/sources/${encodeURIComponent(id)}/assignments`,
    { method: "PATCH", body: input }
  );
}

export async function retrySportsSource(id: string): Promise<{ source: SportsCustomSourceDto }> {
  return requestJson<{ source: SportsCustomSourceDto }>(
    `/api/sports/sources/${encodeURIComponent(id)}/retry`,
    { method: "POST" }
  );
}

export async function previewSportsSourceRecipe(
  id: string
): Promise<PreviewSportsSourceRecipeResponse> {
  return requestJson<PreviewSportsSourceRecipeResponse>(
    `/api/sports/sources/${encodeURIComponent(id)}/rebuild/preview`,
    { method: "POST" }
  );
}

export async function confirmSportsSourceRecipe(
  id: string,
  input: ConfirmSportsSourceRecipeRequest
): Promise<{ source: SportsCustomSourceDto }> {
  return requestJson<{ source: SportsCustomSourceDto }>(
    `/api/sports/sources/${encodeURIComponent(id)}/rebuild`,
    { method: "PATCH", body: input }
  );
}

export async function deleteSportsSource(id: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`/api/sports/sources/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}
