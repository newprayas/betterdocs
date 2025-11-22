import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Button } from '../ui/Button';
import { useSessions } from '../../store';
import { getRelativeTime } from '../../utils/date';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  currentSessionId?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onClose,
  currentSessionId,
}) => {
  const router = useRouter();
  const { sessions, loadSessions, createSession, deleteSession, userId } = useSessions();

  React.useEffect(() => {
    if (isOpen && userId) {
      loadSessions(userId);
    }
  }, [isOpen, loadSessions, userId]);

  const handleCreateSession = async () => {
    const sessionName = `Chat ${sessions.length + 1}`;
    const newSession = await createSession({
      name: sessionName,
      description: 'New chat session',
    });

    if (newSession) {
      router.push(`/session/${newSession.id}`);
      onClose();
    }
  };

  const handleDeleteSession = async (sessionId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (confirm('Are you sure you want to delete this session?')) {
      await deleteSession(sessionId);

      if (currentSessionId === sessionId) {
        router.push('/');
      }
    }
  };


  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <div className={`
        fixed inset-y-0 left-0 z-50 w-64 sm:w-72 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700
        transform transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0 lg:static lg:inset-0
      `}>
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between p-3 sm:p-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-base sm:text-lg font-semibold text-gray-900 dark:text-white truncate">
              Conversations
            </h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="lg:hidden p-2"
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </Button>
          </div>

          {/* New Chat Button */}
          <div className="p-3 sm:p-4">
            <Button
              onClick={handleCreateSession}
              className="w-full"
              size="sm"
            >
              <svg
                className="h-4 w-4 mr-2"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              <span className="text-sm">New Chat</span>
            </Button>
          </div>

          {/* Sessions List */}
          <div className="flex-1 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="p-3 sm:p-4 text-center text-gray-500 dark:text-gray-400">
                <svg
                  className="h-10 w-10 sm:h-12 sm:w-12 mx-auto mb-2 text-gray-300 dark:text-gray-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                <p className="text-sm">No conversations yet</p>
                <p className="text-xs mt-1">Start a new chat to begin</p>
              </div>
            ) : (
              <nav className="space-y-1 p-2">
                {sessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/session/${session.id}`}
                    className={`
                      group flex items-center justify-between px-2 sm:px-3 py-2 sm:py-3 rounded-lg text-sm
                      transition-colors duration-200 touch-manipulation
                      ${currentSessionId === session.id
                        ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-l-2 border-blue-500'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }
                    `}
                    onClick={onClose}
                  >
                    <div className="flex-1 min-w-0 pr-2">
                      <p className="font-medium text-sm truncate">
                        {session.name}
                      </p>
                      {session.description && (
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate hidden sm:block">
                          {session.description}
                        </p>
                      )}
                      <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                        {getRelativeTime(session.updatedAt)}
                      </p>
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => handleDeleteSession(session.id, e)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 p-1 sm:p-2 flex-shrink-0"
                    >
                      <svg
                        className="h-3 w-3 sm:h-4 sm:w-4 text-red-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </Button>
                  </Link>
                ))}
              </nav>
            )}
          </div>

          {/* Footer */}
          <div className="p-3 sm:p-4 border-t border-gray-200 dark:border-gray-700">
            <Link href="/settings">
              <Button
                variant="ghost"
                className="w-full justify-start"
                size="sm"
              >
                <svg
                  className="h-4 w-4 mr-2"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <span className="text-sm">Settings</span>
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </>
  );
};