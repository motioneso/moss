/**
 * #367 — auto-register a default chat-capable model on provider login `ready`.
 *
 * After a provider's login settles `ready`, the founder should have a working chat model with ZERO
 * manual entry (no Admin → Add provider → Add model detour). This service, called from the login
 * chokepoint (`persistLoginTerminal` ready branch, wired in @moss/module-registry), idempotently
 * ensures an AI provider config + a default chat model exist for the provider.
 *
 * PROVIDER-AGNOSTIC (CLAUDE.md Hard Invariant): the default lives in the per-provider data map
 * {@link DEFAULT_CHAT_MODELS}; the service is generic over `AiProviderKind`. Adding a provider is a
 * new map entry — no new code path. No provider/model is hardcoded in a code path.
 */

import type { AiModelCapability } from "@moss/shared";
import type { AiModelTier, AiProviderKind, DataContextDb } from "@moss/db";

import type { AiSecretCipher } from "./crypto.js";
import { discoverAndPersistModels } from "./discover-and-persist-models.js";
import { ModelDiscoveryService } from "./model-discovery.js";
import type { AiRepository } from "./repository.js";

/**
 * The sentinel `providerModelId` meaning "no concrete model — ride the CLI's interactive/account
 * model" (#367, superseding the original `sonnet`-pinning of decision 2a). Chat must never require
 * model selection: the registered default is the provider's interactive model, and the CLI launch
 * omits `--model` for this sentinel (see `buildClaudeCommand`). A concrete model id is set ONLY when
 * the founder picks an explicit override in settings, in which case `--model <id>` IS passed.
 */
export const DEFAULT_MODEL_SENTINEL = "default";

/** A provider's data-driven default chat model (registered on login `ready`). */
export interface DefaultChatModel {
  /**
   * The provider model id. The default is the {@link DEFAULT_MODEL_SENTINEL} (`"default"`) so chat
   * rides the CLI's own interactive/account model and never goes stale — a concrete pinned id is
   * used only for an explicit settings override, not the auto-registered default.
   */
  readonly providerModelId: string;
  /** Display name for the model row. */
  readonly displayName: string;
  /** Display name for the provider config created when none is reused. */
  readonly providerDisplayName: string;
  readonly tier: AiModelTier;
  readonly capabilities: readonly AiModelCapability[];
}

/**
 * Per-provider default chat model registered on login `ready`. Data-driven and provider-agnostic —
 * a provider WITHOUT an entry here is simply not auto-registered (no-op), never an error.
 *
 * Both providers default to the {@link DEFAULT_MODEL_SENTINEL} interactive model (#367): chat works
 * with zero model selection and never goes stale. The launch omits `--model` for the sentinel
 * (claude) / never passes it at all (codex), so the CLI rides its own interactive/account model; an
 * explicit settings override supplies a concrete id and `--model <id>` is then passed (claude path).
 */
export const DEFAULT_CHAT_MODELS: Partial<Record<AiProviderKind, DefaultChatModel>> = {
  anthropic: {
    providerModelId: DEFAULT_MODEL_SENTINEL,
    displayName: "Claude (default model)",
    providerDisplayName: "Claude",
    tier: "interactive",
    capabilities: ["chat"]
  },
  "openai-compatible": {
    // codex (the openai-compatible CLI) exposes NO concrete shipped default model id — with no
    // `--model` and no config it sends a server-resolved `<default>` sentinel and the backend picks
    // the current model. The default is the same {@link DEFAULT_MODEL_SENTINEL}, mirroring codex's
    // own behavior: `buildCodexCommand` omits `--model` for the sentinel so codex rides its own
    // interactive/account model. A concrete settings override DOES pass `--model <id>` (codex
    // accepts `-m/--model`), uniform with the claude/gemini launch paths.
    providerModelId: DEFAULT_MODEL_SENTINEL,
    displayName: "Codex (default model)",
    providerDisplayName: "Codex",
    tier: "interactive",
    capabilities: ["chat"]
  },
  // #2028 — google joins the other two now that chat can actually serve it. #2026 made the CLI
  // installable and #2027 gave it a login adapter; what was missing until now was a working chat
  // engine, which the one-shot Gemini engine supplies. The same sentinel rule applies: no
  // `--model` for the default, `--model <id>` only for an explicit settings override.
  google: {
    providerModelId: DEFAULT_MODEL_SENTINEL,
    displayName: "Gemini (default model)",
    providerDisplayName: "Gemini",
    tier: "interactive",
    capabilities: ["chat"]
  }
};

/** The seam the login flow calls on `ready`. Generic over `providerKind`. */
export interface AiAutoRegisterPort {
  ensureDefaultChatModel(
    scopedDb: DataContextDb,
    providerKind: AiProviderKind,
    options?: AiAutoRegisterOptions
  ): Promise<void>;
}

export interface AiAutoRegisterOptions {
  /**
   * #2205: the provider config the founder clicked "Log in" on (Settings → AI row). When set and it
   * is an assistant CLI config of this kind, it is the config to reuse — a `disabled` one is
   * reactivated rather than duplicated. Absent (onboarding wizard) ⇒ kind-only lookup as before.
   */
  readonly providerConfigId?: string;
}

/**
 * Idempotently ensures a CLI provider config + a default chat model exist for a provider after its
 * login settles `ready`. Idempotency / gate semantics (locked, #367):
 *
 *   - reuse an active config of this kind if present, else create one (`authMethod: "cli"`,
 *     `status: "active"`, NO real credential — the sealed `{ cli: true }` marker the Admin create
 *     path uses; the provider's auth lives in the cli-runner token store, not here);
 *   - create the default model ONLY when no chat-capable model row (ANY status) exists under an
 *     active config of this kind. This single gate is correct because models are never
 *     hard-deleted ("remove" = status `disabled`): it (a) avoids duplicates on re-login, (b) never
 *     resurrects a model the founder disabled, and (c) never clobbers a customized model (INSERT-only).
 *
 * Admin gating: the caller invokes this INSIDE the route's owner-admin-asserted, admin-scoped
 * `DataContextDb`; the branded handle + RLS ARE the gate (defense-in-depth), so this does not
 * re-assert. No secret is read, stored, logged, or returned here.
 */
export class AiAutoRegisterService implements AiAutoRegisterPort {
  private readonly repository: AiRepository;
  private readonly cipher: AiSecretCipher;
  private readonly modelDiscovery: ModelDiscoveryService;

  constructor(deps: {
    readonly repository: AiRepository;
    readonly cipher: AiSecretCipher;
    readonly modelDiscovery?: ModelDiscoveryService;
  }) {
    this.repository = deps.repository;
    this.cipher = deps.cipher;
    this.modelDiscovery = deps.modelDiscovery ?? new ModelDiscoveryService();
  }

  async ensureDefaultChatModel(
    scopedDb: DataContextDb,
    providerKind: AiProviderKind,
    options?: AiAutoRegisterOptions
  ): Promise<void> {
    const def = DEFAULT_CHAT_MODELS[providerKind];
    if (!def) return; // no catalog default for this provider — nothing to register.

    // #2205: the row the founder clicked wins. A disabled one is reactivated BEFORE the gates below
    // run, so its existing models count and no duplicate config/model set is created.
    const clicked = options?.providerConfigId
      ? await this.reactivateClickedProvider(scopedDb, options.providerConfigId, providerKind)
      : undefined;

    // #982/#869 D2: sentinel creation stays idempotent, but its gate must not skip static discovery.
    const hasChatModel = await this.repository.hasChatModelForProviderKind(scopedDb, providerKind);
    const existing =
      clicked ?? (await this.repository.findReusableProviderByKind(scopedDb, providerKind));
    if (hasChatModel && !existing) return;
    const providerConfig =
      existing ??
      (await this.repository.createProvider(scopedDb, {
        providerKind,
        displayName: def.providerDisplayName,
        status: "active",
        authMethod: "cli",
        // CLI providers carry NO real credential — seal the same `{ cli: true }` marker the Admin
        // create path uses (no secret is stored or logged).
        encryptedCredential: this.cipher.encryptJson({ cli: true })
      }));

    if (!hasChatModel) {
      await this.repository.createModel(scopedDb, {
        providerConfigId: providerConfig.id,
        providerModelId: def.providerModelId,
        displayName: def.displayName,
        capabilities: def.capabilities,
        status: "active",
        tier: def.tier
      });
    }

    // #982/#869/#1083 F2: login-ready is the founder's real connect path. Reconcile CLI concrete
    // rows with current statics while preserving unchanged ids; failure never invalidates readiness.
    try {
      await discoverAndPersistModels(
        scopedDb,
        {
          actorUserId: providerConfig.owner_user_id,
          providerId: providerConfig.id,
          providerKind: providerConfig.provider_kind,
          authMethod: providerConfig.auth_method,
          baseUrl: providerConfig.base_url,
          credential: { cli: true }
        },
        { repository: this.repository, modelDiscovery: this.modelDiscovery }
      );
    } catch {
      // Best-effort by contract: sentinel still provides chat if discovery ever fails.
    }

    // #982/#869 D5: CLI-login-first instances need the same sole-provider default as admin create.
    const providers = await this.repository.listProviders(scopedDb);
    if (
      providerConfig.status === "active" &&
      providers.filter((provider) => provider.status === "active").length === 1 &&
      !providers.some((provider) => provider.is_instance_default)
    ) {
      await this.repository.setInstanceDefaultProvider(scopedDb, providerConfig.id);
    }
  }

  /**
   * #2205: resolve the clicked config; flip `disabled → active` so it is selectable again. Returns
   * undefined when the id names nothing usable (wrong kind, revoked, voice, api-key) — the caller
   * then falls back to the kind-only path, never errors.
   */
  private async reactivateClickedProvider(
    scopedDb: DataContextDb,
    providerConfigId: string,
    providerKind: AiProviderKind
  ) {
    const target = await this.repository.findLoginTargetProvider(
      scopedDb,
      providerConfigId,
      providerKind
    );
    if (!target) return undefined;
    if (target.status === "active") return target;
    return this.repository.updateProvider(scopedDb, target.id, { status: "active" });
  }
}
