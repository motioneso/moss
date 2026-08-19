import type { FastifyReply } from "fastify";

import type { AdminAuditEvent, DataContextDb, InstanceSetting, User } from "@moss/db";
import type { AdminAuditEventDto, InstanceSettingDto, MyModuleDto, UserDto } from "@moss/shared";
import type { MossModuleManifest } from "@moss/module-sdk";
import { handleRouteError as handleModuleRouteError } from "@moss/module-sdk";

import { HttpRepositoryError, type SettingsRepository } from "./repository.js";

export function toMyModuleDto(
  manifest: MossModuleManifest,
  instanceDisabled: boolean,
  userDisabled: boolean
): MyModuleDto {
  const required = manifest.availability?.required === true;
  const userDisableSupported = manifest.availability?.supportsUserDisable !== false;
  const active = required
    ? true
    : instanceDisabled
      ? false
      : userDisableSupported && userDisabled
        ? false
        : true;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    lifecycle: manifest.lifecycle,
    required,
    supportsUserDisable: userDisableSupported,
    instanceDisabled,
    userDisabled,
    active,
    // #1725: the flag, not the declarations — the pane fetches those from
    // /api/modules/:id/preferences when the user actually opens it.
    hasPreferences: (manifest.preferences?.length ?? 0) > 0
  };
}

export async function computeMyModuleDto(
  repository: SettingsRepository,
  scopedDb: DataContextDb,
  manifest: MossModuleManifest,
  actorUserId: string
): Promise<MyModuleDto> {
  const rows = await repository.listModuleDenyRowsForActor(scopedDb);
  const instanceDisabled = rows.some((r) => r.scope === "instance" && r.module_id === manifest.id);
  const userDisabled = rows.some(
    (r) => r.scope === "user" && r.module_id === manifest.id && r.user_id === actorUserId
  );
  return toMyModuleDto(manifest, instanceDisabled, userDisabled);
}

export function serializeUser(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.email_verified,
    name: user.name,
    isInstanceAdmin: user.is_instance_admin,
    status: user.status,
    isBootstrapOwner: user.is_bootstrap_owner,
    createdAt: serializeDate(user.created_at),
    updatedAt: serializeDate(user.updated_at)
  };
}

export function serializeInstanceSetting(setting: InstanceSetting): InstanceSettingDto {
  return {
    key: setting.key,
    value: setting.value,
    updatedByUserId: setting.updated_by_user_id,
    createdAt: serializeDate(setting.created_at),
    updatedAt: serializeDate(setting.updated_at)
  };
}

export function serializeAdminAuditEvent(event: AdminAuditEvent): AdminAuditEventDto {
  return {
    id: event.id,
    actorUserId: event.actor_user_id,
    action: event.action,
    targetType: event.target_type,
    targetId: event.target_id,
    metadata: event.metadata,
    requestId: event.request_id,
    createdAt: serializeDate(event.created_at)
  };
}

export function serializeDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function handleRouteError(error: unknown, reply: FastifyReply) {
  return handleModuleRouteError(error, reply, {
    mappers: [
      (e, r) =>
        e instanceof HttpRepositoryError
          ? r.code(e.statusCode).send({ error: e.message })
          : undefined,
      (e, r) => {
        if (e instanceof Error) {
          const code = (e as Error & { code?: string }).code;
          if (code === "account_pending_approval" || code === "account_deactivated") {
            return r.code(403).send({ error: e.message, code });
          }
        }
        return undefined;
      }
    ]
  });
}
