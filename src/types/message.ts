export enum MessageSender {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

export interface Message {
  id: string;
  sessionId: string;
  content: string;
  role: MessageSender;
  timestamp: Date;
  citations?: Citation[];
}

export interface Citation {
  document: string;
  page?: number;
  pages?: number[]; // Multiple pages for combined chunks
  pageRange?: string; // Formatted page range like "5-7" or "5,7,9"
  excerpt?: string;
  isCombined?: boolean; // Flag to indicate if this is from a combined chunk
  originalChunkCount?: number; // Number of original chunks combined
  combinedChunkIds?: string[]; // IDs of original chunks that were combined
}

export interface MessageCreate {
  sessionId: string;
  content: string;
  role: MessageSender;
  citations?: Citation[];
}

export interface ChatRequest {
  sessionId: string;
  message: string;
}

export interface ChatStreamEvent {
  type: 'userMessage' | 'status' | 'citations' | 'textChunk' | 'done' | 'error';
  message?: string;
  citations?: Citation[];
}