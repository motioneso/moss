---
description: Strict design constraints and guidelines for the Moss Design System
---

# Moss Design System (UI Guidelines)

When modifying the UI or CSS in this repository, you MUST strictly adhere to the authored Moss design system patterns:

- **Never use inline styles:** Always use CSS classes and the authored stylesheet system.
- **Use Spacing Tokens:** Never hardcode pixel or rem values for margins, padding, or gaps (e.g., `16px`). Always use design system tokens like `var(--space-2)`, `var(--space-4)`, etc.
- **Use Authored Patterns:** Do not invent new UI layout patterns. Prioritize existing components from `@moss/ui` (like `<EmptyState>`) or established text patterns (like `.cmd-empty`) over custom HTML structures.
- **Respect Base Rules & Tokens:** When modifying global element styles (like buttons), adjust base rule `transition` properties instead of creating hover-specific transitions. Do not fork existing rules in a way that breaks existing tokens (e.g., light/dark mode compatibility). Always guard hover transitions with `:not(:focus-visible)` to preserve accessibility focus rings.
- **Scope Your CSS Fixes:** If a layout issue is specific to a single page (e.g., the notifications view), create a scoped modifier class rather than altering a shared primitive in `packages/ui/`, which can cause widespread side effects.
