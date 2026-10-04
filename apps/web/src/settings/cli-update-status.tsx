import type { AiCliToolsDto } from "@moss/shared";
import { Button } from "@moss/ui";

import { Badge } from "./settings-ui";
import { assistantName } from "../api/use-assistant-name";

/**
 * #2689 slice 4: what a tool update is doing, beside the version on a CLI provider card. The text
 * comes from the server's stored state. Retry shows only for the two states an admin can act on.
 */
export function CliUpdateStatus(props: {
  readonly tools: AiCliToolsDto | undefined;
  readonly name: string;
  readonly onRetry: () => void;
  readonly retrying?: boolean;
}) {
  const { tools } = props;
  if (!tools) return null;
  const next = tools.candidateVersion ? ` ${tools.candidateVersion}` : "";
  const retry = (
    <Button variant="quiet" size="sm" disabled={props.retrying} onClick={props.onRetry}>
      {props.retrying ? "Checking" : "Retry"}
    </Button>
  );
  switch (tools.state) {
    case "checking":
      return <Badge tone="steel">{`Updating to${next || " a newer version"}`}</Badge>;
    case "held_back":
      return (
        <>
          <span title={tools.reason ? `Version${next} ${tools.reason}` : undefined}>
            <Badge tone="amber">{`Version${next} held back`}</Badge>
          </span>
          {retry}
        </>
      );
    case "needs_newer_moss":
      return <Badge tone="neutral">{`Version${next} needs a newer ${assistantName()}`}</Badge>;
    case "cannot_check":
      return (
        <>
          <Badge tone="amber">Can&apos;t check for updates</Badge>
          {retry}
        </>
      );
    default:
      return null;
  }
}
