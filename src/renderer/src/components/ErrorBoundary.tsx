import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one module's render failure from taking the whole app down.
 *
 * React 19 unmounts the entire root when a render throws, and there was no
 * boundary anywhere in the renderer: a throw in any module left a blank window
 * with the sidebar — the only route back to another module — gone with it, and
 * the failure reproduced on every reopen until the offending row was edited out
 * of SQLite by hand.
 *
 * `App` passes the active module as `resetKey`; when it changes the error is
 * cleared in `componentDidUpdate`, so a module that throws is recoverable by
 * navigating to a different module and back, without restarting. The boundary
 * instance is *not* remounted — it is not given a React `key` — so "remount" is
 * deliberately not what this describes. `resetKey`'s doc says the same.
 */
interface Props {
  /** Clears the error when this changes (the active module). */
  resetKey?: string;
  /**
   * What to show when a child throws. The default is the in-shell module
   * fallback, which offers the sidebar as a way out; the root boundary passes
   * its own, because at the root there is no sidebar left to point at.
   */
  fallback?: (error: Error) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The renderer has no logger and this is a local-first app with no crash
    // reporter, so the console is the only durable record. Keep the component
    // stack: it names which screen and which child threw.
    console.error("module render failed:", error, info.componentStack);
  }

  /**
   * Re-render the children after a failure, without depending on `resetKey`.
   *
   * The fallback used to tell the user to "reopen this one", which does not
   * work: `App` navigates with `setActive(m)`, and re-selecting the module
   * already active bails out of the state update, so `resetKey` never changes
   * and the error never clears. Only switching to a *different* module and back
   * cleared it. This gives the fallback a recovery path that is actually
   * reachable. Verified by test: same-key `componentDidUpdate` does not clear.
   */
  #retry = () => this.setState({ error: null });

  override componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error);
    return (
      <div className="module-error">
        <h2>Something went wrong in this screen</h2>
        <p className="muted">
          The rest of the app is still running. Try this screen again, or pick a different module from the
          sidebar. Nothing here was left half-written.
        </p>
        <pre>{error.message}</pre>
        <button type="button" onClick={this.#retry}>
          Try again
        </button>
      </div>
    );
  }
}
