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
        isStreaming: false,
        streamingContent: '',
        streamingCitations: [],
        error: null,
        isLoading: false,
        isReadingSources: false,
        progressPercentage: 0,
        currentProgressStep: '',
        
        // Actions
        loadMessages: async (sessionId: string) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const operationId = userIdLogger.logOperationStart('ChatStore', 'loadMessages', currentUserId);
          
          // Set loading state immediately and clear previous messages to avoid flickering
          set({ isLoading: true, error: null, messages: [] });
          
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
              messageService?.getMessagesBySession(sessionId, currentUserId || undefined, 50) // Fetch only last 50 messages initially
            ]);
            
            // Check if session exists
            if (!session) {
              throw new Error('Session not found');
            }
            
            userIdLogger.logOperationEnd('ChatStore', operationId, currentUserId);
            set({ messages: messages || [], isLoading: false });
          } catch (error) {
            userIdLogger.logError('ChatStore.loadMessages', error instanceof Error ? error : String(error), currentUserId);
            set({
              error: error instanceof Error ? error.message : 'Failed to load messages',
              isLoading: false,
            });
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
          
          set(state => ({
            messages: [...state.messages, userMessage],
            error: null,
            isStreaming: false, // Don't show streaming content
            isReadingSources: true, // Show "Reading sources" instead
            progressPercentage: 0,
            currentProgressStep: 'Query Rewriting',
          }));
          
          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }
            
            // Save user message to IndexedDB
            userIdLogger.logServiceCall('ChatStore', 'messageService', 'createMessage', currentUserId);
            await messageService.createMessage(userMessage);
            
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
                  // Reload messages to get the final response
                  // Get session to verify ownership and get userId
                  const services = getIndexedDBServices();
                  // Get userId from sessionStore
                  const { userId: finalUserId } = useSessionStore.getState();
                  
                  userIdLogger.logServiceCall('ChatStore', 'sessionService', 'getSession (done callback)', finalUserId);
                  services.sessionService.getSession(sessionId, finalUserId || undefined).then(session => {
                    if (session) {
                      userIdLogger.logServiceCall('ChatStore', 'messageService', 'getMessagesBySession (done callback)', session.userId);
                      messageService.getMessagesBySession(sessionId, session.userId).then(messages => {
                        userIdLogger.logOperationEnd('ChatStore', operationId, finalUserId);
                          const { setProgressState } = get();
                          setProgressState(100, 'Complete');
                          
                          set({
                            messages,
                            isStreaming: false,
                            streamingContent: '',
                            streamingCitations: [],
                            isReadingSources: false,
                          });
                      });
                    }
                  });
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
            set({ messages: [], error: null });
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
          set(state => ({
            messages: [...state.messages, message],
          }));
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
      }),
      {
        name: 'chat-store',
        partialize: (state) => ({}), // Don't persist chat messages to localStorage (too heavy)
      }
    )
  )
);