import "./workshop.css";

import { useQuery } from "@tanstack/react-query";
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

function useMyModuleBuilds() {
  const { data } = useQuery({
    queryKey: ["workshop", "module-builds", "mine"],
    queryFn: () => requestJson<ListMyModuleBuildsResponse>("/api/ai/module-builds/mine")
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
  const isInstanceAdmin = useIsInstanceAdmin();
  const builds = useMyModuleBuilds();
  const modules = useLiveModules();

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
      <WorkshopGroups builds={builds} modules={modules} />
    </div>
  );
}
