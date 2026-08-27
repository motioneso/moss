import { useState } from "react";

import type { PaneProps } from "./settings-types";
import { PaneHead, Segmented } from "./settings-ui";
import { MemoryDashboardPane } from "./settings-memory-dashboard";
import { SettingsPeoplePane } from "./settings-people-pane";

type MemoryTab = "memory" | "people";

const TAB_OPTIONS: readonly { value: MemoryTab; label: string }[] = [
  { value: "memory", label: "Memory" },
  { value: "people", label: "People" }
];

export function MemoryPane(_props: PaneProps) {
  const [tab, setTab] = useState<MemoryTab>("memory");

  return (
    <>
      <PaneHead title="Memory & context" />

      <Segmented value={tab} options={TAB_OPTIONS} onChange={setTab} ariaLabel="Memory section" />

      {tab === "memory" ? <MemoryDashboardPane /> : <SettingsPeoplePane />}
    </>
  );
}
