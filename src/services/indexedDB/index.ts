// IndexedDB services export
import { RAGDatabase } from './db';
import { SessionService } from './sessionService';
import { MessageService } from './messageService';
import { DocumentService } from './documentService';
import { EmbeddingService } from './embeddingService';
import { SettingsService } from './settingsService';

// Re-export services
export { RAGDatabase, SessionService, MessageService, DocumentService, EmbeddingService, SettingsService };

// Service factory for easy dependency injection
export class IndexedDBServices {
  private db: RAGDatabase;
  
  public sessionService: SessionService;
  public messageService: MessageService;
  public documentService: DocumentService;
  public embeddingService: EmbeddingService;
  public settingsService: SettingsService;

  constructor() {
    this.db = new RAGDatabase();
    
    this.sessionService = new SessionService();
    this.messageService = new MessageService();
    this.documentService = new DocumentService();
    this.embeddingService = new EmbeddingService();
    this.settingsService = new SettingsService();
  }

  /**
   * Initialize database and services
   */
  async initialize(): Promise<void> {
    await this.db.open();
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Clear all data (for reset functionality)
   */
  async clearAllData(): Promise<void> {
    await this.db.delete();
    await this.db.open();
  }
}

// Singleton instance for global access
let indexedDBServices: IndexedDBServices | null = null;

export function getIndexedDBServices(): IndexedDBServices {
  if (!indexedDBServices) {
    indexedDBServices = new IndexedDBServices();
  }
  return indexedDBServices;
}

// Initialize services on import
export async function initializeIndexedDBServices(): Promise<IndexedDBServices> {
  const services = getIndexedDBServices();
  await services.initialize();
  return services;
}