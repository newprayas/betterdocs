// Main store exports
export { useSessionStore } from './sessionStore';
export { useChatStore } from './chatStore';
export { useDocumentStore } from './documentStore';
export { useSettingsStore } from './settingsStore';

// Type exports
export type {
  SessionStore,
  ChatStore,
  DocumentStore,
  SettingsStore,
  AppStore
} from './types';

// Import the actual store hooks
import { useSessionStore } from './sessionStore';
import { useChatStore } from './chatStore';
import { useDocumentStore } from './documentStore';
import { useSettingsStore } from './settingsStore';

// For now, just export individual stores
// We can create a combined store later if needed for complex cross-store operations

// Export individual hooks for convenience
export const useSessions = () => {
  const sessionStore = useSessionStore();
  return {
    sessions: sessionStore.sessions,
    currentSession: sessionStore.currentSession,
    currentSessionId: sessionStore.currentSessionId,
    isLoading: sessionStore.isLoading,
    error: sessionStore.error,
    userId: sessionStore.userId,
    loadSessions: sessionStore.loadSessions,
    createSession: sessionStore.createSession,
    updateSession: sessionStore.updateSession,
    deleteSession: sessionStore.deleteSession,
    setCurrentSession: sessionStore.setCurrentSession,
    setCurrentSessionId: sessionStore.setCurrentSessionId,
  };
};

export const useChat = () => {
  const chatStore = useChatStore();
  return {
    messages: chatStore.messages,
    isStreaming: chatStore.isStreaming,
    streamingContent: chatStore.streamingContent,
    streamingCitations: chatStore.streamingCitations,
    error: chatStore.error,
    loadMessages: chatStore.loadMessages,
    sendMessage: chatStore.sendMessage,
    clearHistory: chatStore.clearHistory,
    setStreamingState: chatStore.setStreamingState,
    addMessage: chatStore.addMessage,
    setError: chatStore.setError,
    // Rate limiting
    isRateLimited: chatStore.isRateLimited,
    rateLimitWaitSeconds: chatStore.rateLimitWaitSeconds,
    checkRateLimit: chatStore.checkRateLimit,
    setRateLimitState: chatStore.setRateLimitState,
    recordQuestion: chatStore.recordQuestion,
  };
};

export const useDocuments = () => {
  const documentStore = useDocumentStore();
  return {
    documents: documentStore.documents,
    progressMap: documentStore.progressMap,
    isUploading: documentStore.isUploading,
    error: documentStore.error,
    loadDocuments: documentStore.loadDocuments,
    uploadDocuments: documentStore.uploadDocuments,
    updateDocument: documentStore.updateDocument,
    deleteDocument: documentStore.deleteDocument,
    setProgress: documentStore.setProgress,
    clearProgress: documentStore.clearProgress,
    setUploading: documentStore.setUploading,
  };
};

export const useSettings = () => {
  const settingsStore = useSettingsStore();
  return {
    settings: settingsStore.settings,
    isLoading: settingsStore.isLoading,
    error: settingsStore.error,
    userId: settingsStore.userId,
    loadSettings: settingsStore.loadSettings,
    updateSettings: settingsStore.updateSettings,
    resetSettings: settingsStore.resetSettings,
    validateApiKey: settingsStore.validateApiKey,
    setLoading: settingsStore.setLoading,
    setError: settingsStore.setError,
  };
};