// Session types for the RAG chat application

export interface Session {
  id: string;
  userId: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  documentCount: number;
  messageCount?: number;
  lastMessageAt?: Date;
}

export interface SessionCreate {
  name: string;
  description?: string;
}

export interface SessionUpdate {
  name?: string;
  description?: string;
  updatedAt?: Date;
  documentCount?: number;
}