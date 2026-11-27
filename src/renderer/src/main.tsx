import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { ErrorBoundary } from "./components/ErrorBoundary";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

/**
 * The outermost boundary.
 *
 * `App` wraps each module screen in its own boundary, but that one lives
 * *inside* `App`, so it cannot catch a throw in `App`'s own render — or in the
 * sidebar, top bar and command palette, which render as its siblings. Without
 * this, a shell-level throw unmounted the root and left a blank window with no
 * way back, which is the failure `ErrorBoundary` exists to prevent.
 *
 * There is no sidebar to point at here, so the fallback is deliberately plain:
 * say what happened, show the message, and offer a reload.
 */
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error) => (
        <div className="app-error">
          <h1>SelfOS failed to start this screen</h1>
          <p className="muted">
            Nothing was written. Reloading usually clears it; if it keeps happening, the message below is the
            cause.
          </p>
          <pre>{error.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
