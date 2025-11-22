// Main services export file
export * from './indexedDB';
export * from './gemini';
export * from './rag';
export * from './libraryService';

// Service factory for easy dependency injection
import { getIndexedDBServices } from './indexedDB';
import { geminiService, embeddingService, chatService } from './gemini';
import { vectorSearchService, documentProcessor, chatPipeline } from './rag';
import { libraryService } from './libraryService';

export const services = {
  // IndexedDB services
  indexedDB: getIndexedDBServices(),
  
  // Gemini API services
  gemini: geminiService,
  embedding: embeddingService,
  chat: chatService,
  
  // RAG services
  vectorSearch: vectorSearchService,
  documentProcessor: documentProcessor,
  chatPipeline: chatPipeline,
  
  // Library service
  library: libraryService,
};

export default services;