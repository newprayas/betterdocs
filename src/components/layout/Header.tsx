import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import clsx from "clsx";
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

export const ThemeToggleButton: React.FC<{ className?: string }> = ({
  className,
}) => {
  const { isDarkMode, toggleTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={clsx(
        "p-2 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400",
        className,
      )}
      onClick={toggleTheme}
      aria-label={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
      title={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
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
  );
};

// Simple header for home page
export const SimpleHeader: React.FC = () => {
  const isInferenceReady = groqService.isInitialized();

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

            <ThemeToggleButton />
            <Link
              href="/saved-answers"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z"
                />
              </svg>
              <span>Saved</span>
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
};
