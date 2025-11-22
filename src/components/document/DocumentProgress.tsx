import React from 'react';
import { DocumentProgress as DocumentProgressType } from '../../types';
import { Card } from '../ui/Card';
import { Loading } from '../ui/Loading';
import clsx from 'clsx';

interface DocumentProgressProps {
  progress: DocumentProgressType;
  filename: string;
  fileSize?: number;
  className?: string;
}

export const DocumentProgress: React.FC<DocumentProgressProps> = ({
  progress,
  filename,
  fileSize,
  className,
}) => {
  const getStatusIcon = () => {
    switch (progress.status) {
      case 'pending':
        return (
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'processing':
        return <Loading size="sm" />;
      case 'completed':
        return (
          <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'failed':
        return (
          <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      default:
        return null;
    }
  };

  const getStatusText = () => {
    switch (progress.status) {
      case 'pending':
        return 'Waiting to process...';
      case 'processing':
        return 'Processing...';
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      default:
        return 'Unknown';
    }
  };

  const getStatusColor = () => {
    switch (progress.status) {
      case 'pending':
        return 'text-gray-600 dark:text-gray-400';
      case 'processing':
        return 'text-blue-600 dark:text-blue-400';
      case 'completed':
        return 'text-green-600 dark:text-green-400';
      case 'failed':
        return 'text-red-600 dark:text-red-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  };

  const getProgressColor = () => {
    switch (progress.status) {
      case 'processing':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      default:
        return 'bg-gray-300 dark:bg-gray-600';
    }
  };

  return (
    <Card className={clsx('p-4', className)}>
      <div className="flex items-start gap-3">
        {/* Status Icon */}
        <div className="flex-shrink-0 mt-1">
          {getStatusIcon()}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Filename */}
          <h4 className="font-medium text-gray-900 dark:text-white truncate">
            {filename}
          </h4>

          {/* File size */}
          {fileSize && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {formatFileSize(fileSize)}
            </p>
          )}

          {/* Status and Progress */}
          <div className="mt-2 space-y-2">
            {/* Status Text */}
            <p className={clsx('text-sm font-medium', getStatusColor())}>
              {getStatusText()}
            </p>

            {/* Progress Bar */}
            {(progress.status === 'processing' || progress.status === 'completed') && (
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                <div
                  className={clsx('h-2 rounded-full transition-all duration-300', getProgressColor())}
                  style={{ width: `${progress.progress}%` }}
                />
              </div>
            )}

            {/* Progress Percentage */}
            {(progress.status === 'processing' || progress.status === 'completed') && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {Math.round(progress.progress)}% complete
              </p>
            )}

            {/* Error Message */}
            {progress.status === 'failed' && progress.error && (
              <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-600 dark:text-red-400">
                {progress.error}
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
};

// Helper function to format file size (imported from utils)
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Compact version for inline display
export const DocumentProgressCompact: React.FC<{
  progress: DocumentProgressType;
  filename: string;
  className?: string;
}> = ({ progress, filename, className }) => {
  const getStatusColor = () => {
    switch (progress.status) {
      case 'pending':
        return 'text-gray-500';
      case 'processing':
        return 'text-blue-500';
      case 'completed':
        return 'text-green-500';
      case 'failed':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };

  const getProgressColor = () => {
    switch (progress.status) {
      case 'processing':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      default:
        return 'bg-gray-300 dark:bg-gray-600';
    }
  };

  return (
    <div className={clsx('flex items-center gap-2 p-2', className)}>
      {/* Status Indicator */}
      <div className={clsx('w-2 h-2 rounded-full', getStatusColor())} />

      {/* Filename */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
          {filename}
        </p>
        
        {/* Progress Bar for processing/completed */}
        {(progress.status === 'processing' || progress.status === 'completed') && (
          <div className="mt-1 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1">
            <div
              className={clsx('h-1 rounded-full transition-all duration-300', getProgressColor())}
              style={{ width: `${progress.progress}%` }}
            />
          </div>
        )}
      </div>

      {/* Progress Percentage */}
      {(progress.status === 'processing' || progress.status === 'completed') && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {Math.round(progress.progress)}%
        </span>
      )}
    </div>
  );
};