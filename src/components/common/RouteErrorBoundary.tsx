'use client';

import React from 'react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface RouteErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

export class RouteErrorBoundary extends React.Component<
  React.PropsWithChildren<{}>,
  RouteErrorBoundaryState
> {
  constructor(props: React.PropsWithChildren<{}>) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('🚨 [ROUTE_ERROR_BOUNDARY] Caught routing error:', {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      currentUrl: window.location.href
    });

    this.setState({ error, errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} errorInfo={this.state.errorInfo} />;
    }

    return this.props.children;
  }
}

function ErrorFallback({ error, errorInfo }: { error?: Error; errorInfo?: React.ErrorInfo }) {
  const router = useRouter();

  useEffect(() => {
    // Log detailed error information for debugging
    console.log('🔍 [ROUTE_ERROR_FALLBACK] Error details:', {
      errorMessage: error?.message,
      errorStack: error?.stack,
      componentStack: errorInfo?.componentStack,
      currentPath: window.location.pathname,
      referrer: document.referrer,
      timestamp: new Date().toISOString()
    });
  }, [error, errorInfo]);

  const handleReload = () => {
    window.location.reload();
  };

  const handleGoHome = () => {
    router.push('/');
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        <div className="mb-6">
          <div className="mx-auto w-16 h-16 bg-red-100 dark:bg-red-900 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-red-600 dark:text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
          </div>
          
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
            Navigation Error
          </h1>
          
          <p className="text-gray-600 dark:text-gray-300 mb-6">
            Something went wrong while loading this page. This might be a routing issue.
          </p>

          {process.env.NODE_ENV === 'development' && error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md text-left">
              <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
                Error Details (Development Mode):
              </p>
              <p className="text-xs text-red-600 dark:text-red-400 font-mono break-all">
                {error.message}
              </p>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <button
            onClick={handleReload}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Reload Page
          </button>
          
          <button
            onClick={handleGoHome}
            className="w-full px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
          >
            Go to Home
          </button>
        </div>

        <div className="mt-6 text-xs text-gray-500 dark:text-gray-400">
          Error ID: {Date.now()}
        </div>
      </div>
    </div>
  );
}

// Hook for functional components to catch errors
export function useRouteErrorHandler() {
  const router = useRouter();

  const handleRouteError = (error: Error, context?: string) => {
    console.error('🚨 [ROUTE_ERROR_HANDLER] Route error:', {
      error: error.message,
      stack: error.stack,
      context,
      currentPath: window.location.pathname,
      timestamp: new Date().toISOString()
    });

    // In production, you might want to send this to an error reporting service
    if (process.env.NODE_ENV === 'production') {
      // Example: sendToErrorReporting(error, context);
    }
  };

  const safeNavigate = (path: string, context?: string) => {
    try {
      console.log('🔍 [SAFE_NAVIGATE] Navigating to:', path, { context });
      router.push(path);
    } catch (error) {
      handleRouteError(error as Error, `navigation to ${path}`);
      // Fallback navigation
      window.location.href = path;
    }
  };

  return { handleRouteError, safeNavigate };
}