import React from 'react';
import clsx from 'clsx';

interface LoadingProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
  className?: string;
  overlay?: boolean;
}

export const Loading: React.FC<LoadingProps> = ({
  size = 'md',
  text,
  className,
  overlay = false,
}) => {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-6 w-6',
    lg: 'h-8 w-8',
  };

  const containerClasses = clsx(
    'flex items-center justify-center',
    overlay && 'fixed inset-0 bg-black bg-opacity-50 z-50',
    className
  );

  const spinner = (
    <svg
      className={clsx('animate-spin text-blue-600 dark:text-blue-400', sizeClasses[size])}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );

  if (overlay) {
    return (
      <div className={containerClasses}>
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-lg">
          <div className="flex flex-col items-center space-y-3">
            {spinner}
            {text && (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {text}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={containerClasses}>
      <div className="flex items-center space-x-3">
        {spinner}
        {text && (
          <span className="text-sm text-gray-600 dark:text-gray-300">
            {text}
          </span>
        )}
      </div>
    </div>
  );
};

interface LoadingSkeletonProps {
  lines?: number;
  className?: string;
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
  lines = 3,
  className,
}) => {
  return (
    <div className={clsx('space-y-3', className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          className="h-4 bg-gray-200 dark:bg-gray-700 rounded animate-pulse"
          style={{
            width: `${Math.random() * 40 + 60}%`, // Random width between 60-100%
          }}
        />
      ))}
    </div>
  );
};

interface LoadingCardProps {
  title?: boolean;
  lines?: number;
  className?: string;
}

export const LoadingCard: React.FC<LoadingCardProps> = ({
  title = true,
  lines = 3,
  className,
}) => {
  return (
    <div className={clsx('bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6', className)}>
      {title && (
        <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded mb-4 animate-pulse w-3/4" />
      )}
      <LoadingSkeleton lines={lines} />
    </div>
  );
};