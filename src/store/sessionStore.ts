import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { SessionStore, AppStore } from './types';
import type { Session, SessionCreate, SessionUpdate } from '@/types';
import { getIndexedDBServices } from '../services/indexedDB';
import { userIdLogger } from '../utils/userIdDebugLogger';

// Helper function to get services (client-side only)
const getSessionService = () => {
  if (typeof window !== 'undefined') {
    const services = getIndexedDBServices();
    return services.sessionService;
  }
  return null;
};

export const useSessionStore = create<SessionStore>()(
  devtools(
    persist(
      (set, get) => ({
        // Initial state
        sessions: [],
        currentSession: null,
        currentSessionId: null,
        isLoading: false,
        error: null,
        userId: null,

        // Actions
        loadSessions: async (userId: string) => {
          // Only run on client side
          if (typeof window === 'undefined') {
            console.warn('[SESSION STORE] Skipping loadSessions during SSR');
            return;
          }

          const operationId = userIdLogger.logOperationStart('SessionStore', 'loadSessions', userId);

          set({ isLoading: true, error: null, userId });
          try {
            userIdLogger.logServiceCall('SessionStore', 'sessionService', 'getSessions', userId);
            const sessionService = getSessionService();
            if (!sessionService) {
              throw new Error('Session service not available');
            }
            const sessions = await sessionService.getSessions(userId);

            userIdLogger.logOperationEnd('SessionStore', operationId, userId);
            set({ sessions, isLoading: false });
          } catch (error) {
            userIdLogger.logError('SessionStore.loadSessions', error instanceof Error ? error : String(error), userId);
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : 'Failed to load sessions'
            });
          }
        },

        createSession: async (data: SessionCreate) => {
          // Only run on client side
          if (typeof window === 'undefined') {
            console.warn('[SESSION STORE] Skipping createSession during SSR');
            throw new Error('Cannot create session during SSR');
          }

          const { userId } = get();
          if (!userId) {
            const errorMsg = 'User ID not found. Please log in.';
            userIdLogger.logError('SessionStore.createSession', errorMsg, null);
            set({ error: errorMsg });
            throw new Error('User ID not found');
          }

          const operationId = userIdLogger.logOperationStart('SessionStore', 'createSession', userId);

          set({ isLoading: true, error: null });
          try {
            userIdLogger.logServiceCall('SessionStore', 'sessionService', 'createSession', userId);
            const sessionService = getSessionService();
            if (!sessionService) {
              throw new Error('Session service not available');
            }
            const newSession = await sessionService.createSession(data, userId);

            userIdLogger.logOperationEnd('SessionStore', operationId, userId);
            set(state => ({
              sessions: [newSession, ...state.sessions],
              isLoading: false
            }));

            return newSession;
          } catch (error) {
            userIdLogger.logError('SessionStore.createSession', error instanceof Error ? error : String(error), userId);
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : 'Failed to create session'
            });
            throw error;
          }
        },

        updateSession: async (id: string, data: SessionUpdate) => {
          set({ isLoading: true, error: null });
          try {
            const sessionService = getSessionService();
            if (!sessionService) {
              throw new Error('Session service not available');
            }
            await sessionService.updateSession(id, data);

            await sessionService.updateSession(id, data);

            // Reload sessions to ensure correct sorting (updatedAt changed)
            const { userId } = get();
            if (userId) {
              const sessions = await sessionService.getSessions(userId);
              set(state => ({
                sessions,
                currentSession: state.currentSession?.id === id
                  ? { ...state.currentSession, ...data, updatedAt: new Date() }
                  : state.currentSession,
                isLoading: false,
              }));
            } else {
              // Fallback for no user (shouldn't happen given checks)
              set(state => ({
                sessions: state.sessions.map(session =>
                  session.id === id
                    ? { ...session, ...data, updatedAt: new Date() }
                    : session
                ),
                currentSession: state.currentSession?.id === id
                  ? { ...state.currentSession, ...data, updatedAt: new Date() }
                  : state.currentSession,
                isLoading: false,
              }));
            }
          } catch (error) {
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : 'Failed to update session'
            });
          }
        },

        deleteSession: async (id: string) => {
          set({ isLoading: true, error: null });
          try {
            const sessionService = getSessionService();
            if (!sessionService) {
              throw new Error('Session service not available');
            }
            await sessionService.deleteSession(id);

            set(state => ({
              sessions: state.sessions.filter(session => session.id !== id),
              currentSession: state.currentSession?.id === id ? null : state.currentSession,
              currentSessionId: state.currentSessionId === id ? null : state.currentSessionId,
              isLoading: false,
            }));
          } catch (error) {
            set({
              isLoading: false,
              error: error instanceof Error ? error.message : 'Failed to delete session'
            });
          }
        },

        setCurrentSession: (session: Session | null) => {
          set({
            currentSession: session,
            currentSessionId: session?.id || null
          });
        },

        setCurrentSessionId: async (id: string | null) => {
          if (id) {
            // Optimistic update: Try to find session in current list first
            const { sessions, userId } = get();
            const cachedSession = sessions.find(s => s.id === id);

            if (cachedSession) {
              console.log(`⚡️ [SessionStore] Optimistic cache hit for session ${id}`);
              set({
                currentSession: cachedSession,
                currentSessionId: id
              });
            } else {
              console.log(`⚠️ [SessionStore] Cache miss for session ${id} in list of ${sessions.length}`);
            }

            try {
              const sessionService = getSessionService();
              if (!sessionService) {
                throw new Error('Session service not available');
              }

              const startTime = performance.now();
              const session = await sessionService.getSession(id, userId || undefined);
              console.log(`⏱️ [SessionStore] DB fetch for session ${id} took ${(performance.now() - startTime).toFixed(2)}ms`);

              set({
                currentSession: session,
                currentSessionId: id
              });
            } catch (error) {
              // If we failed to load and didn't have a cached version, clear it
              if (!cachedSession) {
                set({
                  currentSession: null,
                  currentSessionId: null,
                  error: error instanceof Error ? error.message : 'Failed to load session'
                });
              } else {
                // If we had a cached version but update failed, just log it
                console.error('Failed to refresh session data:', error);
              }
            }
          } else {
            set({
              currentSession: null,
              currentSessionId: id
            });
          }
        },

        setError: (error: string | null) => {
          set({ error });
        },

        setUserId: (userId: string | null) => {
          userIdLogger.logStoreUpdate('SessionStore', userId, 'setUserId');
          set({ userId });
        },

        clearSessions: () => {
          userIdLogger.logStoreUpdate('SessionStore', null, 'clearSessions');
          set({
            sessions: [],
            currentSession: null,
            currentSessionId: null,
            userId: null,
            error: null
          });
        },
      }),
      {
        name: 'session-store',
        partialize: (state) => ({
          currentSessionId: state.currentSessionId,
          userId: state.userId,
        }),
      }
    ),
    {
      name: 'session-store',
    }
  )
);