import { GoogleGenAI } from '@google/genai';
import type { AppSettings, ApiKeyValidationResult } from '@/types/settings';

export class GeminiService {
  private genAI: GoogleGenAI | null = null;
  private modelName: string = 'gemma-3-27b-it';
  private embeddingModelName: string = 'text-embedding-004';

  // Embedding key rotation
  private embeddingKeys: string[] = [];
  private currentKeyIndex: number = 0;
  private embeddingGenAI: GoogleGenAI | null = null;

  initialize(apiKey: string, modelName: string = 'gemma-3-12b-it', embeddingModelName: string = 'text-embedding-004') {
    try {
      console.log('[GEMINI INIT]', 'Starting Gemini service initialization with new SDK');
      console.log('[GEMINI INIT]', `API Key provided: ${apiKey ? 'YES' : 'NO'}`);
      console.log('[GEMINI INIT]', `Requested model name: ${modelName}`);
      console.log('[GEMINI INIT]', `Embedding model name: ${embeddingModelName}`);
      console.log('[GEMINI INIT]', `SDK Version: ${this.getSDKVersion()}`);

      this.genAI = new GoogleGenAI({ apiKey });
      this.modelName = modelName;
      this.embeddingModelName = embeddingModelName;

      console.log('[GEMINI INIT]', `GoogleGenAI instance created for model: ${modelName}`);
      console.log('[GEMINI INIT]', `Embedding model configured: ${embeddingModelName}`);
      console.log('[GEMINI INIT]', 'Gemini service initialization completed successfully');
    } catch (error) {
      console.error('[GEMINI INIT ERROR]', 'Failed to initialize Gemini:', error);
      console.error('[GEMINI INIT ERROR]', 'Error details:', {
        message: error instanceof Error ? error.message : String(error),
        status: (error as any)?.status,
        statusText: (error as any)?.statusText,
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new Error('Failed to initialize Gemini API');
    }
  }

  // Initialize with env-based embedding keys (no user key needed)
  initializeEmbeddingKeys() {
    // Load keys from environment variables
    const key1 = process.env.NEXT_PUBLIC_EMBEDDING_KEY_1;
    const key2 = process.env.NEXT_PUBLIC_EMBEDDING_KEY_2;
    const key3 = process.env.NEXT_PUBLIC_EMBEDDING_KEY_3;

    this.embeddingKeys = [key1, key2, key3].filter(Boolean) as string[];

    if (this.embeddingKeys.length === 0) {
      console.error('[GEMINI EMBEDDING]', 'No embedding keys found in environment variables!');
      return false;
    }

    console.log('[GEMINI EMBEDDING]', `Loaded ${this.embeddingKeys.length} embedding keys from environment`);

    // Initialize with the first key
    this.currentKeyIndex = 0;
    this.embeddingGenAI = new GoogleGenAI({ apiKey: this.embeddingKeys[0] });
    console.log('[GEMINI EMBEDDING]', 'Embedding service initialized with key 1');

    return true;
  }

  // Switch to the next embedding key
  private switchToNextEmbeddingKey(): boolean {
    if (this.embeddingKeys.length === 0) {
      console.error('[GEMINI EMBEDDING]', 'No embedding keys available to switch to');
      return false;
    }

    const previousIndex = this.currentKeyIndex;
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.embeddingKeys.length;

    console.log('[GEMINI EMBEDDING]', `Switching from key ${previousIndex + 1} to key ${this.currentKeyIndex + 1}`);

    this.embeddingGenAI = new GoogleGenAI({ apiKey: this.embeddingKeys[this.currentKeyIndex] });

    return true;
  }

  private getSDKVersion(): string {
    try {
      // Try to get version from package.json or other sources
      return '0.2.0'; // From package.json
    } catch {
      return 'unknown';
    }
  }

  private ensureInitialized() {
    if (!this.genAI) {
      throw new Error('Gemini service not initialized. Call initialize() first.');
    }
  }

  private ensureEmbeddingInitialized() {
    if (!this.embeddingGenAI) {
      // Try to auto-initialize embedding keys
      const success = this.initializeEmbeddingKeys();
      if (!success || !this.embeddingGenAI) {
        throw new Error('Embedding service not initialized. Check environment variables.');
      }
    }
  }

  async generateResponse(
    prompt: string,
    context?: string,
    systemPrompt?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<string> {
    this.ensureInitialized();

    try {
      let fullPrompt = '';

      if (systemPrompt) {
        fullPrompt += `System: ${systemPrompt}\n\n`;
      }

      if (context) {
        fullPrompt += `Context:\n${context}\n\n`;
      }

      fullPrompt += `User: ${prompt}`;

      const generationConfig = {
        temperature: options?.temperature || 0.7,
        maxOutputTokens: options?.maxTokens || 4096,
      };

      const result = await this.genAI!.models.generateContent({
        model: this.modelName,
        contents: fullPrompt,
        config: generationConfig
      });
      return result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
      console.error('Error generating response:', error);
      throw new Error('Failed to generate response from Gemini');
    }
  }

  async generateStreamingResponse(
    prompt: string,
    context?: string,
    systemPrompt?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      onChunk?: (chunk: string) => void;
    }
  ): Promise<AsyncIterable<string>> {
    this.ensureInitialized();

    try {
      let fullPrompt = '';

      if (systemPrompt) {
        fullPrompt += `System: ${systemPrompt}\n\n`;
      }

      if (context) {
        fullPrompt += `Context:\n${context}\n\n`;
      }

      fullPrompt += `User: ${prompt}`;

      const generationConfig = {
        temperature: options?.temperature || 0.7,
        maxOutputTokens: options?.maxTokens || 4096,
      };

      console.log('[GEMINI STREAM]', 'Starting streaming response generation');
      console.log('[GEMINI STREAM]', `Prompt length: ${fullPrompt.length} characters`);
      console.log('[GEMINI STREAM]', `Model being used: ${this.modelName || 'unknown'}`);
      console.log('[GEMINI STREAM]', `Temperature: ${generationConfig.temperature}`);
      console.log('[GEMINI STREAM]', `Max tokens: ${generationConfig.maxOutputTokens}`);

      const result = await this.genAI!.models.generateContentStream({
        model: this.modelName,
        contents: fullPrompt,
        config: generationConfig
      });

      console.log('[GEMINI STREAM]', 'Stream created successfully');
      return this.createStreamingIterable(result, options?.onChunk);
    } catch (error) {
      console.error('[GEMINI STREAM ERROR]', 'Error generating streaming response:', error);
      console.error('[GEMINI STREAM ERROR]', 'Error details:', {
        message: error instanceof Error ? error.message : String(error),
        status: (error as any)?.status,
        statusText: (error as any)?.statusText,
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new Error('Failed to generate streaming response from Gemini');
    }
  }

  private async *createStreamingIterable(
    result: AsyncIterable<any>,
    onChunk?: (chunk: string) => void
  ): AsyncIterable<string> {
    for await (const chunk of result) {
      const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (chunkText) {
        onChunk?.(chunkText);
        yield chunkText;
      }
    }
  }

  async embedText(text: string, retryCount: number = 0): Promise<Float32Array> {
    this.ensureEmbeddingInitialized();

    try {
      const result = await this.embeddingGenAI!.models.embedContent({
        model: this.embeddingModelName,
        contents: text
      });
      const embedding = result.embeddings?.[0];
      const values = embedding?.values || [];
      return new Float32Array(values);
    } catch (error: any) {
      console.error('[GEMINI EMBEDDING ERROR]', `Error with key ${this.currentKeyIndex + 1}:`, error?.message || error);

      // Check if we've tried all keys
      if (retryCount >= this.embeddingKeys.length - 1) {
        console.error('[GEMINI EMBEDDING ERROR]', 'All embedding keys have been exhausted');
        throw new Error('Failed to embed text: All API keys exhausted');
      }

      // Switch to next key and retry
      console.log('[GEMINI EMBEDDING]', `Switching to next key due to error (retry ${retryCount + 1})`);
      this.switchToNextEmbeddingKey();

      return this.embedText(text, retryCount + 1);
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.ensureEmbeddingInitialized();

    try {
      const embeddings = await Promise.all(
        texts.map(text => this.embedText(text))
      );
      return embeddings;
    } catch (error) {
      console.error('Error embedding batch:', error);
      throw new Error('Failed to embed batch with Gemini');
    }
  }

  async validateApiKey(apiKey: string): Promise<ApiKeyValidationResult> {
    const startTime = Date.now();

    try {
      // Check if API key format is valid (basic validation)
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        return {
          isValid: false,
          error: {
            type: 'INVALID_KEY',
            message: 'API key is required and must be a valid string'
          },
          responseTime: Date.now() - startTime
        };
      }

      // Check for basic Gemini API key format (starts with 'AIza')
      if (!apiKey.startsWith('AIza')) {
        return {
          isValid: false,
          error: {
            type: 'INVALID_KEY',
            message: 'Invalid API key format. Gemini API keys typically start with "AIza"'
          },
          responseTime: Date.now() - startTime
        };
      }

      const tempGenAI = new GoogleGenAI({ apiKey });

      // Try a simple generation to validate the key
      const result = await tempGenAI.models.generateContent({
        model: 'gemini-2.5-flash-lite',
        contents: 'Hello'
      });

      return {
        isValid: true,
        responseTime: Date.now() - startTime
      };
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      console.error('API key validation failed:', error);

      // Parse different types of errors
      if (error.status === 400) {
        return {
          isValid: false,
          error: {
            type: 'INVALID_KEY',
            message: 'Invalid API key. Please check your key and try again.',
            details: error.message
          },
          responseTime
        };
      } else if (error.status === 403) {
        return {
          isValid: false,
          error: {
            type: 'PERMISSION_DENIED',
            message: 'Permission denied. The API key might not have access to the Gemini API.',
            details: error.message
          },
          responseTime
        };
      } else if (error.status === 429) {
        return {
          isValid: false,
          error: {
            type: 'QUOTA_EXCEEDED',
            message: 'API quota exceeded. Please check your usage limits and try again later.',
            details: error.message
          },
          responseTime
        };
      } else if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
        return {
          isValid: false,
          error: {
            type: 'NETWORK_ERROR',
            message: 'Network error. Please check your internet connection and try again.',
            details: error.message
          },
          responseTime
        };
      } else {
        return {
          isValid: false,
          error: {
            type: 'UNKNOWN_ERROR',
            message: 'An unexpected error occurred while validating the API key.',
            details: error.message || String(error)
          },
          responseTime
        };
      }
    }
  }


  isInitialized(): boolean {
    return this.genAI !== null;
  }

  isEmbeddingInitialized(): boolean {
    return this.embeddingGenAI !== null;
  }

  // Get current embedding key index (for debugging)
  getCurrentEmbeddingKeyIndex(): number {
    return this.currentKeyIndex;
  }
}

// Singleton instance
export const geminiService = new GeminiService();