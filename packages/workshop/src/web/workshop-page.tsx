import "./workshop.css";

import { WorkshopGroups } from "./workshop-groups.js";

// Real build/module data is wired once #1752/#1753 land the backend routes; the page renders
// its groups against empty lists for now, which falls through to WorkshopGroups' empty state.
export function WorkshopPage() {
  return (
    <div className="workshop-page">
      <header className="workshop-head">
        <span className="jds-eyebrow jds-eyebrow--muted">Modules</span>
        <h1 className="jds-display jds-display--md">The workshop</h1>
        <p className="workshop-lede">See what Moss is building for you, and what's already running.</p>
      </header>
      <WorkshopGroups builds={[]} modules={[]} />
    </div>
  );
}
