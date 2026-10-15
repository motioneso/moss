# 0011 — Meals: meal planning lives in a Kitchen, shared only through linked members

**Status:** proposed (2026-10-09).

Meal planning data (Household members, Pantry, Meal plans, Shopping lists) belongs to a
**Kitchen**, not directly to a user. Every Moss user starts with their own Kitchen. A Kitchen
becomes shared only when one of its Household members is linked to another Moss user who lives
there; both users then see and edit the same members, pantry, plans and lists. Each user's own
food log stays private. A user belongs to at most one Kitchen. Ownership is stored on the Kitchen
from day one, so sharing is a membership change rather than a data migration. The pattern mirrors
the finance module's shared household area.

Using Moss in the same deployment does not imply sharing. Family members who use Moss but live
elsewhere keep separate Kitchens.

## Joining, leaving and permissions

- Linking a Household member to a Moss user sends that user an invite. They join the Kitchen
  only after accepting.
- On joining, the user's own Kitchen is put away, not deleted. They may copy Pantry items into
  the shared Kitchen first. If they later leave, their old Kitchen comes back.
- The Kitchen owner alone invites, removes members and deletes the Kitchen. Everyone in the
  Kitchen edits members, Pantry, Meal plans and Shopping lists.
- Sharing ships in phase 5. Earlier phases store the account link only.
- Sharing needs a platform contract for cross-user row access. Module tables today get an
  owner-only policy, so a Kitchen visible to several users is a separate blocker issue.

## Considered Options

- **Share item by item** (share one plan or list via the shares table). Simpler, but each user
  keeps their own pantry and household list, so the two copies drift. Rejected.
- **Owner-scoped tables with sharing bolted on later.** Cheapest for v1, but every table would need
  re-keying when sharing arrives. Rejected.
