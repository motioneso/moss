/** Optional host-provided page tools. An older host omits this handle; never fall back to chat approval. */
export interface ExternalModuleToolsHandleV1 {
  invoke(name: string, input: Record<string, unknown>): Promise<ModuleToolOutcome>;
}

export type ModuleToolOutcome =
  | { readonly status: "succeeded"; readonly result: Record<string, unknown> }
  | { readonly status: "cancelled" }
  | { readonly status: "rejected"; readonly moduleCode?: string }
  | { readonly status: "invalid_input" }
  /** The write ran, but its result was too large to return. Refresh to show it; never retry. */
  | { readonly status: "saved" }
  /** A write may have completed before a transport/result failure. Refresh before retrying. */
  | { readonly status: "failed" };
