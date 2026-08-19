export function requiresCalendarConfirmation(params: { readonly jarvisCreated: boolean }): boolean {
  return !params.jarvisCreated;
}
