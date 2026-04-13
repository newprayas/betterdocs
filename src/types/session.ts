// Session types for the RAG chat application

export interface Session {
  id: string;
  userId: string;
  name: string;
  description?: string;
  isDrugSession?: boolean;
  createdAt: Date;
  updatedAt: Date;
  documentCount: number;
  messageCount?: number;
  lastMessageAt?: Date;
  latestRewriteQueryResponse?: string | null;
}

export interface SessionCreate {
  name: string;
  description?: string;
  isDrugSession?: boolean;
}

export interface SessionUpdate {
  name?: string;
  description?: string;
  isDrugSession?: boolean;
  updatedAt?: Date;
  documentCount?: number;
  latestRewriteQueryResponse?: string | null;
}
