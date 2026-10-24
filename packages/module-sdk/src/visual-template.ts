/** Reviewed built-in visual contract. Browser-safe implementation belongs to the owning module. */
export interface ModuleVisualTemplate {
  readonly kind: string;
  readonly snapshotKind: string;
  readonly validate: (snapshot: unknown) => boolean;
  readonly format: (snapshot: unknown) => string;
}
