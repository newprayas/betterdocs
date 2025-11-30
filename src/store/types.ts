import type { Session, SessionCreate, SessionUpdate } from '@/types';
import type { Message, ChatStreamEvent } from '@/types';
import type { Document, DocumentUpdate, DocumentProgress } from '@/types';
import type { AppSettings, SettingsUpdate } from '@/types';

export interface SessionStore {
  // State
  sessions: Session[];
  currentSession: Session | null;
  currentSessionId: string | null;
  isLoading: boolean;
  error: string | null;
  userId: string | null;

  // Actions
  loadSessions: (userId: string) => Promise<void>;
  createSession: (data: SessionCreate) => Promise<Session>;
  updateSession: (id: string, data: SessionUpdate) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setCurrentSession: (session: Session | null) => void;
  setCurrentSessionId: (id: string | null) => Promise<void>;
  setError: (error: string | null) => void;
  setUserId: (userId: string | null) => void;
  clearSessions: () => void;
}

export interface ChatStore {
  // State
  messages: Message[];
  isStreaming: boolean;
  streamingContent: string;
  streamingCitations: any[];
  error: string | null;
  isLoading: boolean;
  isReadingSources: boolean;
  progressPercentage: number;
  currentProgressStep: string;

  // Actions
  loadMessages: (sessionId: string) => Promise<void>;
  sendMessage: (sessionId: string, content: string) => Promise<void>;
  clearHistory: (sessionId: string) => Promise<void>;
  setStreamingState: (isStreaming: boolean, content?: string, citations?: any[]) => void;
  addMessage: (message: Message) => void;
  setError: (error: string | null) => void;
  setReadingSourcesState: (isReadingSources: boolean) => void;
  setProgressState: (percentage: number, step: string) => void;
}

export interface DocumentStore {
  // State
  documents: Document[];
  progressMap: Record<string, DocumentProgress>;
  isUploading: boolean;
  error: string | null;
  userId: string | null;

  // Actions
  loadDocuments: (sessionId: string) => Promise<void>;
  uploadDocuments: (sessionId: string, files: File[]) => Promise<void>;
  updateDocument: (id: string, data: DocumentUpdate) => Promise<void>;
  toggleDocumentEnabled: (id: string) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  setProgress: (documentId: string, progress: DocumentProgress) => void;
  clearProgress: (documentId: string) => void;
  setUploading: (isUploading: boolean) => void;
  setError: (error: string | null) => void;
  setUserId: (userId: string | null) => void;
  clearDocuments: () => void;
}

export interface SettingsStore {
  settings: AppSettings | null;
  isLoading: boolean;
  error: string | null;
  userId: string | null;

  loadSettings: (userId: string) => Promise<void>;
  updateSettings: (data: SettingsUpdate) => Promise<void>;
  resetSettings: () => Promise<void>;
  validateApiKey: (apiKey: string) => Promise<string | null>;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  setUserId: (userId: string | null) => void;
  clearSettings: () => void;
}

export interface AppStore extends SessionStore, ChatStore, DocumentStore, SettingsStore { }