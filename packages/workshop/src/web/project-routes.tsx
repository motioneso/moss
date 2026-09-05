import "./workshop.css";
import { useCallback, useEffect, useState } from "react";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { Routes, Route } from "react-router";
import { Button, EmptyState } from "@moss/ui";
import { requestJson } from "@moss/module-web-sdk";
import type { MeResponse } from "@moss/shared";
import { WorkshopPage } from "./workshop-page.js";
import {
  ProjectError,
  WorkshopProjectCreate,
  WorkshopProjectDetail,
  WorkshopProjectList
} from "./project-pages.js";

export function WorkshopProjectRoutes() {
  const client = useQueryClient();
  const [connection, setConnection] = useState<"ready" | "offline" | "refreshing" | "error">(() =>
    onlineManager.isOnline() ? "ready" : "offline"
  );
  const me = useQuery({
    queryKey: ["workshop", "me"],
    queryFn: () => requestJson<MeResponse>("/api/me"),
    retry: false,
    refetchOnReconnect: "always"
  });
  const reconnect = useCallback(async () => {
    if (!onlineManager.isOnline()) {
      setConnection("offline");
      return;
    }
    setConnection("refreshing");
    try {
      await client.invalidateQueries(
        { queryKey: ["workshop"], refetchType: "active" },
        { throwOnError: true }
      );
      setConnection(onlineManager.isOnline() ? "ready" : "offline");
    } catch {
      setConnection("error");
    }
  }, [client]);
  useEffect(
    () =>
      onlineManager.subscribe((online) => {
        if (online) void reconnect();
        else setConnection("offline");
      }),
    [reconnect]
  );
  if (!me.data) {
    return (
      <div className="workshop-page">
        {me.isError ? (
          <ProjectError
            title="Workshop could not check your account. Try again."
            retry={() => void me.refetch()}
          />
        ) : (
          <p role="status">Loading Workshop…</p>
        )}
      </div>
    );
  }
  if (!me.data.user.isInstanceAdmin)
    return (
      <div className="workshop-page">
        <EmptyState
          title="The Workshop is for instance admins"
          description="Ask an instance admin if you need something built."
        />
      </div>
    );
  const canMutate = connection === "ready" && !me.isFetching && !me.isError;
  return (
    <div className="workshop-page">
      {connection !== "ready" ? (
        <div role="status">
          <p>
            {connection === "offline"
              ? "You’re offline. Your unsent text stays here. Reconnect before making changes."
              : connection === "refreshing"
                ? "Refreshing your saved work before changes can resume…"
                : "Your saved work could not be refreshed. Try again before making changes."}
          </p>
          {connection === "error" ? (
            <Button variant="secondary" onClick={() => void reconnect()}>
              Reconnect
            </Button>
          ) : null}
        </div>
      ) : null}
      {me.isError ? (
        <ProjectError
          title="Your account could not be refreshed. Reload before making changes."
          retry={() => void reconnect()}
        />
      ) : null}
      <Routes>
        <Route index element={<WorkshopProjectList canMutate={canMutate} />} />
        <Route path="new" element={<WorkshopProjectCreate canMutate={canMutate} />} />
        <Route path="legacy" element={<WorkshopPage />} />
        <Route path=":projectId" element={<WorkshopProjectDetail canMutate={canMutate} />} />
        <Route path="*" element={<EmptyState title="This Workshop page was not found" />} />
      </Routes>
    </div>
  );
}
