'use client';

import { createClient } from '@/utils/supabase/client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function LoginContent() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const supabase = createClient();

  useEffect(() => {
    // Handle error messages returned from Supabase redirects
    const errorMsg = searchParams.get('error_description') || searchParams.get('error');
    if (errorMsg) {
      setError(errorMsg);
    }
  }, [searchParams]);

  const handleGoogleLogin = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Get the URL to redirect to after login (if the user was kicked here by middleware)
      const next = searchParams.get('redirectedFrom') || '/';
      
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Redirect to our callback route, passing the 'next' destination
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });

      if (error) throw error;
    } catch (err: any) {
      setError(err.message);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 py-12 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="h-16 w-16 bg-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-blue-900/20">
            <svg
              className="h-10 w-10 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
              />
            </svg>
          </div>
          
          <h2 className="text-3xl font-bold tracking-tight text-white">
            Welcome to Meddy
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Your private RAG medical assistant
          </p>
        </div>

        <div className="mt-10 sm:mx-auto sm:w-full sm:max-w-[400px]">
          <div className="bg-slate-900 px-6 py-12 shadow-xl rounded-xl border border-slate-800 sm:px-10">
            <div className="space-y-6">
              <div>
                <button
                  onClick={handleGoogleLogin}
                  disabled={isLoading}
                  className="flex w-full items-center justify-center gap-3 rounded-lg bg-white px-3 py-3 text-sm font-semibold text-gray-900 shadow-sm hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {isLoading ? (
                    <div className="h-5 w-5 border-2 border-gray-900 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M12.0003 20.45C16.667 20.45 20.5855 17.2721 20.5855 12.3053C20.5855 11.6601 20.5288 11.034 20.4198 10.4286H12.0003V13.8631H16.8143C16.6062 14.9877 15.9736 15.9529 15.0289 16.5862L17.9152 18.8267C19.6047 17.2709 20.5855 14.9786 20.5855 12.3053Z"
                        fill="#4285F4"
                      />
                      <path
                        d="M12.0001 20.45C14.3164 20.45 16.2629 19.6826 17.915 18.8267L15.0287 16.5862C14.2604 17.1013 13.2751 17.4072 12.0001 17.4072C9.76451 17.4072 7.87197 15.8973 7.19572 13.8633H4.21313V16.1776C5.87979 19.4935 9.27851 20.45 12.0001 20.45Z"
                        fill="#34A853"
                      />
                      <path
                        d="M7.19559 13.8633C7.02353 13.3481 6.92987 12.8005 6.92987 12.2361C6.92987 11.6717 7.02353 11.1241 7.19559 10.6089V8.29462H4.213C3.60759 9.5005 3.2666 10.8354 3.2666 12.2361C3.2666 13.6369 3.60759 14.9718 4.213 16.1776L7.19559 13.8633Z"
                        fill="#FBBC05"
                      />
                      <path
                        d="M12.0001 7.06517C13.2604 7.06517 14.4001 7.49894 15.2895 8.3496L17.969 5.67004C16.3475 4.15939 14.3562 3.75 12.0001 3.75C9.27851 3.75 5.87979 4.70656 4.21313 8.02246L7.19572 10.3367C7.87197 8.30263 9.76451 7.06517 12.0001 7.06517Z"
                        fill="#EA4335"
                      />
                    </svg>
                  )}
                  <span className="text-base">Sign in with Google</span>
                </button>
              </div>
            </div>

            {error && (
              <div className="mt-6 rounded-md bg-red-900/30 border border-red-900 p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-200">Authentication Error</h3>
                    <div className="mt-1 text-sm text-red-300">{error}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
          
          <p className="mt-8 text-center text-xs text-slate-500">
            By signing in, you agree to our Terms of Service and Privacy Policy
          </p>
        </div>
      </div>
    </div>
  );
}

// Simple loading fallback component
function LoginLoadingFallback() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 py-12 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="h-16 w-16 bg-blue-600 rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-blue-900/20">
            <div className="h-10 w-10 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-white">
            Welcome to Meddy
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Your private RAG medical assistant
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginLoadingFallback />}>
      <LoginContent />
    </Suspense>
  );
}
