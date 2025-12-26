import Dexie, { Table } from 'dexie';

// Define EntityTable type locally if not exported from dexie
type EntityTable<T> = Table<T>;
import type {
  Session,
  Message,
  Document,
  EmbeddingChunk,
  AppSettings,
} from '@/types';

export class RAGDatabase extends Dexie {
  // Tables
  sessions!: EntityTable<Session>;
  messages!: EntityTable<Message>;
  documents!: EntityTable<Document>;
  embeddings!: EntityTable<EmbeddingChunk>;
  settings!: EntityTable<AppSettings>;

  constructor() {
    super('RAGDatabase');

    this.version(1).stores({
      sessions: '&id, name, description, systemPrompt, createdAt, updatedAt, documentCount',
      messages: '&id, sessionId, role, content, timestamp, citationsJson',
      documents: '&id, sessionId, filename, fileSize, status, pageCount, processedAt, createdAt, enabled, originalPath, storedPath, mimeType, checksum, title, author, language, ingestError',
      embeddings: '&id, documentId, sessionId, chunkIndex, content, source, page, embedding, tokenCount, embeddingNorm, createdAt',
      settings: '&id, geminiModel, topK, apiKey',
    });

    this.version(2).stores({
      sessions: '&id, name, description, systemPrompt, createdAt, updatedAt, documentCount',
      messages: '&id, sessionId, role, content, timestamp, citationsJson',
      documents: '&id, sessionId, filename, fileSize, status, pageCount, processedAt, createdAt, enabled, originalPath, storedPath, mimeType, checksum, title, author, language, ingestError',
      embeddings: '&id, documentId, sessionId, chunkIndex, content, source, page, embedding, tokenCount, embeddingNorm, createdAt',
      settings: '&id, geminiApiKey, temperature, maxTokens, similarityThreshold, chunkSize, chunkOverlap, theme, fontSize, showSources, autoSave, dataRetention, enableAnalytics, crashReporting, debugMode, logLevel',
    });

    // Version 3: Add support for pageNumbers in embeddings metadata
    this.version(3).stores({
      sessions: '&id, name, description, systemPrompt, createdAt, updatedAt, documentCount',
      messages: '&id, sessionId, role, content, timestamp, citationsJson',
      documents: '&id, sessionId, filename, fileSize, status, pageCount, processedAt, createdAt, enabled, originalPath, storedPath, mimeType, checksum, title, author, language, ingestError',
      embeddings: '&id, documentId, sessionId, chunkIndex, content, source, page, embedding, tokenCount, embeddingNorm, createdAt',
      settings: '&id, geminiApiKey, temperature, maxTokens, similarityThreshold, chunkSize, chunkOverlap, theme, fontSize, showSources, autoSave, dataRetention, enableAnalytics, crashReporting, debugMode, logLevel',
    }).upgrade(tx => {
      // Migration for existing embeddings to ensure backward compatibility
      return tx.table('embeddings').toCollection().modify((embedding: any) => {
        // Ensure metadata exists and has proper structure
        if (!embedding.metadata) {
          embedding.metadata = {};
        }

        // If pageNumbers doesn't exist but pageNumber does, create pageNumbers array
        if (!embedding.metadata.pageNumbers && embedding.metadata.pageNumber) {
          embedding.metadata.pageNumbers = [embedding.metadata.pageNumber];
        }
      });
    });

    // Version 4: Add userId to all tables
    this.version(4).stores({
      sessions: '&id, userId, name, description, systemPrompt, createdAt, updatedAt, documentCount',
      messages: '&id, sessionId, role, content, timestamp, citationsJson', // Messages are linked to session, which has userId
      documents: '&id, userId, sessionId, filename, fileSize, status, pageCount, processedAt, createdAt, enabled, originalPath, storedPath, mimeType, checksum, title, author, language, ingestError',
      embeddings: '&id, documentId, sessionId, chunkIndex, content, source, page, embedding, tokenCount, embeddingNorm, createdAt', // Embeddings linked to document/session
      settings: '&id, userId, geminiApiKey, temperature, maxTokens, similarityThreshold, chunkSize, chunkOverlap, theme, fontSize, showSources, autoSave, dataRetention, enableAnalytics, crashReporting, debugMode, logLevel',
    });

    // NEW: Version 5 to add 'model' to settings
    this.version(5).stores({
      sessions: '&id, userId, name, description, systemPrompt, createdAt, updatedAt, documentCount',
      messages: '&id, sessionId, role, content, timestamp, citationsJson',
      documents: '&id, userId, sessionId, filename, fileSize, status, pageCount, processedAt, createdAt, enabled, originalPath, storedPath, mimeType, checksum, title, author, language, ingestError',
      embeddings: '&id, documentId, sessionId, chunkIndex, content, source, page, embedding, tokenCount, embeddingNorm, createdAt',
      settings: '&id, userId, geminiApiKey, model, temperature, maxTokens, similarityThreshold, chunkSize, chunkOverlap, theme, fontSize, showSources, autoSave, dataRetention, enableAnalytics, crashReporting, debugMode, logLevel',
    }).upgrade(tx => {
      // Upgrade existing settings to have a default model
      return tx.table('settings').toCollection().modify(setting => {
        if (!setting.model) {
          setting.model = 'gemini-2.5-flash-lite';
        }
      });
    });

    // Version 6: Add compound index for messages to optimize queries
    this.version(6).stores({
      sessions: '&id, userId, name, description, systemPrompt, createdAt, updatedAt, documentCount',
      messages: '&id, sessionId, role, content, timestamp, citationsJson, [sessionId+timestamp]',
      documents: '&id, userId, sessionId, filename, fileSize, status, pageCount, processedAt, createdAt, enabled, originalPath, storedPath, mimeType, checksum, title, author, language, ingestError',
      embeddings: '&id, documentId, sessionId, chunkIndex, content, source, page, embedding, tokenCount, embeddingNorm, createdAt',
      settings: '&id, userId, geminiApiKey, model, temperature, maxTokens, similarityThreshold, chunkSize, chunkOverlap, theme, fontSize, showSources, autoSave, dataRetention, enableAnalytics, crashReporting, debugMode, logLevel',
    });

    // Version 80: Bump version to fix "VersionError" (local DB was at v70)
    // No schema changes needed, just a version bump to override the mismatch.
    this.version(80).stores({
      sessions: '&id, userId, name, description, systemPrompt, createdAt, updatedAt, documentCount',
      messages: '&id, sessionId, role, content, timestamp, citationsJson, [sessionId+timestamp]',
      documents: '&id, userId, sessionId, filename, fileSize, status, pageCount, processedAt, createdAt, enabled, originalPath, storedPath, mimeType, checksum, title, author, language, ingestError',
      embeddings: '&id, documentId, sessionId, chunkIndex, content, source, page, embedding, tokenCount, embeddingNorm, createdAt',
      settings: '&id, userId, geminiApiKey, model, temperature, maxTokens, similarityThreshold, chunkSize, chunkOverlap, theme, fontSize, showSources, autoSave, dataRetention, enableAnalytics, crashReporting, debugMode, logLevel',
    });
  }
}


// Only create database instance on client side (Window or Worker)
const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
export const db = isBrowser ? new RAGDatabase() : null;

// Helper functions for database operations
export const initDB = async (): Promise<void> => {
  if (!db) return;
  try {
    await db.open();
    console.log('Database opened successfully');
  } catch (error) {
    console.error('Failed to open database:', error);
    throw error;
  }
};

// Export database instance for use throughout the app
export default db;