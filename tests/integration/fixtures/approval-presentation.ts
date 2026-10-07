import {
  presentApprovalFields,
  type ApprovalFieldMap,
  type ModuleAssistantToolManifest
} from "@moss/module-sdk";

/** Explicit disclosure for synthetic tools with controlled labels and user-submitted fields. */
export function fixtureApproval(
  actionLabel: string,
  target: string,
  declarations: ApprovalFieldMap = {},
  required: readonly string[] = []
): Pick<ModuleAssistantToolManifest, "actionLabel" | "approvalPresentation" | "approvalContent"> {
  return {
    actionLabel,
    approvalContent: "user_authored",
    approvalPresentation: async (_db, input) => {
      const fields = presentApprovalFields(input, declarations, required);
      return fields ? { target, fields } : null;
    }
  };
}
