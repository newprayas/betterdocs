import React, { useState } from 'react';
import { Session } from '../../types';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { useConfirmDialog } from '../common/ConfirmDialog';
import { useSessionStore } from '../../store';
import { getRelativeTime, formatTime } from '../../utils/date';
import clsx from 'clsx';

interface SessionCardProps {
  session: Session;
  isActive?: boolean;
  onClick?: () => void;
  className?: string;
}

export const SessionCard: React.FC<SessionCardProps> = ({
  session,
  isActive = false,
  onClick,
  className,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const { deleteSession, updateSession } = useSessionStore();
  const { confirm, ConfirmDialog } = useConfirmDialog();

  const handleDelete = async () => {
    await confirm({
      title: 'Delete Session',
      message: `Are you sure you want to delete "${session.name}"? This action cannot be undone.`,
      onConfirm: async () => {
        try {
          await deleteSession(session.id);
        } catch (error) {
          console.error('Failed to delete session:', error);
        }
      },
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
    });
  };

  const handleRename = async () => {
    const newName = prompt('Enter new name:', session.name);
    if (newName && newName.trim() && newName !== session.name) {
      try {
        await updateSession(session.id, { name: newName.trim() });
      } catch (error) {
        console.error('Failed to rename session:', error);
      }
    }
  };


  return (
    <>
      <div
        className={clsx(
          'bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700',
          'cursor-pointer transition-all duration-200 hover:shadow-md',
          isActive && 'ring-2 ring-blue-500 bg-blue-50 dark:bg-blue-900/20',
          className
        )}
        onClick={onClick}
      >
        <div className="p-3 sm:p-4">
          <div className="flex items-start justify-between">
            {/* Session Info */}
            <div className="flex-1 min-w-0 pr-2">
              <h3 className="font-medium text-sm sm:text-base text-gray-900 dark:text-white truncate">
                {session.name}
              </h3>
              
              {session.description && (
                <p className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 mt-1 line-clamp-2 hidden sm:block">
                  {session.description}
                </p>
              )}
              
              <div className="flex items-center mt-2 text-xs text-gray-500 dark:text-gray-400 space-x-2 sm:space-x-3">
                <span>{getRelativeTime(session.updatedAt)}</span>
                {session.documentCount > 0 && (
                  <span>{session.documentCount} docs</span>
                )}
              </div>
            </div>

            {/* Menu Button */}
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsMenuOpen(!isMenuOpen);
                }}
                className="p-1"
              >
                <svg
                  className="w-4 h-4 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
                  />
                </svg>
              </Button>

              {/* Dropdown Menu */}
              {isMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 sm:w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-10">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRename();
                      setIsMenuOpen(false);
                    }}
                    className="w-full text-left px-3 sm:px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-t-lg touch-manipulation"
                  >
                    Rename
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete();
                      setIsMenuOpen(false);
                    }}
                    className="w-full text-left px-3 sm:px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-b-lg touch-manipulation"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Close menu when clicking outside */}
      {isMenuOpen && (
        <div
          className="fixed inset-0 z-0"
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      <ConfirmDialog />
    </>
  );
};

// Compact version for sidebar
export const SessionCardCompact: React.FC<{
  session: Session;
  isActive?: boolean;
  onClick?: () => void;
  className?: string;
}> = ({ session, isActive = false, onClick, className }) => {

  return (
    <div
      className={clsx(
        'p-2 sm:p-3 rounded-lg cursor-pointer transition-colors duration-200 touch-manipulation',
        'hover:bg-gray-100 dark:hover:bg-gray-800',
        isActive && 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
        className
      )}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0 pr-2">
          <h4 className="font-medium text-xs sm:text-sm text-gray-900 dark:text-white truncate">
            {session.name}
          </h4>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 hidden sm:block">
            {formatTime(session.updatedAt)}
          </p>
        </div>
        
        {session.documentCount > 0 && (
          <div className="ml-1 sm:ml-2 flex-shrink-0">
            <span className="inline-flex items-center px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-full text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              {session.documentCount}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};