import { db } from './db';
import type { EmbeddingChunk, EmbeddingChunkCreate } from '@/types';
import { ensureDate } from '@/utils/date';
import { float32ToBytes, bytesToFloat32Array, calculateVectorNorm, validateVector } from '@/utils/vectorUtils';

export class EmbeddingService {
  /**
   * Create a new embedding chunk
   */
  async createEmbedding(data: EmbeddingChunkCreate): Promise<EmbeddingChunk> {
    // Validate embedding before storage
    if (!validateVector(data.embedding, 768)) {
      throw new Error('Invalid embedding: must have 768 dimensions and contain valid values');
    }

    // Calculate and store norm for faster similarity calculations
    const norm = calculateVectorNorm(data.embedding);

    const embedding: EmbeddingChunk = {
      id: crypto.randomUUID(),
      documentId: data.documentId,
      sessionId: data.sessionId,
      content: data.content,
      embedding: data.embedding,
      chunkIndex: data.metadata.chunkIndex, // Extract chunkIndex as top-level field
      source: data.metadata.source,
      page: data.metadata.pageNumber,
      tokenCount: data.metadata.tokenCount,
      embeddingNorm: norm,
      metadata: {
        ...data.metadata,
        pageNumber: data.metadata.pageNumber,
        pageNumbers: data.metadata.pageNumbers || (data.metadata.pageNumber ? [data.metadata.pageNumber] : undefined),
        embeddingNorm: norm,
        embeddingBytes: float32ToBytes(data.embedding), // Store as bytes for efficiency
      },
      createdAt: new Date(),
    };

    if (!db) throw new Error('Database not initialized');
    await db.embeddings.add(embedding);
    return embedding;
  }

  /**
   * Create multiple embedding chunks in batch
   */
  async createEmbeddingsBatch(embeddings: EmbeddingChunkCreate[]): Promise<void> {
    console.log('🔍 EMBEDDING SERVICE DEBUG: createEmbeddingsBatch called with:', {
      count: embeddings.length,
      documentIds: [...new Set(embeddings.map(e => e.documentId))],
      sessionIds: [...new Set(embeddings.map(e => e.sessionId))]
    });
    
    const embeddingChunks: EmbeddingChunk[] = embeddings.map(data => {
      // Validate embedding
      if (!validateVector(data.embedding, 768)) {
        throw new Error(`Invalid embedding for chunk ${data.documentId}: must have 768 dimensions and contain valid values`);
      }

      // Calculate norm for faster similarity calculations
      const norm = calculateVectorNorm(data.embedding);

      return {
        id: crypto.randomUUID(),
        documentId: data.documentId,
        sessionId: data.sessionId,
        chunkIndex: data.metadata.chunkIndex, // Extract chunkIndex as top-level field
        content: data.content,
        source: data.metadata.source,
        page: data.metadata.pageNumber,
        embedding: data.embedding,
        tokenCount: data.metadata.tokenCount,
        embeddingNorm: norm,
        metadata: {
          ...data.metadata,
          pageNumber: data.metadata.pageNumber,
          pageNumbers: data.metadata.pageNumbers || (data.metadata.pageNumber ? [data.metadata.pageNumber] : undefined),
          embeddingNorm: norm,
          embeddingBytes: float32ToBytes(data.embedding), // Store as bytes for efficiency
        },
        createdAt: new Date(),
      };
    });

    console.log('🔍 EMBEDDING SERVICE DEBUG: Processed embedding chunks:', {
      count: embeddingChunks.length,
      firstChunk: {
        id: embeddingChunks[0]?.id,
        documentId: embeddingChunks[0]?.documentId,
        sessionId: embeddingChunks[0]?.sessionId
      }
    });

    if (!db) throw new Error('Database not initialized');
    
    console.log('🔍 EMBEDDING SERVICE DEBUG: Starting transaction to save embeddings');
    await db.transaction('rw', db.embeddings, async () => {
      console.log('🔍 EMBEDDING SERVICE DEBUG: Transaction started, adding embeddings');
      await Promise.all(embeddingChunks.map(chunk => {
        if (!db) throw new Error('Database not initialized');
        console.log('🔍 EMBEDDING SERVICE DEBUG: Adding chunk:', {
          id: chunk.id,
          documentId: chunk.documentId,
          sessionId: chunk.sessionId
        });
        return db.embeddings.add(chunk);
      }));
      console.log('🔍 EMBEDDING SERVICE DEBUG: All embeddings added to transaction');
    });
    
    console.log('🔍 EMBEDDING SERVICE DEBUG: Transaction completed successfully');
  }

  /**
   * Get all embeddings for a document
   */
  async getEmbeddingsByDocument(documentId: string): Promise<EmbeddingChunk[]> {
    if (!db) throw new Error('Database not initialized');
    const embeddings = await db.embeddings
      .where('documentId')
      .equals(documentId)
      .sortBy('chunkIndex');
    
    // Ensure createdAt is a Date object (handles IndexedDB serialization)
    return embeddings.map(embedding => ({
      ...embedding,
      createdAt: ensureDate(embedding.createdAt)
    }));
  }

  /**
   * Get all embeddings for a session
   */
  async getEmbeddingsBySession(sessionId: string, userId?: string): Promise<EmbeddingChunk[]> {
    if (!db) throw new Error('Database not initialized');
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(sessionId);
      if (!session || session.userId !== userId) {
        return []; // Return empty array if session doesn't exist or doesn't belong to user
      }
    }
    
    const embeddings = await db.embeddings
      .where('sessionId')
      .equals(sessionId)
      .toArray();
    
    // Ensure createdAt is a Date object (handles IndexedDB serialization)
    return embeddings.map(embedding => ({
      ...embedding,
      createdAt: ensureDate(embedding.createdAt)
    }));
  }

  /**
   * Get embeddings for enabled documents in a session
   */
  async getEnabledEmbeddingsBySession(sessionId: string, userId?: string): Promise<EmbeddingChunk[]> {
    // First get enabled documents for the session
    if (!db) throw new Error('Database not initialized');
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(sessionId);
      if (!session || session.userId !== userId) {
        return []; // Return empty array if session doesn't exist or doesn't belong to user
      }
    }
    
    const enabledDocuments = await db.documents
      .where('sessionId')
      .equals(sessionId)
      .and((doc: any) => doc.enabled === true)
      .toArray();

    const documentIds = enabledDocuments.map((doc: any) => doc.id);

    // Then get embeddings for those documents
    if (documentIds.length === 0) {
      return [];
    }

    if (!db) throw new Error('Database not initialized');
    const embeddings = await db.embeddings
      .where('documentId')
      .anyOf(documentIds)
      .toArray();
    
    // Ensure createdAt is a Date object (handles IndexedDB serialization)
    return embeddings.map(embedding => ({
      ...embedding,
      createdAt: ensureDate(embedding.createdAt)
    }));
  }

  /**
   * Delete embeddings for a document
   */
  async deleteEmbeddingsByDocument(documentId: string): Promise<void> {
    if (!db) throw new Error('Database not initialized');
    await db.embeddings.where('documentId').equals(documentId).delete();
  }

  /**
   * Check if embeddings already exist for a document
   */
  async embeddingsExistForDocument(documentId: string): Promise<boolean> {
    if (!db) throw new Error('Database not initialized');
    const count = await db.embeddings.where('documentId').equals(documentId).count();
    return count > 0;
  }

  /**
   * Create embeddings with idempotent behavior
   * Deletes existing embeddings for the document before creating new ones
   */
  async createEmbeddingsIdempotent(embeddings: EmbeddingChunkCreate[]): Promise<void> {
    if (!embeddings || embeddings.length === 0) return;
    
    const documentId = embeddings[0].documentId;
    console.log('🔍 EMBEDDING SERVICE DEBUG: createEmbeddingsIdempotent called for document:', documentId);
    
    try {
      // First check if embeddings already exist
      const existingEmbeddings = await this.embeddingsExistForDocument(documentId);
      
      if (existingEmbeddings) {
        console.log('🔍 EMBEDDING SERVICE DEBUG: Existing embeddings found, deleting before creating new ones');
        // Delete existing embeddings to avoid key constraint errors
        await this.deleteEmbeddingsByDocument(documentId);
      }
      
      // Create new embeddings
      await this.createEmbeddingsBatch(embeddings);
      console.log('🔍 EMBEDDING SERVICE DEBUG: Embeddings created successfully with idempotent approach');
    } catch (error) {
      console.error('🔴 EMBEDDING SERVICE ERROR: Failed to create embeddings idempotently:', error);
      
      // Check if it's a constraint violation
      if (error instanceof Error && error.name === 'ConstraintError') {
        console.log('🔍 EMBEDDING SERVICE DEBUG: Constraint error detected, attempting cleanup and retry');
        try {
          // Try to clean up and retry once
          await this.deleteEmbeddingsByDocument(documentId);
          await this.createEmbeddingsBatch(embeddings);
          console.log('🔍 EMBEDDING SERVICE DEBUG: Retry after constraint error successful');
        } catch (retryError) {
          console.error('🔴 EMBEDDING SERVICE ERROR: Retry after constraint error failed:', retryError);
          throw retryError;
        }
      } else {
        throw error;
      }
    }
  }

  /**
   * Delete embeddings for a session
   */
  async deleteEmbeddingsBySession(sessionId: string): Promise<void> {
    if (!db) throw new Error('Database not initialized');
    await db.embeddings.where('sessionId').equals(sessionId).delete();
  }

  /**
   * Get embedding count for a document
   */
  async getEmbeddingCountByDocument(documentId: string): Promise<number> {
    if (!db) throw new Error('Database not initialized');
    return await db.embeddings.where('documentId').equals(documentId).count();
  }

  /**
   * Get embedding count for a session
   */
  async getEmbeddingCountBySession(sessionId: string): Promise<number> {
    if (!db) throw new Error('Database not initialized');
    return await db.embeddings.where('sessionId').equals(sessionId).count();
  }

  /**
   * Search embeddings by content (basic text search)
   */
  async searchEmbeddingsByContent(sessionId: string, query: string, userId?: string): Promise<EmbeddingChunk[]> {
    const embeddings = await this.getEnabledEmbeddingsBySession(sessionId, userId);
    const lowerQuery = query.toLowerCase();
    
    // Note: embeddings are already processed by getEnabledEmbeddingsBySession
    // so createdAt is already ensured to be a Date object
    return embeddings.filter(embedding =>
      embedding.content.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * Get embeddings with pagination
   */
  async getEmbeddingsPaginated(
    sessionId: string,
    offset: number = 0,
    limit: number = 100,
    userId?: string
  ): Promise<EmbeddingChunk[]> {
    if (!db) throw new Error('Database not initialized');
    
    // If userId is provided, verify session ownership
    if (userId) {
      const session = await db.sessions.get(sessionId);
      if (!session || session.userId !== userId) {
        return []; // Return empty array if session doesn't exist or doesn't belong to user
      }
    }
    
    const embeddings = await db.embeddings
      .where('sessionId')
      .equals(sessionId)
      .offset(offset)
      .limit(limit)
      .toArray();
    
    // Ensure createdAt is a Date object (handles IndexedDB serialization)
    return embeddings.map(embedding => ({
      ...embedding,
      createdAt: ensureDate(embedding.createdAt)
    }));
  }
}

export const embeddingService = new EmbeddingService();