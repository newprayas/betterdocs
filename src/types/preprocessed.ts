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