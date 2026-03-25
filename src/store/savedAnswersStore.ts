import { create } from 'zustand';
import type { SavedAnswer } from '@/types';
import { getIndexedDBServices } from '@/services/indexedDB';
import { useSessionStore } from './sessionStore';
import type { SavedAnswersStore } from './types';

const sortSavedAnswers = (answers: SavedAnswer[]): SavedAnswer[] =>
  [...answers].sort((left, right) => right.savedAt.getTime() - left.savedAt.getTime());

const getSessionNameSnapshot = async (sessionId: string, userId?: string | null): Promise<string> => {
  const { sessionService } = getIndexedDBServices();
  const sessionFromStore = useSessionStore.getState().sessions.find((session) => session.id === sessionId);
  if (sessionFromStore?.name) {
    return sessionFromStore.name;
  }

  const session = await sessionService.getSession(sessionId, userId || undefined);
  return session?.name || 'Conversation';
};

export const useSavedAnswersStore = create<SavedAnswersStore>((set, get) => ({
  savedAnswers: [],
  isLoading: false,
  error: null,
  isLoaded: false,

  loadSavedAnswers: async (userId?: string | null) => {
    if (!userId) {
      set({
        savedAnswers: [],
        isLoading: false,
        error: null,
        isLoaded: true,
      });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const { savedAnswerService } = getIndexedDBServices();
      const savedAnswers = await savedAnswerService.getSavedAnswers(userId);
      set({
        savedAnswers: sortSavedAnswers(savedAnswers),
        isLoading: false,
        error: null,
        isLoaded: true,
      });
    } catch (error) {
      console.error('[SavedAnswersStore] Failed to load saved answers:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load saved answers',
        isLoaded: true,
      });
    }
  },

  toggleSavedAnswerForMessage: async (message, processedContent, sessionName?: string) => {
    const { savedAnswerService } = getIndexedDBServices();
    const userId = useSessionStore.getState().userId;

    if (!userId) {
      set({ error: 'No active user session available for saved answers.' });
      return false;
    }

    const resolvedSessionName = sessionName || (await getSessionNameSnapshot(message.sessionId, userId));

    try {
      const result = await savedAnswerService.toggleSavedAnswer({
        sourceMessageId: message.id,
        userId,
        sessionId: message.sessionId,
        sessionName: resolvedSessionName,
        content: processedContent,
        savedAt: new Date(),
      });

      set((state) => {
        const nextAnswers = result.saved
          ? sortSavedAnswers([
              result.item || {
                id: message.id,
                sourceMessageId: message.id,
                userId,
                sessionId: message.sessionId,
                sessionName: resolvedSessionName,
                content: processedContent,
                savedAt: new Date(),
              },
              ...state.savedAnswers.filter((item) => item.sourceMessageId !== message.id),
            ])
          : state.savedAnswers.filter((item) => item.sourceMessageId !== message.id);

        return {
          savedAnswers: nextAnswers,
          error: null,
          isLoaded: true,
        };
      });

      return result.saved;
    } catch (error) {
      console.error('[SavedAnswersStore] Failed to toggle saved answer:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to save answer',
      });
      return false;
    }
  },

  removeSavedAnswer: async (messageId: string) => {
    const { savedAnswerService } = getIndexedDBServices();

    try {
      await savedAnswerService.removeSavedAnswer(messageId);
      set((state) => ({
        savedAnswers: state.savedAnswers.filter((item) => item.sourceMessageId !== messageId),
      }));
    } catch (error) {
      console.error('[SavedAnswersStore] Failed to remove saved answer:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to remove saved answer',
      });
    }
  },

  isSaved: (messageId: string) =>
    get().savedAnswers.some((item) => item.sourceMessageId === messageId),
}));
