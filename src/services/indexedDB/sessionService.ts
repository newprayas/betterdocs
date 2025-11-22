import { db } from './db';
import type { Session, SessionCreate, SessionUpdate } from '@/types';
import { ensureDate } from '@/utils/date';
import { userIdLogger } from '@/utils/userIdDebugLogger';

export class SessionService {
  /**
   * Create a new session
   */
  async createSession(data: SessionCreate, userId: string): Promise<Session> {
    userIdLogger.logServiceCall('sessionService', 'createSession', 'create', userId);
    
    if (!db) throw new Error('Database not available');
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('sessionService.createSession', new Error('Attempt to create session without userId'), userId);
      throw new Error('userId is required to create a session');
    }
    
    const session: Session = {
      id: crypto.randomUUID(),
      userId,
      name: data.name,
      description: data.description,
      createdAt: new Date(),
      updatedAt: new Date(),
      documentCount: 0,
    };

    await db.sessions.add(session);
    return session;
  }

  /**
   * Get all sessions for a user ordered by updatedAt (most recent first)
   */
  async getSessions(userId: string): Promise<Session[]> {
    userIdLogger.logServiceCall('sessionService', 'getSessions', 'read', userId);
    
    if (!db) return [];
    
    // Validate userId
    if (!userId) {
      userIdLogger.logError('sessionService.getSessions', new Error('Attempt to get sessions without userId'), userId);
      return [];
    }
    
    const sessions = await db.sessions
      .where('userId')
      .equals(userId)
      .reverse()
      .sortBy('updatedAt');

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return sessions.map(session => ({
      ...session,
      createdAt: ensureDate(session.createdAt),
      updatedAt: ensureDate(session.updatedAt),
      lastMessageAt: session.lastMessageAt ? ensureDate(session.lastMessageAt) : undefined
    }));
  }

  /**
   * Get a specific session by ID
   */
  async getSession(id: string, userId?: string): Promise<Session | undefined> {
    userIdLogger.logServiceCall('sessionService', 'getSession', 'read', userId || null);
    
    if (!db) return undefined;
    const session = await db.sessions.get(id);
    if (!session) return undefined;

    // If userId is provided, verify session ownership
    if (userId && session.userId !== userId) {
      userIdLogger.logError('sessionService.getSession', new Error('Attempt to access session belonging to different user'), userId);
      return undefined; // Return undefined if session doesn't belong to user
    }

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return {
      ...session,
      createdAt: ensureDate(session.createdAt),
      updatedAt: ensureDate(session.updatedAt),
      lastMessageAt: session.lastMessageAt ? ensureDate(session.lastMessageAt) : undefined
    };
  }

  /**
   * Update a session
   */
  async updateSession(id: string, updates: SessionUpdate, userId?: string): Promise<void> {
    userIdLogger.logServiceCall('sessionService', 'updateSession', 'update', userId || null);
    
    if (!db) return;
    const existing = await db.sessions.get(id);
    if (!existing) return;
    
    // If userId is provided, verify ownership
    if (userId && existing.userId !== userId) {
      userIdLogger.logError('sessionService.updateSession', new Error('Attempt to update session belonging to different user'), userId);
      return;
    }
    
    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date()
    };
    await db.sessions.put(updated);
  }

  /**
   * Delete a session and all related data
   */
  async deleteSession(id: string, userId?: string): Promise<void> {
    userIdLogger.logServiceCall('sessionService', 'deleteSession', 'delete', userId || null);
    
    if (!db) return;
    
    // First verify ownership if userId is provided
    if (userId) {
      const session = await db.sessions.get(id);
      if (!session) {
        userIdLogger.logError('sessionService.deleteSession', new Error('Attempt to delete non-existent session'), userId);
        return;
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('sessionService.deleteSession', new Error('Attempt to delete session belonging to different user'), userId);
        return;
      }
    }
    
    await db.transaction('rw', db.sessions, db.messages, db.documents, db.embeddings, async () => {
      // Delete session
      await db!.sessions.delete(id);

      // Delete related messages
      const messages = await db!.messages.where('sessionId').equals(id).toArray();
      await Promise.all(messages.map((message: any) => db!.messages.delete(message.id)));

      // Delete related documents and embeddings
      const documents = await db!.documents.where('sessionId').equals(id).toArray();
      for (const document of documents) {
        await db!.documents.delete(document.id);

        // Delete embeddings for this document
        const embeddings = await db!.embeddings.where('documentId').equals(document.id).toArray();
        await Promise.all(embeddings.map((embedding: any) => db!.embeddings.delete(embedding.id)));
      }
    });
  }

  /**
   * Update document count for a session
   */
  async updateDocumentCount(sessionId: string, userId?: string): Promise<void> {
    userIdLogger.logServiceCall('sessionService', 'updateDocumentCount', 'update', userId || null);
    
    if (!db) return;
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(sessionId);
      if (!session) {
        userIdLogger.logError('sessionService.updateDocumentCount', new Error('Attempt to update document count for non-existent session'), userId);
        return;
      }
      
      if (session.userId !== userId) {
        userIdLogger.logError('sessionService.updateDocumentCount', new Error('Attempt to update document count for session belonging to different user'), userId);
        return;
      }
    }
    
    const documentCount = await db.documents.where('sessionId').equals(sessionId).count();
    await this.updateSession(sessionId, { documentCount: documentCount || 0 }, userId);
  }
}

export const sessionService = new SessionService();