import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  // Optional label shown in the fallback message, e.g. the screen name.
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Catches render-time crashes in whatever screen is currently mounted
// (e.g. a bad/null field in imported data) so ONE broken record shows an
// error card in that screen instead of unmounting the entire app to a
// blank white page. Wrap this around the view-switch content area in
// App.tsx with `key={currentView}` so switching tabs resets the boundary.
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught render error' + (this.props.label ? ` in "${this.props.label}"` : ''), error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-8 max-w-2xl">
          <div className="bg-rose-50 border border-rose-200 rounded-2xl px-6 py-6">
            <h3 className="text-sm font-black text-rose-700 uppercase tracking-widest mb-2">
              This screen hit an error{this.props.label ? ` (${this.props.label})` : ''}
            </h3>
            <p className="text-sm text-rose-700 font-medium mb-1">
              {this.state.error.message}
            </p>
            <p className="text-xs text-rose-500 mt-3">
              This is usually caused by a bad or missing value in the data (e.g. a blank amount or date on an
              imported record). Other screens are unaffected — switch tabs to keep working, or check the browser
              console for details on what to fix.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
