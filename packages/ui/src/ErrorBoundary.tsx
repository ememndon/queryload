import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}
interface State {
  readonly error: Error | null;
}

/**
 * App-wide error boundary. Without it, any render-time throw in a view unmounts
 * the entire React tree and leaves a blank window with no recovery. Here we
 * catch it, show a legible fallback using the existing warning styling, and
 * offer a reload — one bad view no longer white-screens the whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced to the renderer console, which the desktop dev build forwards to
    // the terminal (window.ts). No remote reporting — nothing leaves the machine.
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="banner-warn" style={{ margin: 48 }} role="alert">
        Something went wrong in the interface.
        <br />
        {error.message}
        <br />
        <button
          className="btn"
          style={{ marginTop: 16 }}
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
