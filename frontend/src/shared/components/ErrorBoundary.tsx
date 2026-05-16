import { Component, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.scss';

// Site-wide render-crash safety net. Wraps both the public and admin route
// trees in App.tsx with `key={location.pathname}`, so:
// - any render error inside a page surfaces this fallback INSTEAD of a blank
//   white screen (the symptom Daisy hit with /admin/messages/:id on
//   2026-05-16 when null spam_score crashed `.toFixed()` mid-render);
// - the key prop remounts the boundary on every nav, which automatically
//   clears the error state if the user reaches the broken route again from
//   a working one;
// - the fallback gives the user a way OUT of the error without retyping a
//   URL — the "Back" button calls `history.back()`, and "Try again" resets
//   state in case the trigger was transient (e.g. a flaky API response).
//
// Class component is required: React's error-boundary API is only exposed
// via componentDidCatch / getDerivedStateFromError. No hook equivalent.

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Hint for the fallback's title — e.g. "page" or "admin page". */
  scope?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Surface to `docker logs frontend` + browser DevTools. The
    // componentStack is non-standard React metadata — log both so the next
    // session has the trail without needing to repro from scratch.
    console.error('[ErrorBoundary] render crash', error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ error: null });
  };

  private handleBack = () => {
    // history.back() is preferred over navigate(-1): the latter requires
    // wiring useNavigate through a child component, which can't be done in a
    // class. history.back() is universal and React Router's listener picks
    // up the popstate so the SPA stays in sync.
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  };

  render() {
    if (this.state.error) {
      const scope = this.props.scope ?? 'page';
      return (
        <div className={styles.errorBoundary} role="alert">
          <div className={styles.card}>
            <span className={styles.tag} aria-hidden="true">
              ERR · RENDER-CRASH
            </span>
            <h2 className={styles.title}>This {scope} failed to load</h2>
            <p className={styles.body}>
              Something went wrong while rendering this view. The rest of the
              site is unaffected — you can go back or try again.
            </p>
            <details className={styles.details}>
              <summary>Technical details</summary>
              <pre className={styles.message}>{this.state.error.message}</pre>
            </details>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={this.handleBack}
              >
                ← Back
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                onClick={this.handleReset}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
