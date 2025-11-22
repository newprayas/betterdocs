// Embedding types for RAG chat application

export interface EmbeddingChunk {
  id: string;
  documentId: string;
  sessionId: string;
  chunkIndex: number;
  content: string;
  source?: string;
  page?: number;
  embedding: Float32Array;
  tokenCount: number;
  embeddingNorm: number;
  metadata: {
    pageNumber?: number;
    pageNumbers?: number[]; // Store multiple page numbers for combined chunks
    chunkIndex: number;
    startPosition: number;
    endPosition: number;
    tokenCount: number;
    embeddingNorm?: number;
    embeddingBytes?: ArrayBuffer;
    documentId?: string;
    sessionId?: string;
    source?: string;
    documentTitle?: string;
    documentAuthor?: string;
    documentLanguage?: string;
    embeddingModel?: string;
    combinedChunkIds?: string[]; // Store original chunk IDs for combined chunks
    isCombined?: boolean; // Flag to indicate if this is a combined chunk
    originalChunkCount?: number; // Number of original chunks combined
  };
  createdAt: Date;
}

export interface EmbeddingChunkCreate {
  documentId: string;
  sessionId: string;
  content: string;
  embedding: Float32Array;
  metadata: {
    pageNumber?: number;
    pageNumbers?: number[]; // Multiple pages for combined chunks
    chunkIndex: number;
    startPosition: number;
    endPosition: number;
    tokenCount: number;
    documentId?: string;
    sessionId?: string;
    source?: string;
    documentTitle?: string;
    documentAuthor?: string;
    documentLanguage?: string;
    embeddingModel?: string;
  };
}

export interface VectorSearchResult {
  chunk: EmbeddingChunk;
  similarity: number;
  document: {
    id: string;
    title: string;
    fileName: string;
  };
}

export interface EmbeddingGenerationRequest {
  chunks: string[];
  documentId: string;
  sessionId: string;
}

export interface EmbeddingGenerationProgress {
  totalChunks: number;
  processedChunks: number;
  currentChunk: string;
  isComplete: boolean;
  error?: string;
}