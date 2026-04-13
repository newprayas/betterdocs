'use client';

import React, { useEffect, useState } from 'react';


import { useSessionStore, useDocumentStore, useChatStore } from '../store';
import { SessionList } from '../components/session';
import { Button } from '../components/ui';
import { CreateSessionDialog } from '../components/session';
import { EmptyState } from '../components/common';
import { LoadingScreen } from '../components/ui/LoadingScreen';
import { SimpleHeader } from '../components/layout';
import { useRouter } from 'next/navigation';
import type { Session } from '../types';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { getSessionRoute } from '@/utils/sessionRoute';
import { DRUG_CHAT_SESSION_DESCRIPTION, DRUG_CHAT_SESSION_NAME, isDrugOnlySession } from '@/utils/sessionType';

export default function HomePage() {
  const router = useRouter();
  const { isCheckingAuth, isAuthenticated } = useAuthGuard({ requireAuth: true });
  const { sessions, loadSessions, createSession, isLoading: isSessionLoading, currentSessionId, setCurrentSession, userId } = useSessionStore();
  const { loadDocuments } = useDocumentStore();
  const { preloadMessages, isPreloading, preloadingProgress, setSessionModeForSession } = useChatStore();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isOpeningDrugChat, setIsOpeningDrugChat] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [isAppReady, setIsAppReady] = useState(false);

  // Prevent hydration mismatch
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Load sessions and preload messages on mount (client-side only)
  useEffect(() => {
    const initApp = async () => {
      if (isMounted && userId) {
        // 0. Check for PWA Resume (Removed as per user request)
        // We now always land on the home page, but keep global preloading active.


        // 1. Load sessions first
        await loadSessions(userId);

        // 2. Mark app as ready
        setIsAppReady(true);
      } else if (isMounted && !userId) {
        // If no user, we're ready (empty state)
        setIsAppReady(true);
      }
    };

    initApp();
  }, [loadSessions, preloadMessages, isMounted, userId, router]);

  if (!isMounted || isCheckingAuth) return <LoadingScreen />;
  if (!isAuthenticated) return null;

  const handleCreateSession = async (data: { name: string; description?: string; systemPrompt?: string }) => {
    try {
      await createSession(data);
      setIsCreateDialogOpen(false);
      // Session created - no auto-navigation
    } catch (error) {
      console.error('Failed to create session:', error);
    }
  };

  const handleSessionSelect = (session: Session) => {
    setCurrentSession(session);
    router.push(getSessionRoute(session.id));
  };

  const handleOpenDrugChat = async () => {
    if (!userId || isOpeningDrugChat) return;

    setIsOpeningDrugChat(true);
    try {
      const existingDrugSession = sessions.find((session) => isDrugOnlySession(session));
      const drugSession = existingDrugSession || await createSession({
        name: DRUG_CHAT_SESSION_NAME,
        description: DRUG_CHAT_SESSION_DESCRIPTION,
        isDrugSession: true,
      });

      setSessionModeForSession(drugSession.id, 'drug');
      router.push(getSessionRoute(drugSession.id));
    } catch (error) {
      console.error('Failed to open drug chat:', error);
    } finally {
      setIsOpeningDrugChat(false);
    }
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

        {/* Inline Progress Bar - shown while preloading */}
        {isPreloading && preloadingProgress < 100 && (
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex flex-col space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
                  Preparing your chats...
                </span>
                <span className="text-xs text-blue-600 dark:text-blue-400">
                  {Math.round(preloadingProgress)}%
                </span>
              </div>
              <div className="w-full bg-blue-200 dark:bg-blue-800 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-blue-600 dark:bg-blue-500 h-full rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${Math.max(5, Math.min(100, preloadingProgress))}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Sessions List */}
        {isMounted && sessions.filter((session) => !isDrugOnlySession(session)).length === 0 && !isSessionLoading ? (
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
            disabled={isPreloading && preloadingProgress < 100}
          />
        )}
      </main>

      {/* Create Session Dialog */}
      <CreateSessionDialog
        isOpen={isCreateDialogOpen}
        onClose={() => setIsCreateDialogOpen(false)}
      />

      <div className="fixed bottom-4 right-4 z-40">
        <Button
          onClick={() => void handleOpenDrugChat()}
          disabled={!isAppReady || isSessionLoading || isOpeningDrugChat}
          className="!rounded-full shadow-xl px-5 py-3 !bg-emerald-800 hover:!bg-emerald-900 !text-white border border-emerald-950/20"
        >
          <span className="mr-2 text-base leading-none" aria-hidden="true">💊</span>
          Drug Mode
        </Button>
      </div>
    </div>
  );
}
