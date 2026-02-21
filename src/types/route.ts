export interface RouteSectionRecord {
  sectionId: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  chunkCount: number;
  chunkIds: string[];
  vector: Float32Array;
  semanticLabel?: string;
  semanticScore?: number;
}

export interface RouteIndexRecord {
  id: string;
  documentId: string;
  sourceBin?: string;
  formatVersion: string;
  sectionPages: number;
  embeddingDimensions: number;
  bookVector: Float32Array;
  sections: RouteSectionRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface RouteCompanionSection {
  section_id?: string;
  title?: string;
  page_start?: number;
  page_end?: number;
  chunk_count?: number;
  chunk_ids?: string[];
  vector?: number[];
  semantic_label?: string;
  semantic_score?: number;
}

export interface RouteCompanionBook {
  book_id?: string;
  book_name?: string;
  source_bin?: string;
  embedding_dimensions?: number;
  chunk_count?: number;
  page_count?: number;
  book_vector?: number[];
  sections?: RouteCompanionSection[];
}

export interface RouteCompanionPayload {
  format_version?: string;
  section_pages?: number;
  books_count?: number;
  books?: RouteCompanionBook[];
}
