import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "../ui/Button";
import { groqService } from "../../services/groq/groqService";
import { useTheme } from "../common/ThemeProvider";

interface HeaderProps {
  title?: string;
  showBackButton?: boolean;
  actions?: React.ReactNode;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  showBackButton = false,
  actions,
}) => {
  const router = useRouter();
  const isInferenceReady = groqService.isInitialized();

  const handleBack = () => {
    // Always go to home when clicking back in the header
    // This is safer than router.back() which might exit the app if history is empty
    router.push("/");
  };

  return (
    <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8">
        <div className="flex items-center justify-between h-14 sm:h-16">
          {/* Left side */}
          <div className="flex items-center flex-1 min-w-0">
            {showBackButton && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleBack}
                className="mr-2 sm:mr-3 p-2"
              >
                <svg
                  className="h-4 w-4 sm:h-5 sm:w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
              </Button>
            )}

            <Link href="/" className="flex items-center min-w-0">
              <div className="flex-shrink-0">
                <div className="h-10 w-10 sm:h-12 sm:w-12 bg-blue-500 rounded-lg flex items-center justify-center">
                  <svg
                    className="h-6 w-6 sm:h-8 sm:w-8 text-white"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                    />
                  </svg>
                </div>
              </div>
              <div className="ml-3 sm:ml-4 min-w-0">
                <h1 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white truncate">
                  {title || "MEDDY"}
                </h1>
              </div>
            </Link>
          </div>

          {/* Right side - Actions */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            {actions}

            {/* API Key Status Indicator - Hidden on mobile */}
            <div className="hidden sm:flex items-center">
              <div
                className={`
                h-2 w-2 rounded-full mr-2
                ${isInferenceReady ? "bg-green-500" : "bg-red-500"}
              `}
              />
              <span className="text-xs text-gray-600 dark:text-gray-300">
                {isInferenceReady ? "Connected" : "No Inference Keys"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};

// Simple header for home page
export const SimpleHeader: React.FC = () => {
  const isInferenceReady = groqService.isInitialized();
  const { isDarkMode, toggleTheme } = useTheme();

  return (
    <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 lg:px-8">
        <div className="flex items-center justify-between h-14 sm:h-16">
          <div className="flex items-center flex-1 min-w-0">
            <div className="flex-shrink-0">
              <div className="h-10 w-10 sm:h-12 sm:w-12 bg-blue-500 rounded-lg flex items-center justify-center">
                <svg
                  className="h-6 w-6 sm:h-8 sm:w-8 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                  />
                </svg>
              </div>
            </div>
            <div className="ml-3 sm:ml-4 flex flex-col min-w-0">
              <h1 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white truncate">
                MEDDY
              </h1>
              <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 truncate">
                Made with ❤️ by Prayas
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2 sm:space-x-3">
            <div className="hidden sm:flex items-center">
              <div
                className={`
                h-2 w-2 rounded-full mr-2
                ${isInferenceReady ? "bg-green-500" : "bg-red-500"}
              `}
              />
              <span className="text-xs text-gray-600 dark:text-gray-300">
                {isInferenceReady ? "Connected" : "No Inference Keys"}
              </span>
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="p-2 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400"
              onClick={toggleTheme}
              aria-label={
                isDarkMode ? "Switch to light mode" : "Switch to dark mode"
              }
              title={
                isDarkMode ? "Switch to light mode" : "Switch to dark mode"
              }
            >
              {isDarkMode ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 3v1.5m0 15V21m8.25-9H21m-16.5 0H3m14.303 5.303 1.06 1.06M5.636 5.636l1.06 1.06m0 10.607-1.06 1.06m12.728-12.728-1.06 1.06M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
                  />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21.752 15.002A9.718 9.718 0 0112 21c-5.385 0-9.75-4.365-9.75-9.75 0-4.034 2.449-7.496 5.938-8.965a.75.75 0 01.98.899A7.5 7.5 0 0018.818 14.83a.75.75 0 01.899.98z"
                  />
                </svg>
              )}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="p-2 text-gray-600 dark:text-gray-300 hover:text-red-500 dark:hover:text-red-400"
              onClick={async () => {
                try {
                  const { createClient } = await import(
                    "@/utils/supabase/client"
                  );
                  const supabase = createClient();
                  const { error } = await supabase.auth.signOut();

                  if (error) {
                    console.error("Sign out error:", error);
                  }

                  // Force redirect to login page after sign out
                  window.location.href = "/login";
                } catch (error) {
                  console.error("Unexpected error during sign out:", error);
                  // Still redirect to login even if there's an error
                  window.location.href = "/login";
                }
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15M12 9l-3 3m0 0l3 3m-3-3h12.75"
                />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
};
