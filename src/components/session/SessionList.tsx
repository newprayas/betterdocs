import React, { useState, useEffect } from 'react';
import { Session } from '../../types';
import { SessionCard, SessionCardCompact } from './SessionCard';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Loading } from '../ui/Loading';
import { EmptyStates } from '../common/EmptyState';
import { useSessionStore, useChatStore } from '../../store';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';

interface SessionListProps {
  variant?: 'grid' | 'list' | 'compact';
  showCreateButton?: boolean;
  onSessionSelect?: (session: Session) => void;
  className?: string;
}

export const SessionList: React.FC<SessionListProps> = ({
  variant = 'grid',
  showCreateButton = true,
  onSessionSelect,
  className,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const { sessions, isLoading, createSession } = useSessionStore();
  const { preloadMessages } = useChatStore();
  const router = useRouter();

  // Preload messages for top 5 sessions
  useEffect(() => {
    if (sessions.length > 0) {
      // Sessions are already sorted by updatedAt in sessionStore/service
      const topSessionIds = sessions.slice(0, 5).map(s => s.id);
      preloadMessages(topSessionIds);

      // Prefetch routes for instant navigation
      topSessionIds.forEach(id => {
        router.prefetch(`/session/${id}`);
      });
    }
  }, [sessions, preloadMessages, router]);

  // Filter sessions based on search query
  const filteredSessions = sessions.filter(session =>
    session.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (session.description && session.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const handleSessionClick = (session: Session) => {
    // Track click time for performance monitoring
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('session_click_time', JSON.stringify({
        sessionId: session.id,
        timestamp: performance.now()
      }));
      console.log(`⏱️ [Performance] Session clicked: ${session.id}`);
    }

    if (onSessionSelect) {
      onSessionSelect(session);
    } else {
      router.push(`/session/${session.id}`);
    }
  };

  const handleCreateSession = async () => {
    const sessionName = prompt('Enter session name:', 'New Chat');
    if (sessionName && sessionName.trim()) {
      try {
        await createSession({
          name: sessionName.trim(),
          description: '',
        });
        // Session created - no auto-navigation
      } catch (error) {
        console.error('Failed to create session:', error);
      }
    }
  };

  if (isLoading && sessions.length === 0) {
    return (
      <div className={clsx('flex justify-center items-center h-64', className)}>
        <Loading size="lg" text="Loading sessions..." />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className={clsx('text-center py-12', className)}>
        <EmptyStates.NoSessions />
        {showCreateButton && (
          <div className="mt-6">
            <Button onClick={handleCreateSession}>
              <svg
                className="w-4 h-4 mr-2"
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
              Create First Session
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Search Bar */}
      {sessions.length > 5 && (
        <div className="mb-6">
          <Input
            type="search"
            placeholder="Search sessions..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            }
          />
        </div>
      )}

      {/* Create Button */}
      {showCreateButton && (
        <div className="mb-6">
          <Button onClick={handleCreateSession} className="w-full sm:w-auto">
            <svg
              className="w-4 h-4 mr-2"
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
            New Session
          </Button>
        </div>
      )}

      {/* Sessions Display */}
      {filteredSessions.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-gray-500 dark:text-gray-400">
            No sessions found matching "{searchQuery}"
          </p>
        </div>
      ) : (
        <>
          {variant === 'grid' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onClick={() => handleSessionClick(session)}
                />
              ))}
            </div>
          )}

          {variant === 'list' && (
            <div className="space-y-4">
              {filteredSessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onClick={() => handleSessionClick(session)}
                />
              ))}
            </div>
          )}

          {variant === 'compact' && (
            <div className="space-y-2">
              {filteredSessions.map((session) => (
                <SessionCardCompact
                  key={session.id}
                  session={session}
                  onClick={() => handleSessionClick(session)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Session Count */}
      {searchQuery && (
        <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
          Showing {filteredSessions.length} of {sessions.length} sessions
        </div>
      )}
    </div>
  );
};

// Sidebar version of session list
export const SessionListSidebar: React.FC<{
  onSessionSelect?: (session: Session) => void;
  className?: string;
}> = ({ onSessionSelect, className }) => {
  const { sessions, isLoading, createSession } = useSessionStore();
  const router = useRouter();

  const handleSessionClick = (session: Session) => {
    if (onSessionSelect) {
      onSessionSelect(session);
    } else {
      router.push(`/session/${session.id}`);
    }
  };

  const handleCreateSession = async () => {
    const sessionName = prompt('Enter session name:', 'New Chat');
    if (sessionName && sessionName.trim()) {
      try {
        await createSession({
          name: sessionName.trim(),
          description: '',
        });
        // Session created - no auto-navigation
      } catch (error) {
        console.error('Failed to create session:', error);
      }
    }
  };

  if (isLoading && sessions.length === 0) {
    return (
      <div className="p-4">
        <Loading size="sm" text="Loading..." />
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Create Button */}
      <div className="p-4 border-b border-gray-200 dark:border-gray-700">
        <Button
          size="sm"
          onClick={handleCreateSession}
          className="w-full"
        >
          <svg
            className="w-4 h-4 mr-2"
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
          New Chat
        </Button>
      </div>

      {/* Sessions */}
      <div className="max-h-96 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="p-4 text-center">
            <EmptyStates.NoSessions />
          </div>
        ) : (
          <div className="p-2">
            {sessions.map((session) => (
              <SessionCardCompact
                key={session.id}
                session={session}
                onClick={() => handleSessionClick(session)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};