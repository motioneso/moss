import { PlugZap } from "lucide-react";
import { Link } from "react-router";

import { useAssistantName } from "../api/use-assistant-name";

/** Deep-link to the Assistant & AI settings pane (the post-onboarding provider-connect surface).
 *  settings-page reads `?section=` to open the right pane instead of the default Profile pane. */
export const CONNECT_PROVIDER_HREF = "/settings?section=assistant";

/**
 * #369 — empty-chat explainer. When chat has no active model, the drawer shows this instead of
 * the suggestion seeds (and the raw "No active chat-capable model is configured" 400). It gives a
 * direct path to connect a provider. Provider-agnostic: it names no specific provider/model.
 *
 * `isFounder` tailors the copy (the founder set the instance up) but both roles get a working
 * link to Settings → Assistant & AI, which is the connect surface available after onboarding.
 */
export function ConnectProviderEmpty(props: { readonly isFounder: boolean }) {
  const assistantName = useAssistantName("");
  return (
    <div className="chatd-empty chatd-empty--connect">
      <span className="chatd-empty__mark">
        <PlugZap size={22} aria-hidden="true" />
      </span>
      <div className="chatd-empty__title">Connect a provider to start chatting</div>
      <div className="chatd-empty__sub">
        {props.isFounder
          ? assistantName
            ? `No AI provider is connected yet. Connect one to bring ${assistantName} online.`
            : "No AI provider is connected yet. Connect one to start chatting."
          : "Chat isn't available until an AI provider is connected for this instance."}
      </div>
      <Link className="primary-button chatd-empty__cta" to={CONNECT_PROVIDER_HREF}>
        Connect a provider
      </Link>
    </div>
  );
}
