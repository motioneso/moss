import "./workshop.css";

import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@moss/ui";
import { requestJson } from "@moss/module-web-sdk";
import type { MeResponse } from "@moss/shared";

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

// Real build/module data is wired once #1752/#1753 land the backend routes; the page renders
// its groups against empty lists for now, which falls through to WorkshopGroups' empty state.
export function WorkshopPage() {
  const isInstanceAdmin = useIsInstanceAdmin();

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
      <WorkshopGroups builds={[]} modules={[]} />
    </div>
  );
}
