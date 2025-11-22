// Gemini API services
export { geminiService } from './geminiService';
export { embeddingService } from './embeddingService';
export { chatService, type ChatStreamEvent } from './chatService';

// Service factory for easy dependency injection
export class GeminiServiceFactory {
  private static initialized = false;

  static async initialize(apiKey: string, modelName?: string, embeddingModelName?: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const { geminiService } = await import('./geminiService');
      geminiService.initialize(apiKey, modelName, embeddingModelName);
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize Gemini services:', error);
      throw error;
    }
  }

  static isInitialized(): boolean {
    return this.initialized;
  }

  static reset(): void {
    this.initialized = false;
  }
}

// Export convenience functions
export const initializeGeminiServices = GeminiServiceFactory.initialize;
export const isGeminiInitialized = GeminiServiceFactory.isInitialized;
export const resetGeminiServices = GeminiServiceFactory.reset;