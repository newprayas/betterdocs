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
        
        // Actions
        loadMessages: async (sessionId: string) => {
          const { userId: currentUserId } = useSessionStore.getState();
          const operationId = userIdLogger.logOperationStart('ChatStore', 'loadMessages', currentUserId);
          
          try {
            const messageService = getMessageService();
            if (!messageService) {
              throw new Error('Message service not available');
            }
            
            // Get session to verify ownership and get userId
            const services = getIndexedDBServices();
            
            userIdLogger.logServiceCall('ChatStore', 'sessionService', 'getSession', currentUserId);
            const session = await services.sessionService.getSession(sessionId, currentUserId || undefined);
            if (!session) {
              throw new Error('Session not found');
            }
            
            userIdLogger.logServiceCall('ChatStore', 'messageService', 'getMessagesBySession', session.userId);
            const messages = await messageService.getMessagesBySession(sessionId, session.userId);
            
            userIdLogger.logOperationEnd('ChatStore', operationId, currentUserId);
            set({ messages });
          } catch (error) {
            userIdLogger.logError('ChatStore.loadMessages', error instanceof Error ? error : String(error), currentUserId);
            set({
              error: error instanceof Error ? error.message : 'Failed to load messages',
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
                  // Could show status in UI if needed
                  console.log('Chat status:', event.message);
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
                        set({
                          messages,
                          isStreaming: false,
                          streamingContent: '',
                          streamingCitations: [],
                          isReadingSources: false
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
                    isReadingSources: false
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
      }),
      {
        name: 'chat-store',
        partialize: (state) => ({
          messages: state.messages,
        }),
      }
    )
  )
);