import type { ReactNode } from "react";

import { ErrorBoundary } from "./error-boundary.js";

// The routed page's own error boundary (#3383). All behaviour lives on
// ErrorBoundary's page variant. This wrapper only names the reset key, which
// is the page address, so moving to another page clears the error.
export function RouteErrorBoundary(props: {
  readonly children: ReactNode;
  readonly resetKey: string;
}) {
  return (
    <ErrorBoundary variant="page" resetKey={props.resetKey}>
      {props.children}
    </ErrorBoundary>
  );
}
