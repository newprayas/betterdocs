/**
 * Utility functions for efficient vector storage and operations
 * Based on Flutter app's vector storage optimizations
 */

/**
 * Convert Float32Array to bytes for efficient storage
 * This reduces storage size and maintains precision
 */
export function float32ToBytes(float32Array: Float32Array): ArrayBuffer {
  // Handle both ArrayBuffer and SharedArrayBuffer
  const buffer = float32Array.buffer;
  if (buffer instanceof ArrayBuffer) {
    return buffer.slice(0);
  } else {
    // Convert SharedArrayBuffer to ArrayBuffer
    return new ArrayBuffer(buffer.byteLength);
  }
}

/**
 * Convert bytes back to Float32Array
 */
export function bytesToFloat32Array(buffer: ArrayBuffer): Float32Array {
  return new Float32Array(buffer);
}

/**
 * Calculate vector norm (L2 norm) for normalization
 */
export function calculateVectorNorm(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    sum += vector[i] * vector[i];
  }
  return Math.sqrt(sum);
}

/**
 * Normalize vector to unit length
 */
export function normalizeVector(vector: Float32Array): Float32Array {
  const norm = calculateVectorNorm(vector);
  if (norm === 0) {
    return vector; // Avoid division by zero
  }

  const normalized = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    normalized[i] = vector[i] / norm;
  }

  return normalized;
}

/**
 * Calculate cosine similarity between two vectors
 * Optimized for performance
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vector dimensions must match');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // Single loop for better performance
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

/**
 * Calculate dot product of two vectors
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vector dimensions must match');
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result += a[i] * b[i];
  }

  return result;
}

/**
 * Calculate Euclidean distance between two vectors
 */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vector dimensions must match');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  return Math.sqrt(sum);
}

/**
 * Calculate Manhattan distance between two vectors
 */
export function manhattanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Vector dimensions must match');
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }

  return sum;
}

/**
 * Validate vector dimensions and values
 */
export function validateVector(vector: Float32Array, expectedDimensions?: number): boolean {
  // Check dimensions
  if (expectedDimensions && vector.length !== expectedDimensions) {
    return false;
  }

  // Check for invalid values
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (!isFinite(value) || isNaN(value)) {
      return false;
    }
  }

  // Check if vector is all zeros (invalid for embeddings)
  const norm = calculateVectorNorm(vector);
  return norm > 0;
}

/**
 * Compress vector for storage (optional optimization)
 * Uses simple quantization to reduce storage size
 */
export function compressVector(vector: Float32Array, precision: number = 4): Int16Array {
  const compressed = new Int16Array(vector.length);
  const scale = Math.pow(10, precision);

  for (let i = 0; i < vector.length; i++) {
    compressed[i] = Math.round(vector[i] * scale);
  }

  return compressed;
}

/**
 * Decompress vector from compressed format
 */
export function decompressVector(compressed: Int16Array, precision: number = 4): Float32Array {
  const decompressed = new Float32Array(compressed.length);
  const scale = Math.pow(10, precision);

  for (let i = 0; i < compressed.length; i++) {
    decompressed[i] = compressed[i] / scale;
  }

  return decompressed;
}

/**
 * Calculate vector statistics for debugging
 */
export function getVectorStats(vector: Float32Array): {
  min: number;
  max: number;
  mean: number;
  std: number;
  norm: number;
} {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSquares = 0;

  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    sumSquares += value * value;
  }

  const mean = sum / vector.length;
  const variance = (sumSquares / vector.length) - (mean * mean);
  const std = Math.sqrt(Math.max(0, variance));
  const norm = Math.sqrt(sumSquares);

  return { min, max, mean, std, norm };
}

/**
 * Batch cosine similarity calculation for multiple vectors
 * Optimized for performance in vector search
 */
export function batchCosineSimilarity(
  query: Float32Array,
  vectors: Float32Array[]
): number[] {
  const queryNorm = calculateVectorNorm(query);
  if (queryNorm === 0) {
    return new Array(vectors.length).fill(0);
  }

  const similarities: number[] = [];

  for (const vector of vectors) {
    if (vector.length !== query.length) {
      similarities.push(0);
      continue;
    }

    const vectorNorm = calculateVectorNorm(vector);
    if (vectorNorm === 0) {
      similarities.push(0);
      continue;
    }

    const similarity = dotProduct(query, vector) / (queryNorm * vectorNorm);
    similarities.push(similarity);
  }

  return similarities;
}

/**
 * Create vector index for faster search (simple implementation)
 * In production, consider using specialized vector databases
 */
export interface VectorIndex {
  vectors: Float32Array[];
  norms: number[];
  metadata: any[];
}

export function createVectorIndex(): VectorIndex {
  return {
    vectors: [],
    norms: [],
    metadata: []
  };
}

export function addToVectorIndex(
  index: VectorIndex,
  vector: Float32Array,
  metadata: any
): void {
  index.vectors.push(vector);
  index.norms.push(calculateVectorNorm(vector));
  index.metadata.push(metadata);
}

export function searchVectorIndex(
  index: VectorIndex,
  query: Float32Array,
  maxResults: number = 10,
  similarityThreshold: number = 0.7
): Array<{ vector: Float32Array; similarity: number; metadata: any }> {
  const queryNorm = calculateVectorNorm(query);
  if (queryNorm === 0) {
    return [];
  }

  const results: Array<{ vector: Float32Array; similarity: number; metadata: any }> = [];

  for (let i = 0; i < index.vectors.length; i++) {
    const vector = index.vectors[i];
    const vectorNorm = index.norms[i];

    if (vectorNorm === 0) {
      continue;
    }

    const similarity = dotProduct(query, vector) / (queryNorm * vectorNorm);

    if (similarity >= similarityThreshold) {
      results.push({
        vector,
        similarity,
        metadata: index.metadata[i]
      });
    }
  }

  // Sort by similarity (descending) and limit results
  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}