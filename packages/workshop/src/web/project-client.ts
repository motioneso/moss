import { requestJson } from "@moss/module-web-sdk";
import type {
  CreateWorkshopProjectInput,
  WorkshopProject,
  WorkshopProjectCreationResult,
  WorkshopProjectCursor,
  WorkshopFeedInput,
  WorkshopFeedEntry
} from "@moss/shared";

const base = "/api/workshop/projects";
export const projectKeys = {
  list: ["workshop", "projects"] as const,
  detail: (id: string) => ["workshop", "project", id] as const,
  messages: (id: string) => ["workshop", "project", id, "messages"] as const
};
export function listProjects(cursor: WorkshopProjectCursor | null) {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) {
    query.set("beforeId", cursor.id);
    query.set("beforeCreatedAt", cursor.createdAt);
  }
  return requestJson<{ projects: WorkshopProject[]; nextCursor: WorkshopProjectCursor | null }>(
    `${base}?${query}`
  );
}
export const createProject = (input: CreateWorkshopProjectInput) =>
  requestJson<WorkshopProjectCreationResult>(base, { method: "POST", body: input });
export const getProject = (id: string) =>
  requestJson<{ project: WorkshopProject }>(`${base}/${encodeURIComponent(id)}`);
export const listMessages = (id: string, after: string) =>
  requestJson<{ entries: WorkshopFeedEntry[]; nextCursor: string }>(
    `${base}/${encodeURIComponent(id)}/messages?${new URLSearchParams({ after, limit: "50" })}`
  );
export const saveMessage = (id: string, input: WorkshopFeedInput) =>
  requestJson<{ entry: WorkshopFeedEntry; created: boolean }>(
    `${base}/${encodeURIComponent(id)}/messages`,
    { method: "POST", body: input }
  );
