import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportClientError } from "./global-error-handler.js";

// This boundary sits inside the app shell, around the routed page only. A page
// that fails to load or crashes while drawing shows this screen in the page
// area. The shell and its menu stay mounted, so the rest of Moss keeps working
// and the person can go somewhere else. Changing page clears the error.
interface RouteErrorBoundaryProps {
  readonly children: ReactNode;
  readonly resetKey: string;
}

interface RouteErrorBoundaryState {
  readonly hasError: boolean;
}

export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    void reportClientError({
      type: "react_error",
      message: error.message || "react render error",
      stack: error.stack
    });
  }

  componentDidUpdate(previousProps: RouteErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="jds-route-error" role="alert">
          <h1 className="jds-crash__title">This page could not be loaded.</h1>
          <p className="jds-crash__copy">
            This can happen when Moss has just been updated and this page is still the old version.
            Reloading usually fixes it. The rest of Moss is still working, and you can use the menu
            to go somewhere else.
          </p>
          <div className="jds-route-error__actions">
            <button className="jds-btn jds-btn--primary" type="button" onClick={this.handleReload}>
              Reload page
            </button>
            <button className="jds-btn jds-btn--secondary" type="button" onClick={this.handleRetry}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
