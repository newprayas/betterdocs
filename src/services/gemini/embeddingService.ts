import { geminiService } from './geminiService';
import type { EmbeddingChunk } from '@/types/embedding';
import type { Document } from '@/types/document';

export class EmbeddingService {
  async generateEmbedding(text: string): Promise<Float32Array> {
    try {
      return await geminiService.embedText(text);
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw new Error('Failed to generate embedding');
    }
  }

  async generateEmbeddingsBatch(texts: string[]): Promise<Float32Array[]> {
    try {
      return await geminiService.embedBatch(texts);
    } catch (error) {
      console.error('Error generating batch embeddings:', error);
      throw new Error('Failed to generate batch embeddings');
    }
  }

  async processDocumentChunks(
    document: Document,
    chunks: Array<{
      id: string;
      text: string;
      metadata?: any;
    }>
  ): Promise<EmbeddingChunk[]> {
    try {
      const texts = chunks.map(chunk => chunk.text);
      const embeddings = await this.generateEmbeddingsBatch(texts);

      return chunks.map((chunk, index) => ({
        id: chunk.id,
        documentId: document.id,
        sessionId: document.sessionId,
        chunkIndex: index,
        content: chunk.text,
        source: document.filename,
        page: chunk.metadata?.page,
        embedding: embeddings[index],
        tokenCount: this.estimateTokenCount(chunk.text),
        embeddingNorm: this.calculateNorm(embeddings[index]),
        metadata: {
          pageNumber: chunk.metadata?.page,
          chunkIndex: index,
          startPosition: 0, // TODO: Calculate actual position
          endPosition: chunk.text.length,
          tokenCount: this.estimateTokenCount(chunk.text),
        },
        createdAt: new Date(),
      }));
    } catch (error) {
      console.error('Error processing document chunks:', error);
      throw new Error('Failed to process document chunks');
    }
  }

  private estimateTokenCount(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private calculateNorm(vector: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
      sum += vector[i] * vector[i];
    }
    return Math.sqrt(sum);
  }

  async validateEmbedding(embedding: Float32Array): Promise<boolean> {
    try {
      // Check if embedding has valid dimensions (should be 768 for gemini-embedding-001)
      if (embedding.length !== 768) {
        return false;
      }

      // Check for NaN or Infinity values
      for (let i = 0; i < embedding.length; i++) {
        if (!isFinite(embedding[i])) {
          return false;
        }
      }

      // Check if embedding norm is reasonable (not all zeros)
      const norm = this.calculateNorm(embedding);
      return norm > 0;
    } catch (error) {
      console.error('Error validating embedding:', error);
      return false;
    }
  }

  normalizeEmbedding(embedding: Float32Array): Float32Array {
    const norm = this.calculateNorm(embedding);
    if (norm === 0) {
      return embedding; // Avoid division by zero
    }

    const normalized = new Float32Array(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      normalized[i] = embedding[i] / norm;
    }

    return normalized;
  }

  async generateEmbeddingWithRetry(
    text: string,
    maxRetries: number = 3
  ): Promise<Float32Array> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const embedding = await this.generateEmbedding(text);
        
        if (await this.validateEmbedding(embedding)) {
          return embedding;
        } else {
          throw new Error('Generated embedding failed validation');
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error');
        
        if (attempt === maxRetries) {
          break;
        }

        // Exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('Failed to generate embedding after retries');
  }
}

// Singleton instance
export const embeddingService = new EmbeddingService();