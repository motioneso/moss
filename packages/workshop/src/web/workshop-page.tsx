import "./workshop.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@moss/ui";
import { requestJson } from "@moss/module-web-sdk";
import type {
  ListMyModuleBuildsResponse,
  ListMyModulesResponse,
  MeResponse,
  WorkshopLiveModuleSummary
} from "@moss/shared";

import { WorkshopGroups } from "./workshop-groups.js";

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
    queryKey: ["workshop", "module-builds", "mine"],
    queryFn: () => requestJson<ListMyModuleBuildsResponse>("/api/ai/module-builds/mine"),
    refetchInterval: (query) => (hasActiveBuild(query.state.data) ? 3000 : false)
  });
  return data?.builds ?? [];
}

function useLiveModules(): readonly WorkshopLiveModuleSummary[] {
  const { data } = useQuery({
    queryKey: ["workshop", "modules", "mine"],
    queryFn: () => requestJson<ListMyModulesResponse>("/api/me/modules")
  });
  return (data?.modules ?? [])
    .filter((mod) => mod.lifecycle === "optional" && mod.scope === "you")
    .map((mod) => ({ id: mod.id, name: mod.name, version: mod.version, scope: mod.scope }));
}

export function WorkshopPage() {
  const queryClient = useQueryClient();
  const isInstanceAdmin = useIsInstanceAdmin();
  const builds = useMyModuleBuilds();
  const modules = useLiveModules();
  const refreshWorkshop = () => queryClient.invalidateQueries({ queryKey: ["workshop"] });
  const approve = useMutation({
    mutationFn: (buildId: string) =>
      requestJson(`/api/ai/module-builds/${encodeURIComponent(buildId)}/approve`, {
        method: "POST"
      }),
    onSuccess: refreshWorkshop
  });
  const cancel = useMutation({
    mutationFn: (buildId: string) =>
      requestJson(`/api/ai/module-builds/${encodeURIComponent(buildId)}/cancel`, {
        method: "POST"
      }),
    onSuccess: refreshWorkshop
  });
  const openDraft = useMutation({
    mutationFn: async (moduleId: string) => {
      await requestJson("/api/admin/modules/rescan", { method: "POST" });
      return moduleId;
    },
    onSuccess: (moduleId) => {
      void refreshWorkshop();
      window.location.assign(`/m/${encodeURIComponent(moduleId)}`);
    }
  });
  const discardDraft = useMutation({
    mutationFn: (moduleId: string) =>
      requestJson(`/api/admin/modules/${encodeURIComponent(moduleId)}/draft`, {
        method: "DELETE"
      }),
    onSuccess: refreshWorkshop
  });
  const ship = useMutation({
    mutationFn: (moduleId: string) =>
      requestJson(`/api/admin/modules/${encodeURIComponent(moduleId)}/ship`, { method: "POST" }),
    onSuccess: refreshWorkshop
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
        actions={{
          onApprove: (buildId) => approve.mutate(buildId),
          onCancel: (buildId) => cancel.mutate(buildId),
          onOpenDraft: (moduleId) => openDraft.mutate(moduleId),
          onDiscardDraft: (moduleId) => {
            if (window.confirm("Discard this draft? This cannot be undone.")) {
              discardDraft.mutate(moduleId);
            }
          },
          onAskForChange: (moduleId) =>
            window.location.assign(`/m/${encodeURIComponent(moduleId)}`),
          onShip: (moduleId) => ship.mutate(moduleId)
        }}
      />
    </div>
  );
}
