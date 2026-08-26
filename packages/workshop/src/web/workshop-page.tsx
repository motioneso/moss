import "./workshop.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { EmptyState } from "@moss/ui";
import { requestJson } from "@moss/module-web-sdk";
import type {
  ListMyModuleBuildsResponse,
  ListMyModulesResponse,
  MeResponse,
  WorkshopLiveModuleSummary
} from "@moss/shared";

import { WorkshopGroups } from "./workshop-groups.js";

const BUILDS_QUERY_KEY = ["workshop", "module-builds", "mine"];
const MODULES_QUERY_KEY = ["workshop", "modules", "mine"];

// The sidebar already hides this page's nav entry from non-admins (apps/web/src/shell/app-shell.tsx);
// this is defense-in-depth for anyone who navigates to /workshop directly.
function useIsInstanceAdmin(): boolean | undefined {
  const { data } = useQuery({
    queryKey: ["workshop", "me"],
    queryFn: () => requestJson<MeResponse>("/api/me")
  });
  return data?.user.isInstanceAdmin;
}

export function hasActiveBuild(data: ListMyModuleBuildsResponse | undefined): boolean {
  return (data?.builds ?? []).some(
    (build) => build.status === "planning" || build.status === "building"
  );
}

function useMyModuleBuilds() {
  const { data } = useQuery({
    queryKey: BUILDS_QUERY_KEY,
    queryFn: () => requestJson<ListMyModuleBuildsResponse>("/api/ai/module-builds/mine"),
    refetchInterval: (query) => (hasActiveBuild(query.state.data) ? 3000 : false)
  });
  return data?.builds ?? [];
}

function useLiveModules(): readonly WorkshopLiveModuleSummary[] {
  const { data } = useQuery({
    queryKey: MODULES_QUERY_KEY,
    queryFn: () => requestJson<ListMyModulesResponse>("/api/me/modules")
  });
  return (data?.modules ?? [])
    .filter((mod) => mod.lifecycle === "optional" && mod.scope === "you")
    .map((mod) => ({ id: mod.id, name: mod.name, version: mod.version, scope: mod.scope }));
}

export function WorkshopPage() {
  const isInstanceAdmin = useIsInstanceAdmin();
  const builds = useMyModuleBuilds();
  const modules = useLiveModules();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const invalidateWorkshopLists = () => {
    void queryClient.invalidateQueries({ queryKey: BUILDS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: MODULES_QUERY_KEY });
  };

  // #1975: "Stop" cannot kill an in-flight build step instantly — it prevents the build
  // from continuing past the step that is currently running. See cancelModuleBuild
  // (packages/settings/src/module-builds-repository.ts) and the worker guard that keeps a
  // step that finishes after the cancel from overwriting the cancelled status.
  const stopMutation = useMutation({
    mutationFn: (buildId: string) =>
      requestJson(`/api/ai/module-builds/${buildId}/cancel`, { method: "POST" }),
    onSuccess: invalidateWorkshopLists
  });
  const turnOnMutation = useMutation({
    mutationFn: (moduleId: string) =>
      requestJson(`/api/admin/modules/${moduleId}/ship`, { method: "POST" }),
    onSuccess: invalidateWorkshopLists
  });

  if (isInstanceAdmin === false) {
    return (
      <div className="workshop-page">
        <EmptyState
          title="The workshop is for instance admins"
          description="Ask an instance admin if you need something built."
        />
      </div>
    );
  }

  return (
    <div className="workshop-page">
      <header className="workshop-head">
        <p className="workshop-lede">
          See what Moss is building for you, and what's already running.
        </p>
      </header>
      <WorkshopGroups
        builds={builds}
        modules={modules}
        onStop={(buildId) => stopMutation.mutate(buildId)}
        onTurnOnForEveryone={(moduleId) => turnOnMutation.mutate(moduleId)}
        onAskForChange={(moduleId) => navigate(`/m/${moduleId}`, { state: { openChat: true } })}
      />
    </div>
  );
}
