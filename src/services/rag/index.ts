// RAG (Retrieval-Augmented Generation) services
export { vectorSearchService } from './vectorSearch';
export { documentProcessor } from './documentProcessor';
export { chatPipeline } from './chatPipeline';
export { packageValidator } from './packageValidator';
export { citationService } from './citationService';
export { ResponseFormatter } from './responseFormatter';
export { metadataExtractor } from './metadataExtractor';
export { ingestionErrorHandler } from './errorHandler';
export { progressTracker, createDocumentIngestionOperation, createVectorSearchOperation, createChatGenerationOperation } from './progressTracker';

// Re-export types for convenience
export type { VectorSearchResult } from '@/types/embedding';
export type { ChatStreamEvent } from '../gemini/chatService';
export type { ExtractedMetadata, MetadataExtractionResult } from './metadataExtractor';
export type { ProcessedCitations, Citation } from './citationService';
export type { IngestionError, ErrorHandlingResult, ErrorContext } from './errorHandler';
export type { ProgressOperation, ProgressStep, ProgressEvent, ProgressCallback } from './progressTracker';