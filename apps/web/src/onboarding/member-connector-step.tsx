import { useAssistantName } from "../api/use-assistant-name.js";
import { GoogleConnectorStep } from "./google-connector-step";

export function MemberConnectorStep() {
  const assistantName = useAssistantName();
  return (
    <GoogleConnectorStep
      eyebrow="Step 2 · Optional"
      title="Connect your accounts"
      lede={`Connecting Google allows ${assistantName} to check your calendar for scheduling and scan email for new tasks.`}
      privacy="Your connected accounts are private to you and are not shared."
    />
  );
}
