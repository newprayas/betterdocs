import React from "react";

interface LoadingScreenProps {
  progress?: number;
  message?: string;
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({
  progress = 0,
  message = "Preparing your workspace...",
}) => {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-gray-900 p-4">
      <div className="w-full max-w-md flex flex-col items-center space-y-6">
        {/* Logo or Icon */}
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-600 shadow-lg shadow-blue-500/20">
          <svg
            className="w-8 h-8 text-white"
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

        {/* Text */}
        <div className="text-center space-y-2">
          <h2 className="text-xl font-semibold text-white">
            {message}
          </h2>
          <p className="text-sm text-gray-400">
            Loading your conversations...
          </p>
        </div>

        {/* Progress Bar */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-800">
          <div
            className="bg-blue-600 h-full rounded-full transition-all duration-300 ease-out"
            style={{ width: `${Math.max(5, Math.min(100, progress))}%` }}
          />
        </div>

        {/* Percentage */}
        <div className="text-xs font-medium text-gray-500">
          {Math.round(progress)}%
        </div>
      </div>
    </div>
  );
};
