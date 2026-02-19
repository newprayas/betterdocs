// Preprocessed package types for RAG chat application

export interface PreprocessedPackage {
  format_version: string;
  export_metadata: {
    exported_at: string;
    source_system: string;
    document_id: string;
    session_id: string;
  };
  document_metadata: {
    id: string;
    filename: string;
    file_size: number;
    page_count: number;
    processed_at: string;
    created_at: string;
    chunk_count: number;
    embedding_model: string;
    chunk_settings: {
      chunk_size: number;
      chunk_overlap: number;
    };
  };
  chunks: PreprocessedChunk[];
  ann_index?: PreprocessedAnnIndex;
}

export interface PreprocessedAnnIndex {
  algorithm: 'hnsw';
  embedding_dimensions: number;
  distance: 'cosine';
  params: {
    m: number;
    ef_construction: number;
    ef_search: number;
  };
  artifact_name?: string;
  artifact_checksum?: string;
  artifact_size?: number;
  id_map_name?: string;
  id_map_checksum?: string;
  id_map_size?: number;
  // Inline payloads for upload/import compatibility
  artifact_base64?: string;
  id_map?: string[];
}

// This interface is no longer needed as the new structure has chunks directly in the package
// export interface PreprocessedDocument {
//   id: string;
//   title: string;
//   fileName: string;
//   mimeType: string;
//   fileSize: number;
//   chunks: PreprocessedChunk[];
// }

export interface PreprocessedChunk {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    document_id: string;
    page: number;
    pageNumbers?: number[]; // Multiple pages for combined chunks
    chunk_index: number;
    source: string;
  };
  embedding_dimensions: number;
}

export interface PackageImportResult {
  success: boolean;
  sessionId: string;
  documentCount: number;
  chunkCount: number;
  error?: string;
}

export interface PackageValidationResult {
  isValid: boolean;
  version: string;
  errors: string[];
  warnings: string[];
}
