// Simplified citation types for RAG chat application

export interface SimplifiedCitation {
  document: string;
  page: number;
  combinedContent: string; // Combined content from all chunks on this page
  sourceIndex: number; // Original source index from search results
  chunkIds: string[]; // IDs of all chunks that were combined
  similarity?: number; // Highest similarity score from the combined chunks
}

export interface SimplifiedCitationGroup {
  citations: SimplifiedCitation[];
  renumberedResponse: string;
  usedSourceIndices: number[];
  validationWarnings?: string[]; // Add validation warnings for simplified system
}

export interface PageGroup {
  documentId: string;
  documentTitle: string;
  page: number;
  chunks: Array<{
    id: string;
    content: string;
    similarity: number;
  }>;
}