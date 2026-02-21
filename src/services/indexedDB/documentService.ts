import { db } from './db';
import type { Document, DocumentCreate, DocumentUpdate } from '@/types';
import { ensureDate } from '@/utils/date';
import { userIdLogger } from '@/utils/userIdDebugLogger';
import { sessionService } from './sessionService';

export class DocumentService {
  /**
   * Create a new document
   */
  async createDocument(data: DocumentCreate, userId: string): Promise<Document> {
    userIdLogger.logServiceCall('documentService', 'createDocument', 'create', userId);

    console.log('🔍 DOCUMENT SERVICE DEBUG: createDocument called with:', {
      id: data.id,
      sessionId: data.sessionId,
      filename: data.filename,
      status: 'pending',
      userId
    });

    if (!db) throw new Error('Database not available');

    // Validate userId
    if (!userId) {
      userIdLogger.logError('documentService.createDocument', new Error('Attempt to create document without userId'), userId);
      throw new Error('userId is required to create a document');
    }

    const document: Document = {
      id: data.id || crypto.randomUUID(), // Allow custom ID for JSON imports
      userId,
      sessionId: data.sessionId,
      filename: data.filename,
      fileSize: data.fileSize,
      status: 'pending',
      pageCount: data.pageCount,
      processedAt: data.processedAt,
      createdAt: new Date(),
      enabled: true,
      originalPath: data.originalPath,
      storedPath: data.storedPath,
      mimeType: data.mimeType,
      checksum: data.checksum,
      title: data.title,
      author: data.author,
      language: data.language,
      ingestError: data.ingestError,
    };

    console.log('🔍 DOCUMENT SERVICE DEBUG: Document object to be added:', {
      id: document.id,
      sessionId: document.sessionId,
      filename: document.filename,
      status: document.status,
      enabled: document.enabled
    });

    await db.documents.add(document);

    // Update session document count
    await sessionService.updateDocumentCount(data.sessionId, userId);

    console.log('🔍 DOCUMENT SERVICE DEBUG: Document added to database, verifying...');

    // Verify the document was actually added
    const verifyDoc = await db.documents.get(document.id);
    console.log('🔍 DOCUMENT SERVICE DEBUG: Verification - document in database:', {
      found: !!verifyDoc,
      id: verifyDoc?.id,
      sessionId: verifyDoc?.sessionId,
      filename: verifyDoc?.filename,
      status: verifyDoc?.status,
      enabled: verifyDoc?.enabled
    });

    return document;
  }

  /**
   * Get all documents for a session
   */
  async getDocumentsBySession(sessionId: string, userId: string): Promise<Document[]> {
    userIdLogger.logServiceCall('documentService', 'getDocumentsBySession', 'read', userId);

    // console.log('🔍 DOCUMENT SERVICE DEBUG: getDocumentsBySession called with:', { sessionId, userId });

    if (!db) {
      console.log('🔍 DOCUMENT SERVICE DEBUG: Database not available, returning empty array');
      return [];
    }

    if (!userId) {
      userIdLogger.logError('documentService.getDocumentsBySession', new Error('Attempt to get documents without userId'), userId);
      console.log('🔍 DOCUMENT SERVICE DEBUG: No userId provided, returning empty array');
      return [];
    }

    // console.log('🔍 DOCUMENT SERVICE DEBUG: Querying documents for session:', sessionId, 'and user:', userId);

    // First, let's check all documents in the database
    const allDocs = await db.documents.toArray();
    // console.log('🔍 DOCUMENT SERVICE DEBUG: ALL documents in database:', {
    //   totalCount: allDocs.length,
    //   documents: allDocs.map(doc => ({
    //     id: doc.id,
    //     sessionId: doc.sessionId,
    //     userId: doc.userId,
    //     filename: doc.filename,
    //     status: doc.status,
    //     enabled: doc.enabled
    //   }))
    // });

    // Now check the specific session query with userId filter
    const documents = await db.documents
      .where('sessionId')
      .equals(sessionId)
      .and((doc: Document) => doc.userId === userId)
      .sortBy('createdAt');

    // console.log('🔍 DOCUMENT SERVICE DEBUG: Raw documents from database:', {
    //   count: documents.length,
    //   documents: documents.map(doc => ({
    //     id: doc.id,
    //     filename: doc.filename,
    //     status: doc.status,
    //     enabled: doc.enabled,
    //     sessionId: doc.sessionId,
    //     userId: doc.userId
    //   }))
    // });

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    const processedDocuments = documents.map(document => ({
      ...document,
      createdAt: ensureDate(document.createdAt),
      processedAt: document.processedAt ? ensureDate(document.processedAt) : undefined
    }));

    // console.log('🔍 DOCUMENT SERVICE DEBUG: Processed documents to return:', {
    //   count: processedDocuments.length,
    //   documents: processedDocuments.map(doc => ({
    //     id: doc.id,
    //     filename: doc.filename,
    //     status: doc.status,
    //     enabled: doc.enabled,
    //     sessionId: doc.sessionId,
    //     userId: doc.userId,
    //     processedAt: doc.processedAt
    //   }))
    // });

    return processedDocuments;
  }

  /**
   * Get enabled documents for a session
   */
  async getEnabledDocumentsBySession(sessionId: string, userId: string): Promise<Document[]> {
    if (!db) return [];
    if (!userId) return [];

    const documents = await db.documents
      .where('sessionId')
      .equals(sessionId)
      .and((doc: Document) => doc.enabled === true && doc.userId === userId)
      .sortBy('createdAt');

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return documents.map(document => ({
      ...document,
      createdAt: ensureDate(document.createdAt),
      processedAt: document.processedAt ? ensureDate(document.processedAt) : undefined
    }));
  }

  /**
   * Get a specific document by ID
   */
  async getDocument(id: string, userId?: string): Promise<Document | undefined> {
    userIdLogger.logServiceCall('documentService', 'getDocument', 'read', userId || null);

    if (!db) return undefined;
    const document = await db.documents.get(id);
    if (!document) return undefined;

    // If userId is provided, verify ownership
    if (userId && document.userId !== userId) {
      userIdLogger.logError('documentService.getDocument', new Error('Attempt to access document belonging to different user'), userId);
      console.log('🔍 DOCUMENT SERVICE DEBUG: Access denied - document belongs to different user');
      return undefined;
    }

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return {
      ...document,
      createdAt: ensureDate(document.createdAt),
      processedAt: document.processedAt ? ensureDate(document.processedAt) : undefined
    };
  }

  /**
   * Update a document
   */
  async updateDocument(id: string, updates: DocumentUpdate, userId?: string): Promise<void> {
    if (!db) return;
    const existing = await db.documents.get(id);
    if (!existing) return;

    // If userId is provided, verify ownership
    if (userId && existing.userId !== userId) {
      console.log('🔍 DOCUMENT SERVICE DEBUG: Update denied - document belongs to different user');
      return;
    }

    const updated = { ...existing, ...updates };
    await db.documents.put(updated);
  }

  /**
   * Update document status
   */
  async updateDocumentStatus(id: string, status: Document['status'], error?: string, userId?: string): Promise<void> {
    if (!db) return;
    await this.updateDocument(id, {
      status,
      ingestError: error,
      processedAt: status === 'completed' ? new Date() : undefined
    }, userId);
  }

  /**
   * Toggle document enabled status
   */
  async toggleDocumentEnabled(id: string, userId?: string): Promise<void> {
    const document = await this.getDocument(id, userId);
    if (document) {
      await this.updateDocument(id, { enabled: !document.enabled }, userId);
    }
  }

  /**
   * Delete a document and its embeddings
   */
  async deleteDocument(id: string, userId?: string): Promise<void> {
    userIdLogger.logServiceCall('documentService', 'deleteDocument', 'delete', userId || null);

    if (!db) return;

    // Validate userId
    if (!userId) {
      userIdLogger.logError('documentService.deleteDocument', new Error('Attempt to delete document without userId'), userId || null);
      console.log('🔍 DOCUMENT SERVICE DEBUG: Delete denied - no userId provided');
      return;
    }

    // Verify ownership before deletion
    const document = await this.getDocument(id, userId);
    if (!document) {
      userIdLogger.logError('documentService.deleteDocument', new Error('Delete denied - document not found or access denied'), userId);
      console.log('🔍 DOCUMENT SERVICE DEBUG: Delete denied - document not found or access denied');
      return;
    }

    await db.transaction('rw', db.documents, db.embeddings, db.annIndexes, db.routeIndexes, async () => {
      // Delete document
      await db!.documents.delete(id);

      // Delete related embeddings
      await db!.embeddings.where('documentId').equals(id).delete();

      // Delete related ANN index assets
      await db!.annIndexes.where('documentId').equals(id).delete();

      // Delete related route prefilter index assets
      await db!.routeIndexes.where('documentId').equals(id).delete();
    });

    // Update session document count
    await sessionService.updateDocumentCount(document.sessionId, userId);
  }

  /**
   * Get document count for a session
   */
  async getDocumentCount(sessionId: string, userId: string): Promise<number> {
    if (!db) return 0;
    if (!userId) return 0;
    return await db.documents
      .where('sessionId')
      .equals(sessionId)
      .and((doc: Document) => doc.userId === userId)
      .count();
  }

  /**
   * Get documents by status
   */
  async getDocumentsByStatus(sessionId: string, status: Document['status'], userId: string): Promise<Document[]> {
    if (!db) return [];
    if (!userId) return [];

    const documents = await db.documents
      .where('sessionId')
      .equals(sessionId)
      .and((doc: Document) => doc.status === status && doc.userId === userId)
      .sortBy('createdAt');

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return documents.map(document => ({
      ...document,
      createdAt: ensureDate(document.createdAt),
      processedAt: document.processedAt ? ensureDate(document.processedAt) : undefined
    }));
  }

  /**
   * Get processing documents for a session
   */
  async getProcessingDocuments(sessionId: string, userId: string): Promise<Document[]> {
    return await this.getDocumentsByStatus(sessionId, 'processing', userId);
  }

  /**
   * Get failed documents for a session
   */
  async getFailedDocuments(sessionId: string, userId: string): Promise<Document[]> {
    return await this.getDocumentsByStatus(sessionId, 'failed', userId);
  }

  /**
   * Check if a document with the given ID exists across all sessions
   * Returns the document if found, undefined otherwise
   */
  async getDocumentAcrossAllSessions(id: string): Promise<Document | undefined> {
    if (!db) return undefined;

    const document = await db.documents.get(id);
    if (!document) return undefined;

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return {
      ...document,
      createdAt: ensureDate(document.createdAt),
      processedAt: document.processedAt ? ensureDate(document.processedAt) : undefined
    };
  }

  /**
   * Get ALL documents for a user across ALL sessions
   * Used for cross-session duplicate detection
   */
  async getAllDocumentsForUser(userId: string): Promise<Document[]> {
    if (!db) return [];
    if (!userId) return [];

    const documents = await db.documents
      .filter((doc: Document) => doc.userId === userId)
      .toArray();

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return documents.map(document => ({
      ...document,
      createdAt: ensureDate(document.createdAt),
      processedAt: document.processedAt ? ensureDate(document.processedAt) : undefined
    }));
  }

  /**
   * Check if a document with the given filename exists in a specific session
   * Returns the document if found, undefined otherwise
   */
  async getDocumentByFilename(sessionId: string, filename: string, userId: string): Promise<Document | undefined> {
    if (!db) return undefined;
    if (!userId) return undefined;

    const document = await db.documents
      .where('sessionId')
      .equals(sessionId)
      .and((doc: Document) => doc.filename === filename && doc.userId === userId)
      .first();

    if (!document) return undefined;

    // Ensure date fields are Date objects (handles IndexedDB serialization)
    return {
      ...document,
      createdAt: ensureDate(document.createdAt),
      processedAt: document.processedAt ? ensureDate(document.processedAt) : undefined
    };
  }
}

export const documentService = new DocumentService();
