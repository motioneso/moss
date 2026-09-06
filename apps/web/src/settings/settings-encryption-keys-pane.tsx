import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";

import type { FamilyKeyStatusDto } from "@moss/shared";
import { Button } from "@moss/ui";

import { getFamilyKeys, putFamilyKey, rotateFamilyKey } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";
import { Group, Note, PaneHead, Row } from "./settings-ui";

const FAMILY_LABELS: Record<string, { label: string; desc: string }> = {
  integrations: {
    label: "Integrations connections",
    desc: "Locks saved connection credentials for integrations."
  }
};

function familyLabel(family: string): { label: string; desc: string } {
  return (
    FAMILY_LABELS[family] ?? {
      label: family,
      desc: "Locks stored credentials for this feature."
    }
  );
}

function statusText(status: FamilyKeyStatusDto): string {
  if (status.source === "env") return "Ready (env file)";
  if (status.source === "store") return "Ready (stored)";
  if (status.source === "broken")
    return "Stopped: the stored key no longer opens. Features using it are paused.";
  return "Needs attention";
}

export function EncryptionKeysPane() {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();

  const statusQuery = useQuery({
    queryKey: queryKeys.ai.familyKeys,
    queryFn: getFamilyKeys,
    retry: false
  });
  const keys = statusQuery.data?.keys ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.ai.familyKeys });

  const generateMutation = useMutation({
    mutationFn: (family: string) => putFamilyKey({ family }),
    onSuccess: () => {
      void invalidate();
      toast("Encryption key ready", { icon: <KeyRound size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });
  const rotateMutation = useMutation({
    mutationFn: (family: string) => rotateFamilyKey({ family }),
    onSuccess: () => {
      void invalidate();
      toast("Encryption key rotated", { icon: <KeyRound size={17} /> });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  return (
    <>
      <PaneHead
        title="Encryption keys"
        desc="Some features pause until their key is set up. Keys are locked with your master secret and never shown here."
      />
      <Group title="Family keys">
        {statusQuery.isPending ? (
          <Note icon={<KeyRound size={13} />}>Checking key status…</Note>
        ) : null}
        {statusQuery.isError ? (
          <Note icon={<KeyRound size={13} />}>
            Could not check key status.{" "}
            <Button variant="quiet" size="sm" onClick={() => void statusQuery.refetch()}>
              Try again
            </Button>
          </Note>
        ) : null}
        {keys.map((status) => {
          const meta = familyLabel(status.family);
          const missing = status.source === "missing";
          const fromEnv = status.source === "env";
          const broken = status.source === "broken";
          const busy = generateMutation.isPending || rotateMutation.isPending;
          return (
            <Row
              key={status.family}
              name={meta.label}
              desc={`${meta.desc} ${statusText(status)}.${
                fromEnv ? " Managed in the env file; remove it there to move here." : ""
              }`}
              control={
                missing ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => generateMutation.mutate(status.family)}
                  >
                    {generateMutation.isPending ? "Generating…" : "Generate"}
                  </Button>
                ) : broken ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Replace this key? Anything locked under the old one stays unreadable."
                        )
                      ) {
                        rotateMutation.mutate(status.family);
                      }
                    }}
                  >
                    {rotateMutation.isPending ? "Replacing…" : "Replace key"}
                  </Button>
                ) : fromEnv ? undefined : (
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busy}
                    onClick={() => rotateMutation.mutate(status.family)}
                  >
                    {rotateMutation.isPending ? "Rotating…" : "Rotate"}
                  </Button>
                )
              }
            />
          );
        })}
      </Group>
    </>
  );
}
