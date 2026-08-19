# UI Polish & Layout Implementation Plan (v7 - Final)

This is the fully revised implementation plan based on Fable's second adversarial review.

---

## 1. Fix the Sidebar Text Contrast (All Themes)

**Goal:** Make the "PLAN" and "YOU" category headers in the sidebar brighter.
**File to edit:** `apps/web/src/styles/tokens.css`

**Steps:**

1. Open `apps/web/src/styles/tokens.css`.
2. Find the line (around line 275) that says:
   `--rail-fg-muted: rgba(237, 229, 210, 0.72);`
3. Change the `0.72` to `0.90`:
   `--rail-fg-muted: rgba(237, 229, 210, 0.90);`
4. Save the file.

---

## 2. Refresh the "Today" Screen Empty State

**Goal:** Make the empty state friendlier while strictly preserving the authored `.cmd-empty` pattern.
**File to edit:** `apps/web/src/today/today-page.tsx`

**Steps:**

1. Open `apps/web/src/today/today-page.tsx`.
2. Find this line (around line 436):
   `<p className="cmd-empty">No events today.</p>`
3. Replace it with:
   `<p className="cmd-empty">No events today. Enjoy the free time!</p>`
4. Save the file.

---

## 3. Keep the Tasks Empty State Icon

**Goal:** Keep the original double checkmark icon.
**File to edit:** None. (No-op)

---

## 4. Add Breathing Room to Notifications (Scoped Modifier)

**Goal:** Prevent long lists from feeling cramped by utilizing the existing `.tk-list` class and adding a `--loose` modifier for extra breathing room.
**Files to edit:** `apps/web/src/notifications/notifications-page.tsx` and `apps/web/src/styles/kit-tasks.css`

**Steps:**

1. Open `apps/web/src/notifications/notifications-page.tsx`.
2. Find the `<section className="tk-list">` that wraps the notifications (around line 96).
3. Change it to use a new modifier class alongside the base class: `<section className="tk-list tk-list--loose">`.
4. Open `apps/web/src/styles/kit-tasks.css`.
5. Find the `.tk-list` class (around line 404). Right beneath it, add the modifier:
   ```css
   .tk-list--loose {
     gap: var(--space-4);
   }
   ```
6. Save both files.

---

## 5. Settings Container Auto-Spacing (Targeted Fix)

**Goal:** Add a CSS class wrapper explicitly for the Segmented control to give it bottom margin without overcorrecting the global settings layout or relying on inline styles.
**Files to edit:** `apps/web/src/settings/settings-appearance-pane.tsx` and `apps/web/src/styles/settings.css`

**Steps:**

1. Open `apps/web/src/settings/settings-appearance-pane.tsx`.
2. Wrap the `<Segmented ariaLabel="Color mode" ... />` component inside a custom `div` with the class `appearance-theme-mode`, like this:
   ```tsx
   <div className="appearance-theme-mode">
     <Segmented
       ariaLabel="Color mode"
       value={activeMode}
       /* ... existing props ... */
     />
   </div>
   ```
3. Open `apps/web/src/styles/settings.css`.
4. Scroll to the bottom of the file and add the corresponding rule using a spacing token:
   ```css
   .appearance-theme-mode {
     margin-bottom: var(--space-4);
   }
   ```
5. Save both files.

---

## 6. Make Buttons Hover (Safe Transitions & Focus Guard)

**Goal:** Add a subtle tactile shadow to buttons on hover, ensuring focus rings aren't overwritten and transitions don't bleed onto non-button elements.
**File to edit:** `apps/web/src/styles.css`

**Steps:**

1. Open `apps/web/src/styles.css`.
2. Find the base transition rule (around line 161):
   ```css
   input,
   select,
   textarea,
   button,
   a {
     transition: box-shadow 0.1s var(--ease-out);
   }
   ```
3. Remove `button` from that list, and explicitly add a button-specific transition rule right below it:

   ```css
   input,
   select,
   textarea,
   a {
     transition: box-shadow 0.1s var(--ease-out);
   }

   button {
     transition:
       box-shadow 0.1s var(--ease-out),
       background-color 0.1s var(--ease-out);
   }
   ```

4. Now find the shared `:hover` rule for buttons (around line 203). Add `:not(:focus-visible)` to protect accessibility rings, and add the shadow token:
   ```css
   .secondary-button:hover:not(:focus-visible),
   .ghost-button:hover:not(:focus-visible),
   .icon-button:hover:not(:focus-visible) {
     background: var(--panel-subtle);
     box-shadow: var(--shadow-sm);
   }
   ```
5. Save the file.
