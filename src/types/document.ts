// Document types for RAG chat application

export interface Document {
  id: string;
  userId: string;
  sessionId: string;
  filename: string;
  fileSize: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  pageCount?: number;
  processedAt?: Date;
  createdAt: Date;
  enabled: boolean;
  originalPath?: string;
  storedPath?: string;
  mimeType?: string;
  checksum?: string;
  title?: string;
  author?: string;
  language?: string;
  ingestError?: string;
}

export interface DocumentCreate {
  id?: string; // Optional ID for JSON imports
  sessionId: string;
  filename: string;
  fileSize: number;
  pageCount?: number;
  processedAt?: Date;
  originalPath?: string;
  storedPath?: string;
  mimeType?: string;
  checksum?: string;
  title?: string;
  author?: string;
  language?: string;
  ingestError?: string;
}

export interface DocumentUpdate {
  status?: Document['status'];
  pageCount?: number;
  processedAt?: Date;
  enabled?: boolean;
  originalPath?: string;
  storedPath?: string;
  mimeType?: string;
  checksum?: string;
  title?: string;
  author?: string;
  language?: string;
  ingestError?: string;
}

export interface DocumentProgress {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  message?: string;
  error?: string;
}