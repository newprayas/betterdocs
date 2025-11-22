'use client';

import React, { useEffect, useState } from 'react';

export const dynamic = 'force-dynamic';
import { useSessionStore, useDocumentStore } from '../store';
import { SessionList } from '../components/session';
import { Button } from '../components/ui';
import { CreateSessionDialog } from '../components/session';
import { EmptyState } from '../components/common';
import { SimpleHeader } from '../components/layout';
import { useRouter } from 'next/navigation';
import type { Session } from '../types';

export default function HomePage() {
  const router = useRouter();
  const { sessions, loadSessions, createSession, isLoading, currentSessionId, setCurrentSession, userId } = useSessionStore();
  const { loadDocuments } = useDocumentStore();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Load sessions on mount (client-side only)
  useEffect(() => {
    if (isMounted && userId) {
      loadSessions(userId);
    }
  }, [loadSessions, isMounted, userId]);

  const handleCreateSession = async (data: { name: string; description?: string; systemPrompt?: string }) => {
    try {
      const session = await createSession(data);
      setIsCreateDialogOpen(false);

      // Navigate to the new session
      router.push(`/session/${session.id}`);
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const handleSessionSelect = (session: Session) => {
    setCurrentSession(session);
    router.push(`/session/${session.id}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      <SimpleHeader />

      <main className="flex-1 container mx-auto px-4 sm:px-6 py-6 sm:py-8 overflow-y-auto">
        <div className="mb-6 sm:mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
                Your Conversations
              </h1>
              <p className="text-sm sm:text-base text-gray-600 dark:text-gray-300 mt-2">
                Start a new conversation or continue an existing one
              </p>
            </div>

            <Button
              onClick={() => setIsCreateDialogOpen(true)}
              className="flex items-center gap-2 w-full sm:w-auto justify-center"
            >
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
                  d="M12 4v16m8-8H4"
                />
              </svg>
              New Conversation
            </Button>
          </div>
        </div>

        {/* Sessions List */}
        {isMounted && sessions.length === 0 && !isLoading ? (
          <EmptyState
            title="No conversations yet"
            description="Start your first conversation to begin chatting with your documents"
            icon={
              <svg
                className="w-12 h-12 text-gray-400"
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
            }
            action={
              <Button
                onClick={() => setIsCreateDialogOpen(true)}
                size="lg"
              >
                Start Your First Conversation
              </Button>
            }
          />
        ) : (
          <SessionList
            onSessionSelect={handleSessionSelect}
            showCreateButton={false} // We have our own create button
          />
        )}
      </main>

      {/* Create Session Dialog */}
      <CreateSessionDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
        onCreate={(session) => {
          router.push(`/session/${session.id}`);
        }}
      />
    </div>
  );
}