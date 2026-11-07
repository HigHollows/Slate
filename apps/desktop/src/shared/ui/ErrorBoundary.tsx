import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';

interface Props {
  children: ReactNode;
  title: string;
  retryLabel: string;
}
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="grid h-full place-items-center p-8 text-center">
        <div className="space-y-3">
          <p className="font-semibold">{this.props.title}</p>
          <p className="text-muted">{this.state.error.message}</p>
          <Button onClick={() => this.setState({ error: null })}>{this.props.retryLabel}</Button>
        </div>
      </div>
    );
  }
}
