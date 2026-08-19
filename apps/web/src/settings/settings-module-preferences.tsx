// apps/web/src/settings/settings-module-preferences.tsx
//
// #1725: the host-rendered settings page for an installed module's declared on/off
// switches. The module supplies labels and defaults in its manifest and nothing else — no
// module code runs here, which is the whole reason a distributable module can have a
// settings page at all (a module-authored React surface stays forbidden; see
// FORBIDDEN_FIELDS in the external manifest validator).
//
// Everything below is built from existing settings primitives (ModuleSub / Group / Row /
// Switch). No new classes, no module-specific styling: two modules with the same
// declarations render identically.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";

import type { ListModulePreferencesResponse } from "@moss/shared";

import { getModulePreferences, updateModulePreferences } from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { ModuleSub } from "./settings-module-subviews";
import { readError } from "./settings-types";
import { Group, Row, Switch } from "./settings-ui";

export function ModulePreferencesSettings(props: {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useFeedback();
  const queryKey = queryKeys.modulePreferences(props.moduleId);
  const preferencesQuery = useQuery({
    queryKey,
    queryFn: () => getModulePreferences(props.moduleId),
    retry: false
  });

  const mutation = useMutation({
    mutationFn: (input: { readonly key: string; readonly value: boolean }) =>
      updateModulePreferences(props.moduleId, { [input.key]: input.value }),
    // The switch moves the moment the write lands, from the server's own values — never
    // optimistically, so a rejected write can't leave the pane showing a setting the
    // module will not actually see.
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, (current) => {
        const existing = current as ListModulePreferencesResponse | undefined;
        if (!existing) return current;
        return {
          preferences: existing.preferences.map((preference) => ({
            ...preference,
            value: data.preferences[preference.key] ?? preference.value
          }))
        };
      });
    },
    onError: (error) => toast(readError(error), { tone: "drift" })
  });

  const preferences = preferencesQuery.data?.preferences ?? [];

  return (
    <ModuleSub
      icon={<SlidersHorizontal size={21} aria-hidden="true" />}
      name={props.moduleName}
      sub="What this module is allowed to do for you"
      onBack={props.onBack}
    >
      <Group title="Options" desc={`Settings ${props.moduleName} offers.`}>
        {preferencesQuery.isLoading ? (
          <Row name="Loading settings" />
        ) : preferencesQuery.isError ? (
          <Row name="These settings could not be loaded" desc={readError(preferencesQuery.error)} />
        ) : preferences.length === 0 ? (
          <Row name="This module has no settings" desc="Nothing to configure here yet." />
        ) : (
          preferences.map((preference) => (
            <Row
              key={preference.key}
              name={preference.label}
              desc={preference.description ?? undefined}
              control={
                <Switch
                  ariaLabel={preference.label}
                  checked={preference.value}
                  disabled={mutation.isPending}
                  onChange={(checked) => mutation.mutate({ key: preference.key, value: checked })}
                />
              }
            />
          ))
        )}
      </Group>
    </ModuleSub>
  );
}
