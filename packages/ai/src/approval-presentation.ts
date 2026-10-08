import { assertDataContextDb } from "@moss/db";
import { presentApprovalFields, type RouteApprovalPresentation } from "@moss/module-sdk";
import { CHAT_MODEL_FAVORITES_MAX } from "@moss/shared";
import { AiRepository } from "./repository.js";

const repository = new AiRepository();

/** Model IDs are resolved through the same owner-scoped catalog as the model picker. */
export const modelFavoritesPresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  if (Object.keys(input.params).length || Object.keys(input.query ?? {}).length) return null;
  const models = await repository.listModels(db);
  const identities: string[] = [];
  const fields = presentApprovalFields(
    input.body,
    {
      modelIds: {
        label: "Favorite models",
        present: (value) => {
          if (!Array.isArray(value) || value.length > CHAT_MODEL_FAVORITES_MAX) return null;
          if (value.length === 0) return [{ label: "Favorite models", value: "None" }];
          const rows: { label: string; value: string }[] = [];
          for (const [index, id] of value.entries()) {
            if (typeof id !== "string") return null;
            const model = models.find((entry) => entry.id === id);
            if (!model?.display_name.trim() || !model.provider_display_name.trim()) return null;
            identities.push(model.id, model.provider_config_id);
            rows.push({
              label: `Favorite model ${index + 1}`,
              value: `${model.display_name} (${model.provider_display_name})`
            });
          }
          return rows;
        }
      }
    },
    ["modelIds"]
  );
  return fields ? { target: "Chat models", fields, version: JSON.stringify(identities) } : null;
};
