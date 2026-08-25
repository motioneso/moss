import type { MossGoal } from "@moss/goals";
import type {
  AddTaskActivityRequest,
  AssignTaskTagRequest,
  AiAssistantActionDto,
  CreateAiConfiguredModelRequest,
  CreateAiConfiguredModelResponse,
  CreateAiProviderConfigRequest,
  CreateAiProviderConfigResponse,
  AiDiscoverModelsResponse,
  DiscoverAiProviderModelsResponse,
  AddTaskActivityResponse,
  AiModelCapability,
  AiServiceKey,
  BootstrapStatusResponse,
  ChatSkillResponse,
  CreateChatSkillRequest,
  ListChatSkillsResponse,
  SetChatSkillEnabledRequest,
  UpdateChatSkillRequest,
  GetChatPrivacyStateResponse,
  GetChatSettingsResponse,
  GetPersonaSettingsResponse,
  GetChatModelOverrideSettingsResponse,
  GetWebSearchKeyResponse,
  PutWebSearchKeyRequest,
  PutWebSearchKeyResponse,
  PutYoloSelfRequest,
  PutYoloInstanceRequest,
  PutYoloUserRequest,
  DeleteWebSearchKeyResponse,
  GetLocaleSettingsResponse,
  GetNotificationDigestPreferenceResponse,
  ListNotificationPreferencesResponse,
  GetQuietHoursSettingsResponse,
  GetAiSummaryResponse,
  ListMySessionsResponse,
  RevokeMyOtherSessionsResponse,
  RevokeMySessionResponse,
  PreviewPersonaRequest,
  ListAiServiceBindingsResponse,
  PutAiServiceBindingRequest,
  PutAiServiceBindingResponse,
  GetVoiceEndpointResponse,
  PutVoiceEndpointRequest,
  PutVoiceEndpointResponse,
  GetModuleRegistryResponse,
  ModuleRegistryRowDto,
  PreviewPersonaResponse,
  PutChatSettingsRequest,
  PutChatSettingsResponse,
  PutAdminChatModelOverrideRequest,
  PutChatModelOverrideRequest,
  PutLocaleSettingsRequest,
  PutLocaleSettingsResponse,
  PutNotificationPreferenceRequest,
  PutNotificationPreferenceResponse,
  PutNotificationDigestPreferenceRequest,
  PutNotificationDigestPreferenceResponse,
  PutQuietHoursSettingsRequest,
  PutQuietHoursSettingsResponse,
  PutPersonaSettingsRequest,
  PutPersonaSettingsResponse,
  PutSourceBehaviorRequest,
  PutSourceBehaviorResponse,
  BreakdownTaskRequest,
  BreakdownTaskResponse,
  CreateBriefingDefinitionRequest,
  CreateBriefingDefinitionResponse,
  CreateCheckinRequest,
  CreateCheckinResponse,
  CreateMedicationLogRequest,
  CreateMedicationLogResponse,
  CreateMedicationRequest,
  CreateTaskTagRequest,
  CreateTaskTagResponse,
  GetTaskPreferencesResponse,
  GoogleAuthorizeRequest,
  GoogleAuthorizeResponse,
  GoogleCompleteRequest,
  GoogleCompleteResponse,
  ImapConnectRequest,
  ImapTestResult,
  CreateConnectorAccountResponse,
  InterpretTaskSearchRequest,
  InterpretTaskSearchResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  GetTaskResponse,
  ListAiAssistantToolsResponse,
  ListAiConfiguredModelsResponse,
  ListAiProviderConfigsResponse,
  ListBriefingDefinitionsResponse,
  ListBriefingRunsResponse,
  ListCalendarEventsResponse,
  ListCheckinsResponse,
  ListChatThreadMessagesResponse,
  ListChatThreadsResponse,
  ChatSurface,
  SeedChatRequest,
  SendChatTurnResponse,
  UploadChatAttachmentResponse,
  ListConnectorAccountsResponse,
  ListMedicationsResponse,
  ListAdminModulesResponse,
  ExternalModuleDto,
  ListExternalModulesResponse,
  ListModuleCredentialsResponse,
  ListModulesResponse,
  ListModulePreferencesResponse,
  ListMyModulesResponse,
  ModulePreferenceValue,
  UpdateModulePreferencesResponse,
  ListSourceBehaviorsResponse,
  ModuleCredentialStatusDto,
  MyModuleDto,
  ListNotificationsResponse,
  ListTaskActivityResponse,
  ListTaskListsResponse,
  ListTaskTagsResponse,
  ListTasksResponse,
  MarkAllNotificationsReadResponse,
  MarkNotificationReadResponse,
  MedicationResponse,
  MedicationScheduleResponse,
  MeResponse,
  OnboardingStatusResponse,
  PageContextSnapshotDto,
  OnboardingCompleteResponse,
  RevokeAiProviderConfigResponse,
  RevokeConnectorAccountResponse,
  GetTerminalStatusResponse,
  SetTerminalPasswordResponse,
  RequestTerminalTicketResponse,
  TestAiProviderConfigResponse,
  LookupAiCapabilityRouteResponse,
  TranscribeAudioResponse,
  UpdateBriefingDefinitionRequest,
  UpdateBriefingDefinitionResponse,
  UpdateAiConfiguredModelRequest,
  UpdateAiConfiguredModelResponse,
  UpdateAiProviderConfigRequest,
  UpdateAiProviderConfigResponse,
  UpdateMedicationRequest,
  UpdateTaskPreferencesRequest,
  UpdateTaskPreferencesResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
  MedicationAdherenceSummaryResponse,
  UpdateCheckinRequest,
  UpdateCheckinResponse,
  WellnessInsightsResponse,
  ListTherapyNotesResponse,
  CreateTherapyNoteRequest,
  CreateTherapyNoteResponse,
  DeleteTherapyNoteResponse,
  DeleteCustomThemeResponse,
  PutColorModeRequest,
  ListThemesResponse,
  PatchMeProfileRequest,
  PutActiveThemeRequest,
  PutCustomThemeRequest,
  PutCustomThemeResponse,
  ListActionAuditLogResponse,
  YoloSettingsResponse,
  YoloAdminSettingsResponse
} from "@moss/shared";

export interface SignUpEmailRequest {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export interface SignInEmailRequest {
  readonly email: string;
  readonly password: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

interface ApiRequestOptions extends Omit<RequestInit, "body" | "headers"> {
  readonly body?: unknown;
  readonly headers?: HeadersInit;
}

export async function getBootstrapStatus(): Promise<BootstrapStatusResponse> {
  return requestJson<BootstrapStatusResponse>("/api/bootstrap/status");
}

export async function getMe(): Promise<MeResponse> {
  return requestJson<MeResponse>("/api/me");
}

export async function updateMyProfile(body: PatchMeProfileRequest): Promise<MeResponse> {
  return requestJson<MeResponse>("/api/me/profile", {
    method: "PATCH",
    body
  });
}

export async function getYoloSettings(): Promise<YoloSettingsResponse> {
  return requestJson<YoloSettingsResponse>("/api/me/yolo");
}

export async function putYoloSelf(input: PutYoloSelfRequest): Promise<YoloSettingsResponse> {
  return requestJson<YoloSettingsResponse>("/api/me/yolo", { method: "PUT", body: input });
}

export async function listMySessions(): Promise<ListMySessionsResponse> {
  return requestJson<ListMySessionsResponse>("/api/me/sessions");
}

export async function revokeMySession(id: string): Promise<RevokeMySessionResponse> {
  return requestJson<RevokeMySessionResponse>(`/api/me/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function revokeMyOtherSessions(): Promise<RevokeMyOtherSessionsResponse> {
  return requestJson<RevokeMyOtherSessionsResponse>("/api/me/sessions/others", {
    method: "DELETE"
  });
}

export async function getLocaleSettings(): Promise<GetLocaleSettingsResponse> {
  return requestJson<GetLocaleSettingsResponse>("/api/me/locale");
}

export async function putLocaleSettings(
  body: PutLocaleSettingsRequest
): Promise<PutLocaleSettingsResponse> {
  return requestJson<PutLocaleSettingsResponse>("/api/me/locale", {
    method: "PUT",
    body
  });
}

export async function getQuietHoursSettings(): Promise<GetQuietHoursSettingsResponse> {
  return requestJson<GetQuietHoursSettingsResponse>("/api/me/quiet-hours");
}

export async function putQuietHoursSettings(
  body: PutQuietHoursSettingsRequest
): Promise<PutQuietHoursSettingsResponse> {
  return requestJson<PutQuietHoursSettingsResponse>("/api/me/quiet-hours", {
    method: "PUT",
    body
  });
}

export async function getNotificationPreferences(): Promise<ListNotificationPreferencesResponse> {
  return requestJson<ListNotificationPreferencesResponse>("/api/me/notification-preferences");
}

export async function getNotificationDigestPreference(): Promise<GetNotificationDigestPreferenceResponse> {
  return requestJson<GetNotificationDigestPreferenceResponse>(
    "/api/me/notification-digest-preference"
  );
}

export async function putNotificationDigestPreference(
  body: PutNotificationDigestPreferenceRequest
): Promise<PutNotificationDigestPreferenceResponse> {
  return requestJson<PutNotificationDigestPreferenceResponse>(
    "/api/me/notification-digest-preference",
    {
      method: "PUT",
      body
    }
  );
}

export async function putNotificationPreference(
  moduleId: string,
  body: PutNotificationPreferenceRequest
): Promise<PutNotificationPreferenceResponse> {
  return requestJson<PutNotificationPreferenceResponse>(
    `/api/me/notification-preferences/${encodeURIComponent(moduleId)}`,
    {
      method: "PUT",
      body
    }
  );
}

export async function listThemes(): Promise<ListThemesResponse> {
  return requestJson<ListThemesResponse>("/api/me/themes");
}

export async function setActiveTheme(body: PutActiveThemeRequest): Promise<ListThemesResponse> {
  return requestJson<ListThemesResponse>("/api/me/themes/active", {
    method: "PUT",
    body
  });
}

export async function setColorMode(body: PutColorModeRequest): Promise<ListThemesResponse> {
  return requestJson<ListThemesResponse>("/api/me/themes/mode", {
    method: "PUT",
    body
  });
}

export async function putCustomTheme(
  id: string,
  body: PutCustomThemeRequest
): Promise<PutCustomThemeResponse> {
  return requestJson<PutCustomThemeResponse>(`/api/me/themes/${encodeURIComponent(id)}`, {
    method: "PUT",
    body
  });
}

export async function deleteCustomTheme(id: string): Promise<DeleteCustomThemeResponse> {
  return requestJson<DeleteCustomThemeResponse>(`/api/me/themes/${encodeURIComponent(id)}`, {
    method: "DELETE"
  });
}

export async function listSourceBehaviors(): Promise<ListSourceBehaviorsResponse> {
  return requestJson<ListSourceBehaviorsResponse>("/api/me/source-behaviors");
}

export async function putSourceBehavior(
  id: string,
  body: PutSourceBehaviorRequest
): Promise<PutSourceBehaviorResponse> {
  return requestJson<PutSourceBehaviorResponse>(
    `/api/me/source-behaviors/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body
    }
  );
}

/** Bounded so a hung persona read can never trap the app shell (mirrors ONBOARDING_STATUS_TIMEOUT_MS). */
const PERSONA_SETTINGS_TIMEOUT_MS = 4000;

export async function getPersonaSettings(): Promise<GetPersonaSettingsResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PERSONA_SETTINGS_TIMEOUT_MS);
  try {
    return await requestJson<GetPersonaSettingsResponse>("/api/me/persona", {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function putPersonaSettings(
  body: PutPersonaSettingsRequest
): Promise<PutPersonaSettingsResponse> {
  return requestJson<PutPersonaSettingsResponse>("/api/me/persona", {
    method: "PUT",
    body
  });
}

export async function previewPersona(body: PreviewPersonaRequest): Promise<PreviewPersonaResponse> {
  return requestJson<PreviewPersonaResponse>("/api/me/persona/preview", {
    method: "POST",
    body
  });
}

export async function getModules(): Promise<ListModulesResponse> {
  return requestJson<ListModulesResponse>("/api/modules");
}

export async function getMyModules(): Promise<ListMyModulesResponse> {
  return requestJson<ListMyModulesResponse>("/api/me/modules");
}

export async function listAdminModules(): Promise<ListAdminModulesResponse> {
  return requestJson<ListAdminModulesResponse>("/api/admin/modules");
}

/** Self-service: enable/disable an optional module for the current user. */
export async function setMyModuleDisabled(
  id: string,
  disabled: boolean
): Promise<{ module: MyModuleDto }> {
  return requestJson<{ module: MyModuleDto }>(`/api/me/modules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { disabled }
  });
}

/** #1725: the module's declared on/off switches, joined to this user's stored values. */
export async function getModulePreferences(
  moduleId: string
): Promise<ListModulePreferencesResponse> {
  return requestJson<ListModulePreferencesResponse>(
    `/api/modules/${encodeURIComponent(moduleId)}/preferences`
  );
}

/**
 * #1725: write one or more settings. Undeclared keys are rejected, not ignored, and #1757 the
 * server also rejects a value of the wrong type or outside the manifest's declared bounds.
 */
export async function updateModulePreferences(
  moduleId: string,
  updates: Readonly<Record<string, ModulePreferenceValue>>
): Promise<UpdateModulePreferencesResponse> {
  return requestJson<UpdateModulePreferencesResponse>(
    `/api/modules/${encodeURIComponent(moduleId)}/preferences`,
    { method: "PATCH", body: updates }
  );
}

/** Admin: enable/disable an optional module instance-wide. */
export async function setAdminModuleDisabled(
  id: string,
  disabled: boolean
): Promise<{ module: MyModuleDto }> {
  return requestJson<{ module: MyModuleDto }>(`/api/admin/modules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { disabled }
  });
}

/** Admin: list discovered external modules with reconciled activation state (#917). */
export async function listExternalModules(): Promise<ListExternalModulesResponse> {
  return requestJson<ListExternalModulesResponse>("/api/admin/external-modules");
}

/** Admin: enable/disable a single external module (#917). */
export async function setExternalModuleEnabled(
  id: string,
  enabled: boolean
): Promise<{ module: ExternalModuleDto }> {
  return requestJson<{ module: ExternalModuleDto }>(
    `/api/admin/external-modules/${encodeURIComponent(id)}`,
    { method: "POST", body: { enabled } }
  );
}

/**
 * Admin: ship a running draft — flips it from draft to enabled for everyone and clears its
 * owner. `restartRequired` is always true: the row change alone doesn't make the module visible
 * to other users, a restart still does that (#1753 Task 10).
 */
export async function shipExternalModule(
  id: string
): Promise<{ shipped: boolean; restartRequired: boolean }> {
  return requestJson<{ shipped: boolean; restartRequired: boolean }>(
    `/api/admin/modules/${encodeURIComponent(id)}/ship`,
    { method: "POST" }
  );
}

/**
 * Admin: throw away a running draft (#1890) — deletes its database row, its installed module
 * folder and any leftover build folder. Not undoable; the caller is expected to have confirmed
 * first. 404 covers "no such module", "that is shipped" and "that draft is someone else's"
 * alike, on purpose — see deleteExternalModuleDraft in @moss/settings.
 */
export async function throwAwayExternalModuleDraft(id: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`/api/admin/modules/${encodeURIComponent(id)}/draft`, {
    method: "DELETE"
  });
}

/** Admin: registry-backed module list — install/update/remove states (#964). */
export async function getModuleRegistry(refresh: boolean): Promise<GetModuleRegistryResponse> {
  return requestJson<GetModuleRegistryResponse>(
    `/api/admin/module-registry${refresh ? "?refresh=1" : ""}`
  );
}

/** Admin: download+stage a module from the registry; applies on next restart (#964). */
export async function downloadRegistryModule(
  id: string,
  version?: string
): Promise<{ module: ModuleRegistryRowDto }> {
  return requestJson<{ module: ModuleRegistryRowDto }>(
    `/api/admin/external-modules/${encodeURIComponent(id)}/download`,
    { method: "POST", body: version ? { version } : {} }
  );
}

/** Admin: remove a module (disable + delete files); purge destroys data on restart (#964). */
export async function removeRegistryModule(
  id: string,
  purgeData: boolean
): Promise<{ module: ModuleRegistryRowDto }> {
  return requestJson<{ module: ModuleRegistryRowDto }>(
    `/api/admin/external-modules/${encodeURIComponent(id)}/remove`,
    { method: "POST", body: { purgeData } }
  );
}

/** Admin: cancel a pending data purge before it runs at restart (#964). */
export async function cancelModulePurge(id: string): Promise<{ module: ModuleRegistryRowDto }> {
  return requestJson<{ module: ModuleRegistryRowDto }>(
    `/api/admin/external-modules/${encodeURIComponent(id)}/purge`,
    { method: "DELETE" }
  );
}

/**
 * Module credential settings (#918). `surface` picks the admin (instance-scope slots) or
 * self-service (`me`, user-scope slots) route family — both share the same DTO shape.
 * `value` is write-only: the server never returns it back (metadata-only responses).
 */
export async function listModuleCredentials(
  surface: "admin" | "me",
  moduleId: string
): Promise<ListModuleCredentialsResponse> {
  return requestJson<ListModuleCredentialsResponse>(
    `/api/${surface}/modules/${encodeURIComponent(moduleId)}/credentials`
  );
}

export async function setModuleCredential(
  surface: "admin" | "me",
  moduleId: string,
  credentialId: string,
  value: string
): Promise<{ credential: ModuleCredentialStatusDto }> {
  return requestJson<{ credential: ModuleCredentialStatusDto }>(
    `/api/${surface}/modules/${encodeURIComponent(moduleId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "PUT", body: { value } }
  );
}

export async function revokeModuleCredential(
  surface: "admin" | "me",
  moduleId: string,
  credentialId: string
): Promise<{ credential: ModuleCredentialStatusDto }> {
  return requestJson<{ credential: ModuleCredentialStatusDto }>(
    `/api/${surface}/modules/${encodeURIComponent(moduleId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" }
  );
}

/** Bounded so a hung status read can never trap the founder before the app shell (Codex R2 #2). */
const ONBOARDING_STATUS_TIMEOUT_MS = 4000;

export async function getOnboardingStatus(): Promise<OnboardingStatusResponse> {
  // Race the request against a bounded timeout. On timeout this rejects → React Query
  // (retry:false) surfaces isError, and app.tsx falls through to the app shell. A fresh
  // instance therefore always boots even if /api/onboarding/status hangs.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ONBOARDING_STATUS_TIMEOUT_MS);
  try {
    return await requestJson<OnboardingStatusResponse>("/api/onboarding/status", {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// Phase 4: complete/skip serve BOTH the founder { state } shape and the member { completed }
// shape (branched on role server-side). The return type is the shared role-by-shape union, not
// the founder-only OnboardingStateResponse — typing it { state } would make `.state` read as
// undefined for a member and mislead any consumer that narrows on it.
export async function completeOnboarding(): Promise<OnboardingCompleteResponse> {
  return requestJson<OnboardingCompleteResponse>("/api/onboarding/complete", { method: "POST" });
}

export async function skipOnboarding(): Promise<OnboardingCompleteResponse> {
  return requestJson<OnboardingCompleteResponse>("/api/onboarding/skip", { method: "POST" });
}

export async function signUpEmail(input: SignUpEmailRequest): Promise<void> {
  await requestJson<unknown>("/api/auth/sign-up/email", {
    method: "POST",
    body: input
  });
}

export async function signInEmail(input: SignInEmailRequest): Promise<void> {
  await requestJson<unknown>("/api/auth/sign-in/email", {
    method: "POST",
    body: input
  });
}

export async function signOut(): Promise<void> {
  await requestJson<unknown>("/api/auth/sign-out", {
    method: "POST"
  });
}

export async function listTaskActivity(taskId: string): Promise<ListTaskActivityResponse> {
  return requestJson<ListTaskActivityResponse>(`/api/tasks/${encodeURIComponent(taskId)}/activity`);
}

export interface ListGoalsResponse {
  readonly items: readonly MossGoal[];
}

export async function listGoals(): Promise<ListGoalsResponse> {
  return requestJson<ListGoalsResponse>(`/api/goals`);
}

export async function listTasks(params?: { readonly tagId?: string }): Promise<ListTasksResponse> {
  const qs = params?.tagId ? `?tagId=${encodeURIComponent(params.tagId)}` : "";
  return requestJson<ListTasksResponse>(`/api/tasks${qs}`);
}

export async function interpretTaskSearch(
  input: InterpretTaskSearchRequest
): Promise<InterpretTaskSearchResponse> {
  return requestJson<InterpretTaskSearchResponse>("/api/tasks/search/interpret", {
    method: "POST",
    body: input
  });
}

export async function assignTaskTag(
  taskId: string,
  input: AssignTaskTagRequest
): Promise<GetTaskResponse> {
  return requestJson<GetTaskResponse>(`/api/tasks/${encodeURIComponent(taskId)}/tags`, {
    method: "POST",
    body: input
  });
}

export async function unassignTaskTag(taskId: string, tagId: string): Promise<GetTaskResponse> {
  return requestJson<GetTaskResponse>(
    `/api/tasks/${encodeURIComponent(taskId)}/tags/${encodeURIComponent(tagId)}`,
    { method: "DELETE" }
  );
}

export async function createTask(input: CreateTaskRequest): Promise<CreateTaskResponse> {
  return requestJson<CreateTaskResponse>("/api/tasks", { method: "POST", body: input });
}

export async function getTask(id: string): Promise<GetTaskResponse> {
  return requestJson<GetTaskResponse>(`/api/tasks/${encodeURIComponent(id)}`);
}

export async function updateTask(
  id: string,
  input: UpdateTaskRequest
): Promise<UpdateTaskResponse> {
  return requestJson<UpdateTaskResponse>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input
  });
}

export async function addTaskActivity(
  id: string,
  input: AddTaskActivityRequest
): Promise<AddTaskActivityResponse> {
  return requestJson<AddTaskActivityResponse>(`/api/tasks/${encodeURIComponent(id)}/activity`, {
    method: "POST",
    body: input
  });
}

export async function listSubtasks(id: string): Promise<ListTasksResponse> {
  return requestJson<ListTasksResponse>(`/api/tasks/${encodeURIComponent(id)}/subtasks`);
}

export async function breakdownTask(
  id: string,
  input: BreakdownTaskRequest
): Promise<BreakdownTaskResponse> {
  return requestJson<BreakdownTaskResponse>(`/api/tasks/${encodeURIComponent(id)}/breakdown`, {
    method: "POST",
    body: input
  });
}

export async function listTaskLists(): Promise<ListTaskListsResponse> {
  return requestJson<ListTaskListsResponse>("/api/tasks/lists");
}

export async function listTaskTags(listId: string): Promise<ListTaskTagsResponse> {
  return requestJson<ListTaskTagsResponse>(`/api/tasks/lists/${encodeURIComponent(listId)}/tags`);
}

export async function createTaskTag(
  listId: string,
  input: CreateTaskTagRequest
): Promise<CreateTaskTagResponse> {
  return requestJson<CreateTaskTagResponse>(`/api/tasks/lists/${encodeURIComponent(listId)}/tags`, {
    method: "POST",
    body: input
  });
}

export async function getTaskPreferences(): Promise<GetTaskPreferencesResponse> {
  return requestJson<GetTaskPreferencesResponse>("/api/tasks/preferences");
}

export async function updateTaskPreferences(
  input: UpdateTaskPreferencesRequest
): Promise<UpdateTaskPreferencesResponse> {
  return requestJson<UpdateTaskPreferencesResponse>("/api/tasks/preferences", {
    method: "PATCH",
    body: input
  });
}

export async function listWellnessCheckins(limitHint?: number): Promise<ListCheckinsResponse> {
  const limit = limitHint ?? 50;
  return requestJson<ListCheckinsResponse>(`/api/wellness/checkins?limit=${limit}`);
}

export async function createWellnessCheckin(
  input: CreateCheckinRequest
): Promise<CreateCheckinResponse> {
  return requestJson<CreateCheckinResponse>("/api/wellness/checkins", {
    method: "POST",
    body: input
  });
}

export async function listMedications(): Promise<ListMedicationsResponse> {
  return requestJson<ListMedicationsResponse>("/api/wellness/medications");
}

export async function createMedication(
  input: CreateMedicationRequest
): Promise<MedicationResponse> {
  return requestJson<MedicationResponse>("/api/wellness/medications", {
    method: "POST",
    body: input
  });
}

export async function updateMedication(
  id: string,
  input: UpdateMedicationRequest
): Promise<MedicationResponse> {
  return requestJson<MedicationResponse>(`/api/wellness/medications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input
  });
}

export async function getMedicationSchedule(date: string): Promise<MedicationScheduleResponse> {
  return requestJson<MedicationScheduleResponse>(
    `/api/wellness/medications/schedule?date=${encodeURIComponent(date)}`
  );
}

export async function logMedicationDose(
  medicationId: string,
  input: CreateMedicationLogRequest
): Promise<CreateMedicationLogResponse> {
  return requestJson<CreateMedicationLogResponse>(
    `/api/wellness/medications/${encodeURIComponent(medicationId)}/logs`,
    { method: "POST", body: input }
  );
}

export async function getWellnessInsights(): Promise<WellnessInsightsResponse> {
  return requestJson<WellnessInsightsResponse>("/api/wellness/insights");
}

export async function listTherapyNotes(): Promise<ListTherapyNotesResponse> {
  return requestJson<ListTherapyNotesResponse>("/api/wellness/therapy-notes");
}

export async function createTherapyNote(
  input: CreateTherapyNoteRequest
): Promise<CreateTherapyNoteResponse> {
  return requestJson<CreateTherapyNoteResponse>("/api/wellness/therapy-notes", {
    method: "POST",
    body: input
  });
}

export async function deleteTherapyNote(id: string): Promise<DeleteTherapyNoteResponse> {
  return requestJson<DeleteTherapyNoteResponse>(
    `/api/wellness/therapy-notes/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

export async function getMedicationAdherenceSummary(
  sinceDays: number
): Promise<MedicationAdherenceSummaryResponse> {
  return requestJson<MedicationAdherenceSummaryResponse>(
    `/api/wellness/medications/logs?sinceDays=${sinceDays}`
  );
}

export async function updateWellnessCheckin(
  id: string,
  input: UpdateCheckinRequest
): Promise<UpdateCheckinResponse> {
  return requestJson<UpdateCheckinResponse>(`/api/wellness/checkins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input
  });
}

export async function listNotifications(): Promise<ListNotificationsResponse> {
  return requestJson<ListNotificationsResponse>("/api/notifications");
}

export async function listCalendarEvents(): Promise<ListCalendarEventsResponse> {
  return requestJson<ListCalendarEventsResponse>("/api/calendar/events");
}

export async function listChatThreads(surface?: ChatSurface): Promise<ListChatThreadsResponse> {
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
  return requestJson<ListChatThreadsResponse>(`/api/chat/threads${query}`);
}

export async function listChatThreadMessages(
  threadId: string,
  surface?: ChatSurface
): Promise<ListChatThreadMessagesResponse> {
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
  return requestJson<ListChatThreadMessagesResponse>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/messages${query}`
  );
}

export async function getChatSettings(): Promise<GetChatSettingsResponse> {
  return requestJson<GetChatSettingsResponse>("/api/chat/settings");
}

export async function putChatSettings(
  input: PutChatSettingsRequest
): Promise<PutChatSettingsResponse> {
  return requestJson<PutChatSettingsResponse>("/api/chat/settings", {
    method: "PUT",
    body: input
  });
}

export async function listChatSkills(): Promise<ListChatSkillsResponse> {
  return requestJson<ListChatSkillsResponse>("/api/chat/skills");
}

export async function getChatSkill(id: string): Promise<ChatSkillResponse> {
  return requestJson<ChatSkillResponse>(`/api/chat/skills/${encodeURIComponent(id)}`);
}

export async function createChatSkill(input: CreateChatSkillRequest): Promise<ChatSkillResponse> {
  return requestJson<ChatSkillResponse>("/api/chat/skills", {
    method: "POST",
    body: input
  });
}

export async function updateChatSkill(
  id: string,
  input: UpdateChatSkillRequest
): Promise<ChatSkillResponse> {
  return requestJson<ChatSkillResponse>(`/api/chat/skills/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input
  });
}

export async function setChatSkillEnabled(
  id: string,
  input: SetChatSkillEnabledRequest
): Promise<ChatSkillResponse> {
  return requestJson<ChatSkillResponse>(`/api/chat/skills/${encodeURIComponent(id)}/enabled`, {
    method: "PATCH",
    body: input
  });
}

export async function deleteChatSkill(id: string): Promise<void> {
  await requestJson<void>(`/api/chat/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Uploads a skill file (standard frontmatter + markdown body) for import. Goes around
 * `requestJson` like `transcribeAudio()` — the body is the raw file text, not JSON.
 */
export async function importChatSkill(file: File): Promise<ChatSkillResponse> {
  const response = await fetch("/api/chat/skills/import", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "text/markdown" },
    body: await file.text()
  });

  if (!response.ok) {
    const { message, code } = await readErrorBody(response);
    throw new ApiError(response.status, message, code);
  }

  return response.json() as Promise<ChatSkillResponse>;
}

export async function sendChatTurn(
  text: string,
  attachmentIds?: readonly string[],
  controlContext?: Readonly<Record<string, unknown>>,
  surface?: ChatSurface
): Promise<SendChatTurnResponse> {
  return requestJson<SendChatTurnResponse>("/api/chat/turn", {
    method: "POST",
    body: {
      text,
      ...(controlContext ? { controlContext } : {}),
      ...(attachmentIds?.length ? { attachmentIds } : {}),
      ...(surface ? { surface } : {})
    }
  });
}

/**
 * #1284 — frames a surface's thread before the user's first visible turn, with no visible user
 * message (contrast sendChatTurn). `idempotencyKey` lets a remounted module call this safely
 * again: the server-side ChatSessionManager treats a repeated key as a no-op instead of re-framing
 * a conversation already in progress.
 */
export async function seedChat(
  seed: string,
  idempotencyKey: string,
  surface?: ChatSurface
): Promise<void> {
  const body: SeedChatRequest = { seed, idempotencyKey, ...(surface ? { surface } : {}) };
  await requestJson<void>("/api/chat/seed", { method: "POST", body });
}

/**
 * #1133 — stages a file for the next chat turn. Goes around `requestJson` like
 * `transcribeAudio()`: the body is the raw bytes as application/octet-stream, with the
 * declared mime in `x-jarvis-mime-type` and the display name percent-encoded in
 * `x-jarvis-file-name` (header values must be ISO-8859-1; the server decodes).
 */
export async function uploadChatAttachment(
  file: Blob,
  fileName: string
): Promise<UploadChatAttachmentResponse> {
  const response = await fetch("/api/chat/attachments", {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/octet-stream",
      "x-jarvis-mime-type": file.type || "application/octet-stream",
      "x-jarvis-file-name": encodeURIComponent(fileName)
    },
    body: file
  });

  if (!response.ok) {
    const { message, code } = await readErrorBody(response);
    throw new ApiError(response.status, message, code);
  }

  return response.json() as Promise<UploadChatAttachmentResponse>;
}

/**
 * #1109 — pushes the client's current-view snapshot to the server so `chat.getCurrentView` can
 * pull it on demand. Called by {@link usePageContextSync}, debounced off route/DOM/focus/selection
 * changes — not on the chat-turn path (see apps/web/src/chat/use-page-context-sync.ts).
 */
export async function updatePageContext(snapshot: PageContextSnapshotDto): Promise<void> {
  await requestJson<void>("/api/chat/page-context", { method: "PUT", body: { snapshot } });
}

export async function startEveningInterview(
  input: { readonly briefingRunId?: string; readonly surface?: ChatSurface } = {}
) {
  return requestJson<{ reply: string }>("/api/chat/evening-interview", {
    method: "POST",
    body: input
  });
}

/** #456 — stop the in-flight turn. Idempotent (200 even when no turn is in flight). */
export async function cancelChatTurn(surface?: ChatSurface): Promise<void> {
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
  await requestJson<unknown>(`/api/chat/turn/cancel${query}`, { method: "POST" });
}

export async function clearChat(options?: {
  incognito?: boolean;
  surface?: ChatSurface;
}): Promise<void> {
  const query = new URLSearchParams();
  if (options?.incognito) query.set("incognito", "true");
  if (options?.surface) query.set("surface", options.surface);
  const url = query.size ? `/api/chat/clear?${query}` : "/api/chat/clear";
  await requestJson<unknown>(url, { method: "POST" });
}

export async function endPrivateChat(surface?: ChatSurface): Promise<void> {
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
  await requestJson<unknown>(`/api/chat/private/end${query}`, { method: "POST" });
}

export async function getChatPrivacyState(
  surface?: ChatSurface
): Promise<GetChatPrivacyStateResponse> {
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
  return requestJson<GetChatPrivacyStateResponse>(`/api/chat/privacy${query}`);
}

export function beaconEndPrivateChat(): void {
  navigator.sendBeacon?.("/api/chat/private/end", "");
}

export async function resumeChat(threadId: string, surface?: ChatSurface): Promise<void> {
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
  await requestJson<unknown>(`/api/chat/threads/${encodeURIComponent(threadId)}/resume${query}`, {
    method: "POST"
  });
}

export function chatStreamUrl(surface?: ChatSurface): string {
  return surface ? `/api/chat/stream?surface=${encodeURIComponent(surface)}` : "/api/chat/stream";
}

export async function resolveActionRequest(
  actionRequestId: string,
  status: "confirmed" | "rejected" | "cancelled"
): Promise<void> {
  // #1250 — server returns 409 for expired requests; let card handle it
  await requestJson<unknown>(
    `/api/chat/action-requests/${encodeURIComponent(actionRequestId)}/resolve`,
    { method: "POST", body: { status } }
  );
}

export async function getAiSummary(): Promise<GetAiSummaryResponse> {
  return requestJson<GetAiSummaryResponse>("/api/ai/summary");
}

export async function listAiProviders(): Promise<ListAiProviderConfigsResponse> {
  return requestJson<ListAiProviderConfigsResponse>("/api/ai/providers");
}

export async function createAiProvider(
  input: CreateAiProviderConfigRequest
): Promise<CreateAiProviderConfigResponse> {
  return requestJson<CreateAiProviderConfigResponse>("/api/ai/providers", {
    method: "POST",
    body: input
  });
}

export async function updateAiProvider(
  id: string,
  input: UpdateAiProviderConfigRequest
): Promise<UpdateAiProviderConfigResponse> {
  return requestJson<UpdateAiProviderConfigResponse>(
    `/api/ai/providers/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input }
  );
}

export async function revokeAiProvider(id: string): Promise<RevokeAiProviderConfigResponse> {
  return requestJson<RevokeAiProviderConfigResponse>(
    `/api/ai/providers/${encodeURIComponent(id)}/revoke`,
    { method: "POST" }
  );
}

export async function testAiProvider(id: string): Promise<TestAiProviderConfigResponse> {
  return requestJson<TestAiProviderConfigResponse>(
    `/api/ai/providers/${encodeURIComponent(id)}/test`,
    { method: "POST" }
  );
}

export async function discoverAiProviderModels(
  id: string
): Promise<DiscoverAiProviderModelsResponse> {
  return requestJson<DiscoverAiProviderModelsResponse>(
    `/api/ai/providers/${encodeURIComponent(id)}/discover-models`,
    { method: "POST" }
  );
}

export async function discoverAiModels(id: string): Promise<AiDiscoverModelsResponse> {
  return requestJson<AiDiscoverModelsResponse>(
    `/api/ai/providers/${encodeURIComponent(id)}/models/discover`
  );
}

export async function listAiModels(): Promise<ListAiConfiguredModelsResponse> {
  return requestJson<ListAiConfiguredModelsResponse>("/api/ai/models");
}

// #1253 — fetch pending action requests for re-hydration on page reload
export async function listPendingActionRequests(): Promise<{ actions: AiAssistantActionDto[] }> {
  return requestJson<{ actions: AiAssistantActionDto[] }>("/api/ai/assistant-actions");
}

export async function createAiModel(
  input: CreateAiConfiguredModelRequest
): Promise<CreateAiConfiguredModelResponse> {
  return requestJson<CreateAiConfiguredModelResponse>("/api/ai/models", {
    method: "POST",
    body: input
  });
}

export async function updateAiModel(
  id: string,
  input: UpdateAiConfiguredModelRequest
): Promise<UpdateAiConfiguredModelResponse> {
  return requestJson<UpdateAiConfiguredModelResponse>(`/api/ai/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input
  });
}

export async function lookupAiCapabilityRoute(
  capability: AiModelCapability
): Promise<LookupAiCapabilityRouteResponse> {
  return requestJson<LookupAiCapabilityRouteResponse>(
    `/api/ai/capability-route/${encodeURIComponent(capability)}`
  );
}

// Merge-up (#876): #759's `putAiCapabilityRoute` client wrapper is dropped here. #870 Slice-1
// retired the manual capability-route knob (removed PutAiCapabilityRoute{Request,Response} from
// @moss/shared) in favour of per-service bindings (`putAiServiceBinding`), and #759's only
// caller — the admin-pane RouterRow pin — is likewise superseded by Slice-1's ServiceRow
// "Specific model" option. The in-chat model selector (#759's headline surface) is unaffected:
// it routes through `putChatModelOverride`, which remains.

/**
 * Uploads a recorded audio clip for transcription and returns the transcript text only.
 * Goes around `requestJson` (which always JSON-encodes) because the body here is the raw
 * audio blob itself, sent with its own mime type as the content-type.
 */
export async function transcribeAudio(audio: Blob): Promise<TranscribeAudioResponse> {
  const response = await fetch("/api/ai/transcriptions", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": audio.type || "audio/webm" },
    body: audio
  });

  if (!response.ok) {
    const { message, code } = await readErrorBody(response);
    throw new ApiError(response.status, message, code);
  }

  return response.json() as Promise<TranscribeAudioResponse>;
}

// #870 Slice 1: unified per-service bindings (Chat + Voice) replace the old per-user tier preference.
export async function listAiServiceBindings(): Promise<ListAiServiceBindingsResponse> {
  return requestJson<ListAiServiceBindingsResponse>("/api/ai/service-bindings");
}

export async function putAiServiceBinding(
  service: AiServiceKey,
  input: PutAiServiceBindingRequest
): Promise<PutAiServiceBindingResponse> {
  return requestJson<PutAiServiceBindingResponse>(
    `/api/ai/services/${encodeURIComponent(service)}/binding`,
    { method: "PUT", body: input }
  );
}

// #874: the dedicated Voice (STT) admin endpoint. GET returns the config DTO (never the API key —
// only `hasKey`); PUT is an admin-only upsert. On PUT, omit `apiKey` to keep the stored key.
export async function getVoiceEndpoint(): Promise<GetVoiceEndpointResponse> {
  return requestJson<GetVoiceEndpointResponse>("/api/ai/voice-endpoint");
}

export async function putVoiceEndpoint(
  input: PutVoiceEndpointRequest
): Promise<PutVoiceEndpointResponse> {
  return requestJson<PutVoiceEndpointResponse>("/api/ai/voice-endpoint", {
    method: "PUT",
    body: input
  });
}

// #870/H1: promote a provider to the single instance-default.
export async function setInstanceDefaultProvider(
  providerId: string
): Promise<CreateAiProviderConfigResponse> {
  return requestJson<CreateAiProviderConfigResponse>(
    `/api/ai/providers/${encodeURIComponent(providerId)}/default`,
    { method: "PUT" }
  );
}

export async function getChatModelOverrideSettings(): Promise<GetChatModelOverrideSettingsResponse> {
  return requestJson<GetChatModelOverrideSettingsResponse>("/api/ai/chat-model-override");
}

export async function putChatModelOverride(
  input: PutChatModelOverrideRequest
): Promise<GetChatModelOverrideSettingsResponse> {
  return requestJson<GetChatModelOverrideSettingsResponse>("/api/ai/chat-model-override", {
    method: "PUT",
    body: input
  });
}

export async function switchChatProvider(surface?: ChatSurface): Promise<void> {
  const query = surface ? `?surface=${encodeURIComponent(surface)}` : "";
  await requestJson<{ ok: true }>(`/api/chat/switch${query}`, { method: "POST" });
}

export async function putAdminChatModelOverrideEnabled(
  input: PutAdminChatModelOverrideRequest
): Promise<GetChatModelOverrideSettingsResponse> {
  return requestJson<GetChatModelOverrideSettingsResponse>("/api/admin/ai/chat-model-override", {
    method: "PUT",
    body: input
  });
}

export async function getAdminYoloSettings(): Promise<YoloAdminSettingsResponse> {
  return requestJson<YoloAdminSettingsResponse>("/api/admin/yolo");
}

export async function putAdminYoloInstance(
  input: PutYoloInstanceRequest
): Promise<YoloAdminSettingsResponse> {
  return requestJson<YoloAdminSettingsResponse>("/api/admin/yolo/instance", {
    method: "PUT",
    body: input
  });
}

export async function putAdminYoloUser(
  userId: string,
  input: PutYoloUserRequest
): Promise<YoloAdminSettingsResponse> {
  return requestJson<YoloAdminSettingsResponse>(
    `/api/admin/yolo/users/${encodeURIComponent(userId)}`,
    {
      method: "PUT",
      body: input
    }
  );
}

export async function postAdminYoloAllowAll(): Promise<YoloAdminSettingsResponse> {
  return requestJson<YoloAdminSettingsResponse>("/api/admin/yolo/allow-all", { method: "POST" });
}

export async function listAiAssistantTools(): Promise<ListAiAssistantToolsResponse> {
  return requestJson<ListAiAssistantToolsResponse>("/api/ai/assistant-tools");
}

export async function listActionAuditLog(params?: {
  since?: string;
  family?: string;
  limit?: number;
}): Promise<ListActionAuditLogResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const search = new URLSearchParams();
  if (params?.since) search.set("since", params.since);
  if (params?.family) search.set("family", params.family);
  if (params?.limit !== undefined) search.set("limit", String(params.limit));
  const qs = search.toString();
  try {
    return await requestJson<ListActionAuditLogResponse>(
      `/api/ai/action-audit${qs ? `?${qs}` : ""}`,
      { signal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function getWebSearchKey(): Promise<GetWebSearchKeyResponse> {
  return requestJson<GetWebSearchKeyResponse>("/api/admin/settings/web-search");
}

export async function putWebSearchKey(
  input: PutWebSearchKeyRequest
): Promise<PutWebSearchKeyResponse> {
  return requestJson<PutWebSearchKeyResponse>("/api/admin/settings/web-search", {
    method: "PUT",
    body: input
  });
}

export async function deleteWebSearchKey(): Promise<DeleteWebSearchKeyResponse> {
  return requestJson<DeleteWebSearchKeyResponse>("/api/admin/settings/web-search", {
    method: "DELETE"
  });
}

export async function listBriefingDefinitions(): Promise<ListBriefingDefinitionsResponse> {
  return requestJson<ListBriefingDefinitionsResponse>("/api/briefings/definitions");
}

export async function createBriefingDefinition(
  input: CreateBriefingDefinitionRequest
): Promise<CreateBriefingDefinitionResponse> {
  return requestJson<CreateBriefingDefinitionResponse>("/api/briefings/definitions", {
    method: "POST",
    body: input
  });
}

export async function updateBriefingDefinition(
  id: string,
  input: UpdateBriefingDefinitionRequest
): Promise<UpdateBriefingDefinitionResponse> {
  return requestJson<UpdateBriefingDefinitionResponse>(
    `/api/briefings/definitions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: input }
  );
}

export async function listBriefingRuns(id: string): Promise<ListBriefingRunsResponse> {
  return requestJson<ListBriefingRunsResponse>(
    `/api/briefings/definitions/${encodeURIComponent(id)}/runs`
  );
}

export async function listConnectorAccounts(): Promise<ListConnectorAccountsResponse> {
  return requestJson<ListConnectorAccountsResponse>("/api/connectors/accounts");
}

export async function revokeConnectorAccount(id: string): Promise<RevokeConnectorAccountResponse> {
  return requestJson<RevokeConnectorAccountResponse>(
    `/api/connectors/accounts/${encodeURIComponent(id)}/revoke`,
    { method: "POST" }
  );
}

export async function authorizeGoogleConnection(
  input: GoogleAuthorizeRequest
): Promise<GoogleAuthorizeResponse> {
  return requestJson<GoogleAuthorizeResponse>("/api/connectors/google/authorize", {
    method: "POST",
    body: input
  });
}

export async function completeGoogleConnection(
  input: GoogleCompleteRequest
): Promise<GoogleCompleteResponse> {
  return requestJson<GoogleCompleteResponse>("/api/connectors/google/complete", {
    method: "POST",
    body: input
  });
}

export async function testImapConnection(input: ImapConnectRequest): Promise<ImapTestResult> {
  return requestJson<ImapTestResult>("/api/connectors/imap/test-connection", {
    method: "POST",
    body: input
  });
}

export async function connectImapConnection(
  input: ImapConnectRequest
): Promise<CreateConnectorAccountResponse> {
  return requestJson<CreateConnectorAccountResponse>("/api/connectors/imap/connect", {
    method: "POST",
    body: input
  });
}

export async function markNotificationRead(id: string): Promise<MarkNotificationReadResponse> {
  return requestJson<MarkNotificationReadResponse>(
    `/api/notifications/${encodeURIComponent(id)}/read`,
    { method: "PATCH" }
  );
}

export async function markAllNotificationsRead(): Promise<MarkAllNotificationsReadResponse> {
  return requestJson<MarkAllNotificationsReadResponse>("/api/notifications/read-all", {
    method: "PATCH"
  });
}

export * from "./client-admin.js";
export * from "./client-proactive.js";

export async function requestJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const hasBody = options.body !== undefined;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  headers.set("accept", "application/json");
  if (timeZone && !headers.has("X-Timezone")) {
    headers.set("X-Timezone", timeZone);
  }
  if (hasBody) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...options,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    credentials: "include",
    headers
  });

  if (!response.ok) {
    const { message: errorMessage, code } = await readErrorBody(response);
    throw new ApiError(response.status, errorMessage, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();

  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function readErrorBody(
  response: Response
): Promise<{ message: string; code?: string }> {
  const text = await response.text();

  if (!text) {
    return { message: response.statusText };
  }

  try {
    const parsed = JSON.parse(text) as {
      readonly error?: unknown;
      readonly message?: unknown;
      readonly code?: unknown;
    };
    const raw = parsed.error ?? parsed.message;
    const message = typeof raw === "string" ? raw : response.statusText;
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    return { message, code };
  } catch {
    return { message: text };
  }
}

export * from "./account-client.js";

export interface ExportJobStatus {
  readonly jobId: string;
  readonly status: "pending" | "building" | "ready" | "failed" | "expired";
  readonly expiresAt?: string;
  readonly errorMessage?: string;
}

export async function startDataExport(): Promise<ExportJobStatus> {
  return requestJson<ExportJobStatus>("/api/me/export", { method: "POST" });
}

export async function getDataExportStatus(jobId: string): Promise<ExportJobStatus> {
  return requestJson<ExportJobStatus>(`/api/me/export/status/${jobId}`);
}

export function getDataExportDownloadUrl(jobId: string): string {
  return `/api/me/export/download/${jobId}`;
}

// #1059 owner-gated CLI-provider terminal — password/status/ticket client helpers for
// packages/ai/src/terminal-routes.ts, plus the ws:// URL builder Task 9's settings modal
// will call. Mirrors the testAiProvider / requestJson pattern used elsewhere in this file.
export async function getTerminalStatus(): Promise<GetTerminalStatusResponse> {
  return requestJson<GetTerminalStatusResponse>("/api/ai/terminal/status");
}

export async function setTerminalPassword(password: string): Promise<SetTerminalPasswordResponse> {
  return requestJson<SetTerminalPasswordResponse>("/api/ai/terminal/password", {
    method: "POST",
    body: { password }
  });
}

export async function requestTerminalTicket(
  password: string
): Promise<RequestTerminalTicketResponse> {
  return requestJson<RequestTerminalTicketResponse>("/api/ai/terminal/ticket", {
    method: "POST",
    body: { password }
  });
}

/**
 * Derives ws/wss from the page's own protocol (never hardcoded) so the terminal socket
 * inherits the page's transport security: an https page must use wss (mixed-content
 * blocking would otherwise silently kill a plain ws:// connection), while local http dev
 * uses plain ws. The ticket travels in the query string because the WS upgrade request
 * can't carry a custom Authorization header from the browser's native WebSocket client.
 */
export function terminalWsUrl(ticket: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/api/ai/terminal?ticket=${encodeURIComponent(ticket)}`;
}
