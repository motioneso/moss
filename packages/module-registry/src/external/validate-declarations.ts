import type {
  ExternalModuleNavigationEntry,
  ExternalModulePreferenceDeclaration
} from "@moss/module-sdk";

// Per-field validators for the data-only declarations an external module may contribute.
// Split out of validate.ts (#1725) to keep that file under the 1000-line check; each function
// appends to the caller's `errors` array and returns undefined unless everything validated,
// which is the convention the remaining blocks in validate.ts follow.

export function validateModuleNavigation(
  obj: Record<string, unknown>,
  // The module's own id, used for the anti-spoof prefix rule on nav entry ids.
  expectedId: string,
  errors: string[]
): readonly ExternalModuleNavigationEntry[] | undefined {
  // #1019: positive validation of the navigation declaration (previously forbidden — see
  // the FORBIDDEN_FIELDS carve-out above). Caps mirror the #964 database-capability rule:
  // bounded count, bounded string lengths, unknown keys rejected outright (rather than
  // silently dropped) so a manifest can't smuggle built-in-only fields like `permissionId`
  // / `featureFlagId` (ModuleNavigationEntryManifest) through the external ABI.
  let navigation: readonly ExternalModuleNavigationEntry[] | undefined;
  if (obj.navigation !== undefined) {
    if (!Array.isArray(obj.navigation)) {
      errors.push("navigation must be an array");
    } else if (obj.navigation.length === 0 || obj.navigation.length > 4) {
      errors.push("navigation must declare between 1 and 4 entries");
    } else {
      const ids = new Set<string>();
      const validated: ExternalModuleNavigationEntry[] = [];
      for (const entry of obj.navigation) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          errors.push("navigation entries must be objects");
          continue;
        }
        const navEntry = entry as Record<string, unknown>;
        const unknownKeys = Object.keys(navEntry).filter(
          (key) => !["id", "label", "path", "icon", "order", "badge"].includes(key)
        );
        if (unknownKeys.length > 0) {
          errors.push(`navigation entry contains unknown fields: ${unknownKeys.join(", ")}`);
        }
        const { id, label, path, icon, order, badge } = navEntry;
        let entryValid = unknownKeys.length === 0;

        // #1019 (D5): anti-spoof — a nav entry id must be prefixed with this module's own
        // id, mirroring the storage-namespace check above, so an external module can never
        // collide with a built-in HIDDEN_NAV_IDS / SECTION_OF key
        // (apps/web/src/app-route-metadata.ts).
        if (
          typeof id !== "string" ||
          id.length === 0 ||
          id.length > 64 ||
          (id !== expectedId && !id.startsWith(`${expectedId}.`))
        ) {
          errors.push(
            `navigation entry id must be "${expectedId}" or "${expectedId}.<slug>" (max 64 chars)`
          );
          entryValid = false;
        } else if (ids.has(id)) {
          errors.push(`navigation entry id must be unique: ${id}`);
          entryValid = false;
        } else {
          ids.add(id);
        }

        if (typeof label !== "string" || label.length === 0 || label.length > 40) {
          errors.push("navigation entry label must be a non-empty string (max 40 chars)");
          entryValid = false;
        }

        // #1019 (D3): path is validated module-relative here; apps/api/src/server.ts
        // serializeExternalModule is the ONLY place that turns it into a real route, by
        // prefixing it with /m/<moduleId>. Rejecting ".." "//" "\" "?" "#" and restricting
        // segments to [a-z0-9-] means a manifest can never smuggle an absolute or host
        // route through this field.
        if (
          typeof path !== "string" ||
          path.length === 0 ||
          path.length > 128 ||
          !/^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/.test(path)
        ) {
          errors.push(
            `navigation entry path must be a clean module-relative path (e.g. "/" or "/settings"): ${String(path)}`
          );
          entryValid = false;
        }

        if (
          icon !== undefined &&
          (typeof icon !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(icon))
        ) {
          errors.push("navigation entry icon must be a lowercase kebab-case slug (max 32 chars)");
          entryValid = false;
        }

        if (
          order !== undefined &&
          (typeof order !== "number" || !Number.isFinite(order) || Math.abs(order) > 10_000)
        ) {
          errors.push("navigation entry order must be a number with absolute value <= 10000");
          entryValid = false;
        }

        // #1285: badge is a closed enum with one member today — an object containing
        // EXACTLY the key `source`, valued strictly "notifications". Rejecting any other
        // shape outright (rather than normalizing it away) is deliberate: a future badge
        // source must be an explicit validator change, not something a manifest can opt
        // into by accident. See ExternalModuleNavigationEntry.badge (module-sdk) for why
        // this can never carry a module-supplied number.
        if (badge !== undefined) {
          if (typeof badge !== "object" || badge === null || Array.isArray(badge)) {
            errors.push("navigation entry badge must be an object");
            entryValid = false;
          } else {
            const badgeObj = badge as Record<string, unknown>;
            const badgeUnknownKeys = Object.keys(badgeObj).filter((key) => key !== "source");
            if (badgeUnknownKeys.length > 0 || badgeObj.source !== "notifications") {
              errors.push('navigation entry badge must be exactly {"source": "notifications"}');
              entryValid = false;
            }
          }
        }

        if (entryValid) {
          validated.push({
            id: id as string,
            label: label as string,
            path: path as string,
            ...(icon !== undefined ? { icon: icon as string } : {}),
            ...(order !== undefined ? { order: order as number } : {}),
            // #1285: the validator reconstructs from an allow-list — a field validated but
            // not re-emitted here vanishes with `ok: true` and nothing to say why (F1, the
            // exact bug class the #1282 briefing block hit). badge is safe to re-emit as-is
            // here because entryValid being true means the shape check above already passed.
            ...(badge !== undefined ? { badge: badge as { source: "notifications" } } : {})
          });
        }
      }
      if (errors.length === 0) {
        navigation = validated;
      }
    }
  }
  return navigation;
}

// #1725: positive validation of the preferences declaration. Same carve-out shape as #1019 did
// for navigation: `settings` stays in FORBIDDEN_FIELDS (it carries a React component the host
// would execute), while this data-only declaration lets an installed module have the on/off
// switches every compiled-in module already has. #1757 added whole numbers alongside the
// switches; free text and enums stay out, because both put module-authored strings into host UI.
//
// Appends to the caller's `errors` array and returns undefined unless every entry validated,
// matching how the other declaration blocks in validate.ts behave.
export function validateModulePreferences(
  obj: Record<string, unknown>,
  errors: string[]
): readonly ExternalModulePreferenceDeclaration[] | undefined {
  let preferences: readonly ExternalModulePreferenceDeclaration[] | undefined;
  if (obj.preferences !== undefined) {
    if (!Array.isArray(obj.preferences)) {
      errors.push("preferences must be an array");
    } else if (obj.preferences.length === 0 || obj.preferences.length > 8) {
      errors.push("preferences must declare between 1 and at most 8 entries");
    } else {
      const keys = new Set<string>();
      const validated: ExternalModulePreferenceDeclaration[] = [];
      for (const entry of obj.preferences) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          errors.push("preferences entries must be objects");
          continue;
        }
        const prefEntry = entry as Record<string, unknown>;
        // #1757: min/max are accepted for every entry and only meaningful on an integer, so
        // that a boolean declaring them fails loudly below rather than having them dropped.
        const unknownKeys = Object.keys(prefEntry).filter(
          (key) => !["key", "label", "description", "type", "default", "min", "max"].includes(key)
        );
        if (unknownKeys.length > 0) {
          errors.push(`preferences entry contains unknown fields: ${unknownKeys.join(", ")}`);
        }
        const { key, label, description, type, default: defaultValue, min, max } = prefEntry;
        let entryValid = unknownKeys.length === 0;

        if (typeof key !== "string" || !/^[a-z][a-zA-Z0-9]{0,39}$/.test(key)) {
          errors.push("preference key must be a lower camel-case identifier of at most 40 chars");
          entryValid = false;
        } else if (keys.has(key)) {
          errors.push(`preference key must be unique: ${key}`);
          entryValid = false;
        } else {
          keys.add(key);
        }

        if (typeof label !== "string" || label.length === 0 || label.length > 60) {
          errors.push("preference label must be a non-empty string (max 60 chars)");
          entryValid = false;
        }

        if (
          description !== undefined &&
          (typeof description !== "string" || description.length > 160)
        ) {
          errors.push("preference description must be a string of at most 160 chars");
          entryValid = false;
        }

        if (type !== "boolean" && type !== "integer") {
          errors.push('preference type must be "boolean" or "integer"');
          continue;
        }

        // The default is required, not optional: nothing is written to app.preferences at
        // install time, so an unwritten preference resolves to this value on every read.
        // A missing default would leave the resolved value undefined at invocation.
        if (type === "boolean") {
          if (min !== undefined || max !== undefined) {
            errors.push("preference min/max may only be declared on an integer preference");
            entryValid = false;
          }
          if (typeof defaultValue !== "boolean") {
            errors.push("preference default must be a boolean matching the declared type");
            entryValid = false;
          }
          if (entryValid) {
            validated.push({
              key: key as string,
              label: label as string,
              ...(description !== undefined ? { description: description as string } : {}),
              type: "boolean",
              default: defaultValue as boolean
            });
          }
          continue;
        }

        // #1757: an integer. Bounds are optional but must be whole numbers in the right
        // order when present, because the host renders them straight onto the input and a
        // reversed pair would produce a field nothing can satisfy.
        const boundsValid = [min, max].every(
          (bound) =>
            bound === undefined || (typeof bound === "number" && Number.isSafeInteger(bound))
        );
        if (!boundsValid) {
          errors.push("preference min and max must be whole numbers");
          entryValid = false;
        } else if (typeof min === "number" && typeof max === "number" && min > max) {
          errors.push("preference min must not be greater than max");
          entryValid = false;
        }

        // `null` is a real declaration, not a missing field: it says "unset" is a supported
        // end state for this number, which is what lets a Food target mean "no target" rather
        // than a target of zero. A numeric default must itself satisfy the declared bounds —
        // otherwise the very first read hands the module a value the user could never type.
        if (defaultValue !== null && !Number.isSafeInteger(defaultValue)) {
          errors.push("preference default must be a whole number or null");
          entryValid = false;
        } else if (
          typeof defaultValue === "number" &&
          boundsValid &&
          ((typeof min === "number" && defaultValue < min) ||
            (typeof max === "number" && defaultValue > max))
        ) {
          errors.push("preference default must fall within the declared min and max");
          entryValid = false;
        }

        if (entryValid) {
          validated.push({
            key: key as string,
            label: label as string,
            ...(description !== undefined ? { description: description as string } : {}),
            type: "integer",
            ...(min !== undefined ? { min: min as number } : {}),
            ...(max !== undefined ? { max: max as number } : {}),
            default: defaultValue as number | null
          });
        }
      }
      if (errors.length === 0) {
        preferences = validated;
      }
    }
  }
  return preferences;
}
