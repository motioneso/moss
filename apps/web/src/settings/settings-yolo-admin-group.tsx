import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@moss/ui";
import {
  getAdminYoloSettings,
  postAdminYoloAllowAll,
  putAdminYoloInstance,
  putAdminYoloUser
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useAssistantName } from "../api/use-assistant-name";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Group, Row, Switch } from "./settings-ui";
import type { YoloAdminUserDto } from "@moss/shared";

function roleLabel(user: YoloAdminUserDto): string {
  return user.isBootstrapOwner ? "Owner" : user.isInstanceAdmin ? "Admin" : "Member";
}

export function YoloAdminGroup() {
  const queryClient = useQueryClient();
  const { toast, confirm } = useFeedback();
  const assistantName = useAssistantName();
  const [search, setSearch] = useState("");

  const yoloQuery = useQuery({
    queryKey: queryKeys.settings.adminYolo,
    queryFn: getAdminYoloSettings,
    retry: false
  });
  const yoloMutation = useMutation({
    mutationFn: (
      vars:
        | { kind: "instance"; enabled: boolean }
        | { kind: "user"; id: string; allowed: boolean }
        | { kind: "allowAll" }
    ) => {
      if (vars.kind === "instance") return putAdminYoloInstance({ enabled: vars.enabled });
      if (vars.kind === "allowAll") return postAdminYoloAllowAll();
      return putAdminYoloUser(vars.id, { allowed: vars.allowed });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings.adminYolo, data);
      toast("Auto-approve settings updated");
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const users = yoloQuery.data?.users ?? [];
  const activeCandidates = users.filter((u) => u.status === "active" && !u.yoloAllowed);
  const allowedUsers = users.filter((u) => u.yoloAllowed);

  const handleAdd = (id: string) => {
    yoloMutation.mutate({ kind: "user", id, allowed: true });
    setSearch("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && search) {
      e.preventDefault();
      let match = activeCandidates.find((u) => u.email === search);
      if (!match) {
        match = activeCandidates.find(
          (u) =>
            u.email.toLowerCase().includes(search.toLowerCase()) ||
            (u.name && u.name.toLowerCase().includes(search.toLowerCase()))
        );
      }
      if (match) {
        handleAdd(match.id);
      }
    }
  };

  const handleAddClick = () => {
    let match = activeCandidates.find((u) => u.email === search);
    if (!match) {
      match = activeCandidates.find(
        (u) =>
          u.email.toLowerCase().includes(search.toLowerCase()) ||
          (u.name && u.name.toLowerCase().includes(search.toLowerCase()))
      );
    }
    if (match) {
      handleAdd(match.id);
    }
  };

  return (
    <Group
      title="Auto-approve actions"
      desc="Blanket auto-approval for interactive chat actions. RLS and account permissions still apply."
    >
      <Row
        name="Instance master"
        desc="When off, every saved per-person auto-approve choice is ignored."
        control={
          <Switch
            ariaLabel="Auto-approve actions for this instance"
            checked={yoloQuery.data?.instanceEnabled ?? false}
            disabled={yoloMutation.isPending}
            onChange={(enabled) =>
              enabled
                ? confirm({
                    title: "Turn on auto-approve actions for this instance?",
                    description: `This also turns on auto-approve for your admin account. ${assistantName} can run destructive chat actions without asking.`,
                    confirmLabel: "Turn on",
                    danger: true,
                    onConfirm: () => yoloMutation.mutate({ kind: "instance", enabled })
                  })
                : yoloMutation.mutate({ kind: "instance", enabled })
            }
          />
        }
      />
      <Row
        name="Allow all current members"
        desc="Snapshot only. Future accounts still default off."
        control={
          <Button
            variant="quiet"
            size="sm"
            disabled={yoloMutation.isPending}
            onClick={() => yoloMutation.mutate({ kind: "allowAll" })}
          >
            Allow all
          </Button>
        }
      />
      <Row
        name="Add allowed member"
        desc="Active members who are not yet allowed to auto-approve."
        control={
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              className="jds-input"
              placeholder={
                activeCandidates.length
                  ? "Search members (Enter to add)"
                  : "No active members to add"
              }
              list="yolo-active-candidates"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={yoloMutation.isPending || activeCandidates.length === 0}
              aria-label="Search active members to add"
            />
            <datalist id="yolo-active-candidates">
              {activeCandidates.map((u) => (
                <option key={u.id} value={u.email} label={roleLabel(u)} />
              ))}
            </datalist>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Add allowed member"
              disabled={!search || yoloMutation.isPending || activeCandidates.length === 0}
              onClick={handleAddClick}
            >
              Add
            </Button>
          </div>
        }
      />
      {allowedUsers.map((user) => (
        <Row
          key={user.id}
          name={user.name || user.email}
          desc={`${roleLabel(user)} · ${user.yoloEnabled ? "self-enabled" : "self off"}${user.yoloActive ? " · active" : ""}`}
          control={
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Remove auto-approve allowance for ${user.email}`}
              disabled={yoloMutation.isPending}
              onClick={() => yoloMutation.mutate({ kind: "user", id: user.id, allowed: false })}
            >
              Remove
            </Button>
          }
        />
      ))}
    </Group>
  );
}
