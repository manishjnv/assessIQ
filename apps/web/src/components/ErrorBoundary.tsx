import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clientLog } from '../lib/logger';

interface State { failed: boolean }

/** Z-47: a render error shows a short message instead of a blank page, and goes to POST /api/_log. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // message + component stack only; no user data. clientLog caps msg at 200 chars and fields at 1 KB.
    clientLog('error', `render error: ${error.message}`, {
      kind: 'render-error',
      componentStack: (info.componentStack ?? '').slice(0, 800),
    });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" style={{ padding: 32, textAlign: 'center', fontFamily: 'var(--aiq-font-sans, sans-serif)' }}>
        <h1 style={{ fontSize: 24, fontWeight: 400 }}>Something went wrong. Reload the page.</h1>
        <p>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </p>
        <p><a href="/admin/login">Go to sign in</a></p>
      </main>
    );
  }
}
