import { Component } from "react";

export default class ErrorBoundary extends Component {
  state = { error: null, showDetails: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  reset = () => this.setState({ error: null, showDetails: false });

  render() {
    const { error, showDetails } = this.state;
    if (!error) return this.props.children;

    const message = error?.message || String(error);
    const details = `${error?.stack || message}`;

    return (
      <div className="h-screen flex items-center justify-center p-6">
        <div className="max-w-xl w-full rounded-xl border border-red-200 dark:border-red-900 bg-white dark:bg-gray-800 shadow p-6">
          <h1 className="text-lg font-semibold text-red-600 dark:text-red-400">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
            Avio hit an unexpected error. Your Salesforce data was not modified.
          </p>
          <p className="mt-3 text-sm font-mono break-words text-gray-900 dark:text-gray-100">
            {message}
          </p>

          <div className="mt-4 flex gap-2">
            <button
              onClick={this.reset}
              className="px-3 py-1.5 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-700"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 rounded-md text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              Reload app
            </button>
            <button
              onClick={() => this.setState({ showDetails: !showDetails })}
              className="ml-auto px-3 py-1.5 rounded-md text-sm text-gray-600 dark:text-gray-400 hover:underline"
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
          </div>

          {showDetails && (
            <pre className="mt-3 max-h-64 overflow-auto rounded bg-gray-100 dark:bg-gray-900 p-3 text-xs whitespace-pre-wrap">
              {details}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
