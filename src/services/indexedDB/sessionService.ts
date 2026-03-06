import { db } from './db';
import type { Session, SessionCreate, SessionUpdate } from '@/types';
import { ensureDate } from '@/utils/date';
import { userIdLogger } from '@/utils/userIdDebugLogger';

interface StartupCleanupSummary {
  orphanSessionsRemoved: number;
  orphanMessagesRemoved: number;
  orphanDocumentsRemoved: number;
  orphanEmbeddingsRemoved: number;
  orphanAnnIndexesRemoved: number;
  orphanRouteIndexesRemoved: number;
}

export class SessionService {
  private isLibrarySourcePath(path?: string): boolean {
    return typeof path === 'string' && path.startsWith('library:');
  }

  private buildAnnRecordId(documentId: string, algorithm: string, embeddingDimensions: number, version: string): string {
    return `${documentId}:${algorithm}:${embeddingDimensions}:${version}`;
  }

  private buildRouteRecordId(documentId: string): string {
    return `route:${documentId}:1`;
  }

  private async hasEmbeddings(documentId: string): Promise<boolean> {
    if (!db) return false;
    const count = await db.embeddings.where('documentId').equals(documentId).count();
    return count > 0;
  }

  private async transferEmbeddings(sourceDocumentId: string, targetDocumentId: string, targetSessionId: string): Promise<number> {
    if (!db) return 0;
    let moved = 0;
    await db.embeddings
      .where('documentId')
      .equals(sourceDocumentId)
      .modify((embedding: any) => {
        embedding.documentId = targetDocumentId;
        embedding.sessionId = targetSessionId;
        if (embedding.metadata && typeof embedding.metadata === 'object') {
          embedding.metadata.documentId = targetDocumentId;
          embedding.metadata.sessionId = targetSessionId;
        }
        moved++;
      });
    return moved;
  }

  private async transferAnnIndexes(sourceDocumentId: string, targetDocumentId: string): Promise<number> {
    if (!db) return 0;
    const sourceIndexes = await db.annIndexes.where('documentId').equals(sourceDocumentId).toArray();
    if (sourceIndexes.length === 0) return 0;

    let moved = 0;
    for (const index of sourceIndexes) {
      const targetId = this.buildAnnRecordId(targetDocumentId, index.algorithm, index.embeddingDimensions, index.version);
      const existingTarget = await db.annIndexes.get(targetId);
      if (existingTarget) {
        // Keep existing target asset and drop source duplicate to avoid bloat.
        await db.annIndexes.delete(index.id);
        continue;
      }

      await db.annIndexes.put({
        ...index,
        id: targetId,
        documentId: targetDocumentId,
        updatedAt: new Date()
      });
      await db.annIndexes.delete(index.id);
      moved++;
    }

    return moved;
  }

  private async transferRouteIndex(sourceDocumentId: string, targetDocumentId: string): Promise<boolean> {
    if (!db) return false;
    const source = await db.routeIndexes.get(this.buildRouteRecordId(sourceDocumentId));
    if (!source) return false;

    const targetId = this.buildRouteRecordId(targetDocumentId);
    const existingTarget = await db.routeIndexes.get(targetId);
    if (existingTarget) {
      // Keep existing target route index and remove source duplicate.
      await db.routeIndexes.delete(source.id);
      return false;
    }

    await db.routeIndexes.put({
      ...source,
      id: targetId,
      documentId: targetDocumentId,
      updatedAt: new Date()
    });
    await db.routeIndexes.delete(source.id);
    return true;
  }

  private async transferSharedLibraryDataIfNeeded(document: any): Promise<void> {
    if (!db) return;
    if (!this.isLibrarySourcePath(document.originalPath)) return;

    const siblingDocs = await db.documents
      .where('userId')
      .equals(document.userId)
      .filter((doc: any) =>
        doc.id !== document.id &&
        doc.originalPath === document.originalPath &&
        doc.sessionId !== document.sessionId
      )
      .toArray();

    // No other session references this library source: safe to fully remove heavy data.
    if (siblingDocs.length === 0) {
      return;
    }

    const siblingsWithEmbeddings: any[] = [];
    for (const sibling of siblingDocs) {
      if (await this.hasEmbeddings(sibling.id)) {
        siblingsWithEmbeddings.push(sibling);
      }
    }

    // Another sibling already carries embeddings: keep one copy only by dropping this source later.
    if (siblingsWithEmbeddings.length > 0) {
      return;
    }

    const sourceHasEmbeddings = await this.hasEmbeddings(document.id);
    if (!sourceHasEmbeddings) {
      return;
    }

    // Pick oldest sibling document as new canonical carrier.
    siblingDocs.sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const target = siblingDocs[0];

    const movedEmbeddings = await this.transferEmbeddings(document.id, target.id, target.sessionId);
    if (movedEmbeddings === 0) {
      return;
    }

    await this.transferAnnIndexes(document.id, target.id);
    await this.transferRouteIndex(document.id, target.id);

    await db.documents.update(target.id, {
      status: 'completed',
      processedAt: new Date(),
      ingestError: undefined
    });

    console.log('[SESSION DELETE]', 'Transferred shared library heavy data', {
      fromDocumentId: document.id,
      toDocumentId: target.id,
      movedEmbeddings
    });
  }

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
    
    await db.transaction('rw', [db.sessions, db.messages, db.documents, db.embeddings, db.annIndexes, db.routeIndexes], async () => {
      // Delete session
      await db!.sessions.delete(id);

      // Delete related messages
      await db!.messages.where('sessionId').equals(id).delete();

      // Delete related documents and embeddings
      const documents = await db!.documents.where('sessionId').equals(id).toArray();
      for (const document of documents) {
        await this.transferSharedLibraryDataIfNeeded(document);

        // Delete heavy data for this document (if it was transferred, these queries are no-ops).
        await db!.embeddings.where('documentId').equals(document.id).delete();
        await db!.annIndexes.where('documentId').equals(document.id).delete();
        await db!.routeIndexes.where('documentId').equals(document.id).delete();
        await db!.documents.delete(document.id);
      }
    });
  }

  /**
   * Remove orphaned records that no longer have a valid parent session/document.
   * This is safe to run on startup and helps recover quota from stale leftovers.
   */
  async cleanupOrphanedData(): Promise<StartupCleanupSummary> {
    const emptySummary: StartupCleanupSummary = {
      orphanSessionsRemoved: 0,
      orphanMessagesRemoved: 0,
      orphanDocumentsRemoved: 0,
      orphanEmbeddingsRemoved: 0,
      orphanAnnIndexesRemoved: 0,
      orphanRouteIndexesRemoved: 0,
    };

    if (!db) return emptySummary;

    return db.transaction('rw', [db.sessions, db.messages, db.documents, db.embeddings, db.annIndexes, db.routeIndexes], async () => {
      const summary: StartupCleanupSummary = { ...emptySummary };

      const sessions = await db!.sessions.toArray();
      const sessionIdSet = new Set(sessions.map((session) => session.id));

      // Messages with missing session.
      const orphanMessageIds: string[] = [];
      await db!.messages.toCollection().each((message: any) => {
        if (!sessionIdSet.has(message.sessionId)) {
          orphanMessageIds.push(message.id);
        }
      });
      if (orphanMessageIds.length > 0) {
        await db!.messages.bulkDelete(orphanMessageIds);
        summary.orphanMessagesRemoved = orphanMessageIds.length;
      }

      // Documents with missing session.
      const orphanDocumentIds: string[] = [];
      const allDocuments = await db!.documents.toArray();
      for (const document of allDocuments) {
        if (!sessionIdSet.has(document.sessionId)) {
          orphanDocumentIds.push(document.id);
        }
      }

      if (orphanDocumentIds.length > 0) {
        await db!.documents.bulkDelete(orphanDocumentIds);
        summary.orphanDocumentsRemoved = orphanDocumentIds.length;
      }

      // Rebuild valid document ID set after document cleanup.
      const remainingDocuments = await db!.documents.toArray();
      const validDocumentIds = new Set(remainingDocuments.map((document) => document.id));

      const orphanEmbeddingIds: string[] = [];
      await db!.embeddings.toCollection().each((embedding: any) => {
        if (!validDocumentIds.has(embedding.documentId)) {
          orphanEmbeddingIds.push(embedding.id);
        }
      });
      if (orphanEmbeddingIds.length > 0) {
        await db!.embeddings.bulkDelete(orphanEmbeddingIds);
        summary.orphanEmbeddingsRemoved = orphanEmbeddingIds.length;
      }

      const orphanAnnIndexIds: string[] = [];
      await db!.annIndexes.toCollection().each((entry: any) => {
        if (!validDocumentIds.has(entry.documentId)) {
          orphanAnnIndexIds.push(entry.id);
        }
      });
      if (orphanAnnIndexIds.length > 0) {
        await db!.annIndexes.bulkDelete(orphanAnnIndexIds);
        summary.orphanAnnIndexesRemoved = orphanAnnIndexIds.length;
      }

      const orphanRouteIndexIds: string[] = [];
      await db!.routeIndexes.toCollection().each((entry: any) => {
        if (!validDocumentIds.has(entry.documentId)) {
          orphanRouteIndexIds.push(entry.id);
        }
      });
      if (orphanRouteIndexIds.length > 0) {
        await db!.routeIndexes.bulkDelete(orphanRouteIndexIds);
        summary.orphanRouteIndexesRemoved = orphanRouteIndexIds.length;
      }

      return summary;
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
