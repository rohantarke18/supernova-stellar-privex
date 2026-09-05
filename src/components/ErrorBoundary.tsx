import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  declare readonly props: Props;
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', gap: 16, fontFamily: 'monospace',
          background: '#0d0d1a', color: '#e0e0f0',
        }}>
          <div style={{ fontSize: 22, color: '#e0533e' }}>Something went wrong</div>
          <div style={{ color: '#8b8b9b', fontSize: 12, maxWidth: 480, textAlign: 'center' }}>
            {this.state.error?.message ?? 'Unknown error'}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 24px', background: '#7b6ef6', border: 'none',
              borderRadius: 6, color: '#fff', cursor: 'pointer', fontSize: 13,
            }}
          >
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
