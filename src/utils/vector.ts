import type { EmbeddingChunk, VectorSearchResult } from '@/types';

export class VectorUtils {
  /**
   * Calculate dot product of two vectors
   */
  static dotProduct(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must be the same length');
    }
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result += a[i] * b[i];
    }
    return result;
  }

  /**
   * Calculate Euclidean norm (magnitude) of a vector
   */
  static vectorNorm(vector: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
      sum += vector[i] * vector[i];
    }
    return Math.sqrt(sum);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    const dotProduct = VectorUtils.dotProduct(a, b);
    const normA = VectorUtils.vectorNorm(a);
    const normB = VectorUtils.vectorNorm(b);
    
    if (normA === 0 || normB === 0) {
      return 0;
    }
    
    return dotProduct / (normA * normB);
  }

  /**
   * Find top K most similar chunks to query vector
   */
  static findTopK(
    queryVector: Float32Array,
    chunks: EmbeddingChunk[],
    k: number,
    minSimilarity: number = 0.1
  ): VectorSearchResult[] {
    const matches: VectorSearchResult[] = [];
    
    for (const chunk of chunks) {
      const similarity = VectorUtils.cosineSimilarity(queryVector, chunk.embedding);
      
      if (similarity >= minSimilarity) {
        matches.push({
          chunk,
          similarity,
          document: {
            id: chunk.documentId,
            title: '', // Will be populated from document data
            fileName: '', // Will be populated from document data
          }
        });
      }
    }
    
    // Sort by similarity (descending) and take top K
    return matches
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  /**
   * Deduplicate matches by (document, page) to avoid redundant citations
   * When multiple chunks are from the same page, keeps the highest similarity one
   * and combines their content for better context
   */
  static deduplicateByPage(matches: VectorSearchResult[]): VectorSearchResult[] {
    const grouped = new Map<string, VectorSearchResult[]>();
    
    // Group matches by (document_id, page) key
    for (const match of matches) {
      const pageNum = match.chunk.metadata.pageNumber ?? -1; // -1 for null pages
      const key = `${match.chunk.documentId}_${pageNum}`;
      
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(match);
    }
    
    // For each group, select the best match and combine content
    const deduplicated: VectorSearchResult[] = [];
    
    for (const group of grouped.values()) {
      if (group.length === 0) continue;
      
      // Sort by similarity and take the best one as representative
      group.sort((a, b) => b.similarity - a.similarity);
      const bestMatch = group[0];
      
      // If multiple chunks from same page, combine their content
      if (group.length > 1) {
        const combinedContent = VectorUtils.combineUniqueContent(group);
        
        deduplicated.push({
          chunk: {
            ...bestMatch.chunk,
            content: combinedContent,
          },
          document: bestMatch.document,
          similarity: bestMatch.similarity,
        });
      } else {
        // Single chunk for this page, use as-is
        deduplicated.push(bestMatch);
      }
    }
    
    // Sort by similarity to maintain relevance order
    return deduplicated.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Combine unique content from multiple chunks
   */
  private static combineUniqueContent(matches: VectorSearchResult[]): string {
    const uniqueContents = new Set<string>();
    const combinedParts: string[] = [];
    
    for (const match of matches) {
      const content = match.chunk.content.trim();
      if (!uniqueContents.has(content)) {
        combinedParts.push(content);
        uniqueContents.add(content);
      }
    }
    
    return combinedParts.join('\n\n');
  }

  /**
   * Convert regular array to Float32Array for better performance
   */
  static toFloat32Array(array: number[]): Float32Array {
    return new Float32Array(array);
  }

  /**
   * Convert Float32Array back to regular array
   */
  static fromFloat32Array(float32Array: Float32Array): number[] {
    return Array.from(float32Array);
  }

  /**
   * Batch cosine similarity calculation for performance
   * This would be ideal for WebAssembly implementation
   */
  static async batchCosineSimilarity(
    query: Float32Array,
    vectors: Float32Array[]
  ): Promise<number[]> {
    // Simple implementation - in production, this would use WebAssembly
    return vectors.map(vector => VectorUtils.cosineSimilarity(query, vector));
  }

  /**
   * Validate vector format
   */
  static validateVector(vector: Float32Array): boolean {
    return (
      vector instanceof Float32Array &&
      vector.length > 0 &&
      vector.every(val => !isNaN(val) && isFinite(val))
    );
  }

  /**
   * Generate a random vector for testing
   */
  static generateRandomVector(dimensions: number): Float32Array {
    const vector = new Float32Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      vector[i] = Math.random() * 2 - 1; // Random value between -1 and 1
    }
    return vector;
  }
}