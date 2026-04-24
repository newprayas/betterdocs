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
  rewriteContext?: SessionRewriteContext | null;
}

export interface SessionRewriteContext {
  lastUserQuery: string;
  lastRewrittenQuery: string;
  lastTopic?: string | null;
  updatedAt: Date;
  recentTurns?: SessionRewriteTurn[];
}

export interface SessionRewriteTurn {
  userQuery: string;
  rewrittenQuery: string;
  topic?: string | null;
  updatedAt: Date;
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
  rewriteContext?: SessionRewriteContext | null;
}
