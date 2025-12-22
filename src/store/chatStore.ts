import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import type { ChatStore } from './types';
import { Message, MessageSender } from '@/types/message';
import { getIndexedDBServices } from '../services/indexedDB';
import { chatPipeline } from '../services/rag/chatPipeline';
import { useSessionStore } from './sessionStore';
import { userIdLogger } from '../utils/userIdDebugLogger';

// Helper function to get services (client-side only)
const getMessageService = () => {
  if (typeof window !== 'undefined') {
    const services = getIndexedDBServices();
    return services.messageService;
  }
  return null;
};

export const useChatStore = create<ChatStore>()(
  devtools(
    persist(
      (set, get) => ({
        // State
        messages: [],
        messageCache: {}, // Cache for preloaded messages
        isStreaming: false,
        streamingContent: '',
        streamingCitations: [],
        error: null,
        isLoading: false,
        isReadingSources: false,
        progressPercentage: 0,
        currentProgressStep: '',
        isPreloading: false,
        preloadingProgress: 0,

        // Rate limiting state
        questionTimestamps: [],
        isRateLimited: false,
        rateLimitWaitSeconds: 0,

        // Actions
        loadMessages: async (sessionId: string) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const operationId = userIdLogger.logOperationStart('ChatStore', 'loadMessages', currentUserId);

          // Check cache first
          const { messageCache } = get();
          if (messageCache[sessionId]) {
            console.log(`⚡️ [ChatStore] Instant load from cache for session ${sessionId} (${messageCache[sessionId].length} msgs)`);
            set({ messages: messageCache[sessionId], isLoading: false, error: null });
            // We still fetch in background to ensure freshness, but UI is already populated
          } else {
            // Set loading state immediately and clear previous messages to avoid flickering
            set({ isLoading: true, error: null, messages: [] });
          }

          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }

            // Get services
            const services = getIndexedDBServices();

            // Run session validation and message fetching in parallel
            userIdLogger.logServiceCall('ChatStore', 'sessionService', 'getSession', currentUserId);
            userIdLogger.logServiceCall('ChatStore', 'messageService', 'getMessagesBySession', currentUserId);

            const [session, messages] = await Promise.all([
              services.sessionService.getSession(sessionId, currentUserId || undefined),
              messageService?.getMessagesBySession(sessionId, currentUserId || undefined, 20) // Fetch only last 20 messages initially
            ]);

            // Check if session exists
            if (!session) {
              throw new Error('Session not found');
            }

            userIdLogger.logOperationEnd('ChatStore', operationId, currentUserId);

            // Update state and cache
            set(state => ({
              messages: messages || [],
              isLoading: false,
              messageCache: {
                ...state.messageCache,
                [sessionId]: messages || []
              }
            }));
          } catch (error) {
            userIdLogger.logError('ChatStore.loadMessages', error instanceof Error ? error : String(error), currentUserId);
            set({
              error: error instanceof Error ? error.message : 'Failed to load messages',
              isLoading: false,
            });
          }
        },

        preloadMessages: async (sessionIds: string[]) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const messageService = getMessageService();
          if (!messageService || !currentUserId) return;

          // Filter out sessions that are already cached
          const { messageCache } = get();
          const sessionsToFetch = sessionIds.filter(id => !messageCache[id]);

          if (sessionsToFetch.length === 0) {
            console.log('✨ [ChatStore] All top sessions already cached. No preloading needed.');
            set({ isPreloading: false, preloadingProgress: 100 });
            return;
          }

          console.log(`🔥 [ChatStore] Preloading ${sessionsToFetch.length} sessions:`, sessionsToFetch);
          set({ isPreloading: true, preloadingProgress: 0 });

          try {
            let completedCount = 0;
            const totalToFetch = sessionsToFetch.length;

            // Fetch messages for each session in parallel
            const results = await Promise.all(
              sessionsToFetch.map(async (sessionId) => {
                try {
                  const messages = await messageService.getMessagesBySession(sessionId, currentUserId, 20);

                  // Update progress
                  completedCount++;
                  set({ preloadingProgress: (completedCount / totalToFetch) * 100 });

                  return { sessionId, messages };
                } catch (e) {
                  console.warn(`Failed to preload session ${sessionId}`, e);
                  return null;
                }
              })
            );

            // Update cache with results
            set(state => {
              const newCache = { ...state.messageCache };
              results.forEach(result => {
                if (result) {
                  newCache[result.sessionId] = result.messages;
                }
              });
              return {
                messageCache: newCache,
                isPreloading: false,
                preloadingProgress: 100
              };
            });

            console.log(`✅ [ChatStore] Preloaded ${results.filter(r => r !== null).length} sessions into cache`);
          } catch (error) {
            console.error('Failed to preload messages:', error);
            set({ isPreloading: false, preloadingProgress: 0 });
          }
        },

        sendMessage: async (sessionId: string, content: string) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const operationId = userIdLogger.logOperationStart('ChatStore', 'sendMessage', currentUserId);

          const userMessage: Message = {
            id: crypto.randomUUID(),
            content,
            role: MessageSender.USER,
            timestamp: new Date(),
            sessionId,
          };

          set(state => {
            const newMessages = [...state.messages, userMessage];
            return {
              messages: newMessages,
              error: null,
              isStreaming: false, // Don't show streaming content
              isReadingSources: true, // Show "Reading sources" instead
              progressPercentage: 0,
              currentProgressStep: 'Query Rewriting',
              // Update cache immediately
              messageCache: {
                ...state.messageCache,
                [sessionId]: newMessages
              }
            };
          });

          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }

            // Save user message to IndexedDB
            userIdLogger.logServiceCall('ChatStore', 'messageService', 'createMessage', currentUserId);
            await messageService.createMessage(userMessage);

            // Update session timestamp to move it to the top
            const services = getIndexedDBServices();
            await services.sessionService.updateSession(sessionId, { updatedAt: new Date() }, currentUserId || undefined);

            // Use the actual chat pipeline to generate response
            // Pass the already created userMessage to avoid duplication
            await chatPipeline.sendMessage(
              sessionId,
              content,
              (event) => {
                if (event.type === 'status') {
                  // Update progress based on status message
                  console.log('Chat status:', event.message);
                  const { setProgressState } = get();

                  switch (event.message) {
                    case 'Query Rewriting':
                      setProgressState(25, 'Query Rewriting');
                      break;
                    case 'Embedding Generation':
                      setProgressState(50, 'Embedding Generation');
                      break;
                    case 'Vector Search':
                      setProgressState(75, 'Vector Search');
                      break;
                    case 'Response Generation':
                      setProgressState(90, 'Response Generation');
                      break;
                    case 'Response Formatting':
                      setProgressState(95, 'Response Formatting');
                      break;
                    default:
                      // For other status messages, don't update progress
                      break;
                  }
                } else if (event.type === 'done') {
                  const { content: finalContent, citations: finalCitations } = event;

                  // Reload messages to get the final response
                  // Get session to verify ownership and get userId
                  const services = getIndexedDBServices();
                  // Get userId from sessionStore
                  const { userId: finalUserId } = useSessionStore.getState();
                  const { setProgressState } = get();

                  // OPTIMISTIC UPDATE: If we have content, update UI immediately
                  if (finalContent) {
                    console.log('⚡️ [ChatStore] Optimistic update with final content');

                    set(state => {
                      // Create message object
                      const assistantMessage: Message = {
                        id: crypto.randomUUID(), // Local ID
                        sessionId,
                        content: finalContent,
                        role: MessageSender.ASSISTANT,
                        timestamp: new Date(),
                        citations: finalCitations
                      };

                      const newMessages = [...state.messages, assistantMessage];

                      return {
                        messages: newMessages,
                        isStreaming: false, // Stop streaming interface
                        streamingContent: '',
                        streamingCitations: [],
                        isReadingSources: false,
                        progressPercentage: 100,
                        currentProgressStep: 'Complete',
                        // Update cache immediately
                        messageCache: {
                          ...state.messageCache,
                          [sessionId]: newMessages
                        }
                      };
                    });
                  }

                  userIdLogger.logServiceCall('ChatStore', 'sessionService', 'getSession (done callback)', finalUserId);

                  // Use robust async error handling to prevent UI hanging
                  (async () => {
                    try {
                      const session = await services.sessionService.getSession(sessionId, finalUserId || undefined);

                      if (!session) {
                        throw new Error(`Session ${sessionId} not found during completion callback`);
                      }

                      userIdLogger.logServiceCall('ChatStore', 'messageService', 'getMessagesBySession (done callback)', session.userId);
                      const messages = await messageService.getMessagesBySession(sessionId, session.userId);

                      userIdLogger.logOperationEnd('ChatStore', operationId, finalUserId);

                      // If we didn't do optimistic update (legacy path), update now
                      if (!finalContent) {
                        const { setProgressState } = get();
                        setProgressState(100, 'Complete');
                      }

                      set(state => ({
                        messages,
                        isStreaming: false,
                        streamingContent: '',
                        streamingCitations: [],
                        isReadingSources: false,
                        // Update cache with final messages
                        messageCache: {
                          ...state.messageCache,
                          [sessionId]: messages
                        }
                      }));
                    } catch (error) {
                      console.error('[ChatStore] Error checking for new messages in done callback:', error);
                      userIdLogger.logError('ChatStore.sendMessage.doneCallback', error instanceof Error ? error : String(error), finalUserId);

                      // Fallback: If we didn't have content and DB failed, show error
                      // If we DID have content, we just log the warning (UI is already fine)
                      if (!finalContent) {
                        const { setProgressState } = get();
                        setProgressState(100, 'Complete');
                        set({
                          isStreaming: false,
                          streamingContent: '',
                          streamingCitations: [],
                          isReadingSources: false,
                          // Don't clear messages, just stop loading state
                          error: 'Response generated, but failed to refresh chat history. Pull to refresh.',
                        });
                      }
                    }
                  })();
                } else if (event.type === 'error') {
                  userIdLogger.logError('ChatStore.sendMessage (pipeline error)', event.message || 'Unknown error', currentUserId);
                  set({
                    error: event.message || 'Failed to generate response',
                    isStreaming: false,
                    streamingContent: '',
                    streamingCitations: [],
                    isReadingSources: false,
                    progressPercentage: 0,
                    currentProgressStep: '',
                  });
                }
              },
              userMessage // Pass the already created userMessage
            );
          } catch (error) {
            userIdLogger.logError('ChatStore.sendMessage', error instanceof Error ? error : String(error), currentUserId);
            set({
              error: error instanceof Error ? error.message : 'Failed to send message',
              isStreaming: false,
            });
          }
        },

        clearHistory: async (sessionId: string) => {
          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }
            await messageService.deleteMessagesBySession(sessionId);
            set(state => ({
              messages: [],
              error: null,
              // Clear from cache
              messageCache: {
                ...state.messageCache,
                [sessionId]: []
              }
            }));
          } catch (error) {
            set({
              error: error instanceof Error ? error.message : 'Failed to clear messages',
            });
          }
        },

        setStreamingState: (isStreaming: boolean, content?: string, citations?: any[]) => {
          set({
            isStreaming,
            streamingContent: content || '',
            streamingCitations: citations || [],
          });
        },

        addMessage: (message: Message) => {
          set(state => {
            const newMessages = [...state.messages, message];
            return {
              messages: newMessages,
              // Update cache
              messageCache: {
                ...state.messageCache,
                [message.sessionId]: newMessages
              }
            };
          });
        },

        setError: (error: string | null) => {
          set({ error });
        },

        setReadingSourcesState: (isReadingSources: boolean) => {
          set({ isReadingSources });
        },

        setProgressState: (percentage: number, step: string) => {
          set({
            progressPercentage: percentage,
            currentProgressStep: step
          });
        },

        // Rate limiting methods
        checkRateLimit: () => {
          const { questionTimestamps } = get();
          const now = Date.now();
          const oneMinuteAgo = now - 60000;

          // Filter to get questions in the last minute
          const recentQuestions = questionTimestamps.filter(ts => ts > oneMinuteAgo);

          // If less than 2 questions in the last minute, no wait needed
          if (recentQuestions.length < 2) {
            return 0;
          }

          // Calculate when the oldest recent question will expire (+ 1 second buffer)
          const oldestRecentQuestion = Math.min(...recentQuestions);
          const waitTime = Math.ceil((oldestRecentQuestion + 60000 - now) / 1000) + 1;

          console.log('[RATE LIMIT]', {
            recentQuestions: recentQuestions.length,
            waitTime,
            oldestRecentQuestion: new Date(oldestRecentQuestion).toISOString()
          });

          return Math.max(0, waitTime);
        },

        setRateLimitState: (isLimited: boolean, waitSeconds: number) => {
          set({
            isRateLimited: isLimited,
            rateLimitWaitSeconds: waitSeconds
          });
        },

        recordQuestion: () => {
          const { questionTimestamps } = get();
          const now = Date.now();
          const oneMinuteAgo = now - 60000;

          // Keep only recent timestamps + the new one
          const updatedTimestamps = [
            ...questionTimestamps.filter(ts => ts > oneMinuteAgo),
            now
          ];

          console.log('[RATE LIMIT]', 'Recording question. Total in last minute:', updatedTimestamps.length);

          set({ questionTimestamps: updatedTimestamps });
        },
      }),
      {
        name: 'chat-store',
        partialize: (state) => ({}), // Don't persist chat messages to localStorage (too heavy)
      }
    )
  )
);