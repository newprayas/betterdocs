import { GoogleGenAI } from '@google/genai';
import type { AppSettings, ApiKeyValidationResult } from '@/types/settings';

export class GeminiService {
  private genAI: GoogleGenAI | null = null;
  private modelName: string = 'gemma-3-27b-it';
  private embeddingModelName: string = 'voyage-4-large';

  // Embedding key rotation
  private embeddingKeys: string[] = [];
  private currentKeyIndex: number = 0;
  private embeddingGenAI: GoogleGenAI | null = null;

  initialize(apiKey: string, modelName: string = 'gemma-3-12b-it', embeddingModelName: string = 'voyage-4-large') {
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

  // Initialize with proxy (no client-side keys needed)
  initializeEmbeddingKeys() {
    console.log('[GEMINI EMBEDDING]', 'Using Server-Side Proxy for embeddings (Secure Mode)');
    return true;
  }

  // Switch to the next embedding key (No-op for proxy)
  private switchToNextEmbeddingKey(): boolean {
    console.log('[GEMINI EMBEDDING]', 'Key rotation handled by server proxy');
    return true;
  }

  // ... (getSDKVersion, ensureInitialized kept same)

  private shouldUseClientEmbeddingFallback(): boolean {
    if (typeof window === 'undefined') return false;

    const maybeCapacitor = (window as any).Capacitor;
    const isNativePlatform =
      typeof maybeCapacitor?.isNativePlatform === 'function'
        ? maybeCapacitor.isNativePlatform()
        : false;

    // Capacitor WebView has no Next.js API routes.
    return isNativePlatform;
  }

  private async embedTextViaVoyageDirect(text: string): Promise<Float32Array> {
    const voyageApiKey = process.env.NEXT_PUBLIC_VOYAGE_API_KEY;
    const voyageModel =
      process.env.NEXT_PUBLIC_VOYAGE_EMBEDDING_MODEL || 'voyage-4-large';
    const voyageDimension = Number(
      process.env.NEXT_PUBLIC_VOYAGE_EMBEDDING_DIMENSION || '1024'
    );

    if (!voyageApiKey) {
      throw new Error('Missing NEXT_PUBLIC_VOYAGE_API_KEY for client embedding fallback');
    }

    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${voyageApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: [text],
        model: voyageModel,
        output_dimension: voyageDimension,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Voyage direct embedding failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const values = data?.data?.[0]?.embedding;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Voyage direct embedding returned invalid payload');
    }

    return new Float32Array(values);
  }

  private ensureEmbeddingInitialized() {
    // Proxy is always "initialized"
    return;
  }

  // ... (generateResponse, generateStreamingResponse kept same)

  async embedText(text: string, retryCount: number = 0): Promise<Float32Array> {
    const preferDirect = this.shouldUseClientEmbeddingFallback();
    let proxyError: unknown = null;

    if (!preferDirect) {
      try {
        const response = await fetch('/api/embed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });

        if (!response.ok) {
          throw new Error(`Proxy error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (data.error) throw new Error(data.error);

        return new Float32Array(data.embedding);
      } catch (error: any) {
        proxyError = error;
        console.warn('[GEMINI EMBEDDING]', 'Proxy embedding failed, trying direct fallback');
      }
    }

    try {
      return await this.embedTextViaVoyageDirect(text);
    } catch (directError: any) {
      console.error('[GEMINI EMBEDDING ERROR]', 'Direct fallback failed:', directError);
      if (proxyError) {
        console.error('[GEMINI EMBEDDING ERROR]', 'Original proxy error:', proxyError);
      }
      throw new Error('Failed to generate embedding');
    }
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
