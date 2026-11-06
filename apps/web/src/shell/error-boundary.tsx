import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportClientError } from "./global-error-handler.js";

/**
 * React error boundary (#413). Wraps <App /> in main.tsx so a render-time crash
 * in any component is caught. The fallback UI renders ("Something went wrong.
 * Reload the page." + a reload button), and the error is reported to
 * /api/errors for observability.
 *
 * The page variant (#3383) sits inside the app shell around the routed page
 * only. A page that fails to load or crashes while drawing shows its own
 * fallback in the page area, with Reload page and Try again. The shell stays
 * mounted, so the rest of Moss keeps working. A changing resetKey (the page
 * address) clears the error, and showing the fallback unmounts the page, so
 * Try again mounts it fresh.
 *
 * This is functional default UI — no visual redesign (per spec). The fallback
 * is deliberately minimal so it cannot itself depend on any subsystem that
 * might have caused the crash.
 *
 * Reporting uses reportClientError, which is fire-and-forget and never throws,
 * so a failure during error reporting cannot crash the fallback.
 */
interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly variant?: "app" | "page";
  readonly resetKey?: string;
}
interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    void reportClientError({
      type: "react_error",
      message: error.message || "react render error",
      stack: error.stack
    });
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps): void {
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
    if (this.state.hasError && this.props.variant === "page") {
      return (
        <div className="jds-crash jds-crash--page" role="alert">
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
    if (this.state.hasError) {
      return (
        <div className="jds-crash" role="alert">
          <h1 className="jds-crash__title">Something went wrong.</h1>
          <p className="jds-crash__copy">Reload the page to continue.</p>
          <button className="jds-btn jds-btn--primary" type="button" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
