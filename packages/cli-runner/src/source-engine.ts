import {
  CliChatUnavailableError,
  CliSourceEngine,
  type RpcSourceGenerationLaunchParams
} from "@moss/chat/live";
import { scopedClaudeTokenPath } from "./fresh-cli-login.js";
import { publishGeminiCredential, scopedGeminiCredentialPath } from "./gemini-credential-store.js";

/** Source credential authority belongs to the runner, never a caller-supplied filesystem path.
 * Gemini is an internal composition candidate; EngineHost keeps its dispatch gate closed.
 */
export function createScopedSourceEngine(
  homeBase: string,
  params: RpcSourceGenerationLaunchParams
): CliSourceEngine {
  if (params.provider === "anthropic")
    return new CliSourceEngine("anthropic", scopedClaudeTokenPath(homeBase, params.scope));
  if (params.provider !== "google")
    throw new CliChatUnavailableError("source generation is unavailable for this provider");
  return new CliSourceEngine(
    "google",
    scopedGeminiCredentialPath(homeBase, params.scope),
    async (version, credential, isCurrent) => {
      await publishGeminiCredential(homeBase, params.scope, credential, {
        kind: "refresh",
        expectedVersion: version,
        isCurrent,
        onPublished: () => {}
      });
    }
  );
}
