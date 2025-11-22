import type { PreprocessedPackage, PackageValidationResult } from '@/types/preprocessed';

export class PackageValidator {
  /**
   * Validate a preprocessed package format and structure
   */
  async validatePackage(packageData: any): Promise<PackageValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Check if package data exists
      if (!packageData || typeof packageData !== 'object') {
        return {
          isValid: false,
          version: 'unknown',
          errors: ['Package data is missing or invalid'],
          warnings
        };
      }

      // Extract version
      const version = packageData.format_version || 'unknown';

      // Validate format version
      if (!packageData.format_version) {
        errors.push('Missing format_version field');
      } else if (typeof packageData.format_version !== 'string') {
        errors.push('format_version must be a string');
      } else if (!this.isSupportedVersion(packageData.format_version)) {
        errors.push(`Unsupported format version: ${packageData.format_version}. Supported versions: 1.0`);
      }

      // Validate export_metadata
      const exportMetaValidation = this.validateExportMetadata(packageData.export_metadata);
      errors.push(...exportMetaValidation.errors);
      warnings.push(...exportMetaValidation.warnings);

      // Validate document_metadata
      const docMetaValidation = this.validateDocumentMetadata(packageData.document_metadata);
      errors.push(...docMetaValidation.errors);
      warnings.push(...docMetaValidation.warnings);

      // Validate chunks
      const chunksValidation = this.validateChunks(packageData.chunks, packageData.document_metadata);
      errors.push(...chunksValidation.errors);
      warnings.push(...chunksValidation.warnings);

      // Validate export_stats if present
      if (packageData.export_stats) {
        const statsValidation = this.validateExportStats(packageData.export_stats);
        errors.push(...statsValidation.errors);
        warnings.push(...statsValidation.warnings);
      }

      return {
        isValid: errors.length === 0,
        version,
        errors,
        warnings
      };

    } catch (error) {
      return {
        isValid: false,
        version: 'unknown',
        errors: [`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`],
        warnings
      };
    }
  }

  private isSupportedVersion(version: string): boolean {
    const supportedVersions = ['1.0'];
    return supportedVersions.includes(version);
  }

  private validateExportMetadata(exportMeta: any): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!exportMeta) {
      errors.push('Missing export_metadata section');
      return { errors, warnings };
    }

    if (typeof exportMeta !== 'object') {
      errors.push('export_metadata must be an object');
      return { errors, warnings };
    }

    // Required fields
    const requiredFields = ['exported_at', 'source_system', 'document_id', 'session_id'];
    for (const field of requiredFields) {
      if (!exportMeta[field]) {
        errors.push(`Missing required field in export_metadata: ${field}`);
      } else if (typeof exportMeta[field] !== 'string') {
        errors.push(`export_metadata.${field} must be a string`);
      }
    }

    // Validate exported_at format
    if (exportMeta.exported_at) {
      try {
        const exportDate = new Date(exportMeta.exported_at);
        if (isNaN(exportDate.getTime())) {
          errors.push('export_metadata.exported_at is not a valid ISO date');
        }
      } catch {
        errors.push('export_metadata.exported_at is not a valid date format');
      }
    }

    // Validate source_system
    if (exportMeta.source_system && exportMeta.source_system !== 'LocalDocs AI') {
      warnings.push(`Unusual source_system: ${exportMeta.source_system}. Expected 'LocalDocs AI'`);
    }

    return { errors, warnings };
  }

  private validateDocumentMetadata(docMeta: any): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!docMeta) {
      errors.push('Missing document_metadata section');
      return { errors, warnings };
    }

    if (typeof docMeta !== 'object') {
      errors.push('document_metadata must be an object');
      return { errors, warnings };
    }

    // Required fields
    const requiredFields = ['id', 'filename', 'file_size', 'page_count', 'chunk_count', 'embedding_model'];
    for (const field of requiredFields) {
      if (docMeta[field] === undefined || docMeta[field] === null) {
        errors.push(`Missing required field in document_metadata: ${field}`);
      }
    }

    // Type validation
    if (docMeta.file_size !== undefined && typeof docMeta.file_size !== 'number') {
      errors.push('document_metadata.file_size must be a number');
    }

    if (docMeta.page_count !== undefined && typeof docMeta.page_count !== 'number') {
      errors.push('document_metadata.page_count must be a number');
    }

    if (docMeta.chunk_count !== undefined && typeof docMeta.chunk_count !== 'number') {
      errors.push('document_metadata.chunk_count must be a number');
    }

    // Validate file size
    if (docMeta.file_size !== undefined && docMeta.file_size < 0) {
      errors.push('document_metadata.file_size must be non-negative');
    }

    // Validate page count
    if (docMeta.page_count !== undefined && docMeta.page_count < 1) {
      errors.push('document_metadata.page_count must be at least 1');
    }

    // Validate chunk count
    if (docMeta.chunk_count !== undefined && docMeta.chunk_count < 1) {
      errors.push('document_metadata.chunk_count must be at least 1');
    }

    // Validate embedding model
    if (docMeta.embedding_model && typeof docMeta.embedding_model === 'string') {
      const supportedModels = ['gemini-embedding-001', 'text-embedding-004', 'models/text-embedding-004'];
      if (!supportedModels.includes(docMeta.embedding_model)) {
        warnings.push(`Unknown embedding model: ${docMeta.embedding_model}`);
      }
    }

    // Validate chunk_settings
    if (docMeta.chunk_settings) {
      const chunkSettingsValidation = this.validateChunkSettings(docMeta.chunk_settings);
      errors.push(...chunkSettingsValidation.errors);
      warnings.push(...chunkSettingsValidation.warnings);
    }

    return { errors, warnings };
  }

  private validateChunkSettings(chunkSettings: any): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof chunkSettings !== 'object') {
      errors.push('chunk_settings must be an object');
      return { errors, warnings };
    }

    if (chunkSettings.chunk_size !== undefined) {
      if (typeof chunkSettings.chunk_size !== 'number') {
        errors.push('chunk_settings.chunk_size must be a number');
      } else if (chunkSettings.chunk_size < 100 || chunkSettings.chunk_size > 8000) {
        warnings.push(`Unusual chunk_size: ${chunkSettings.chunk_size}. Expected range: 100-8000`);
      }
    }

    if (chunkSettings.chunk_overlap !== undefined) {
      if (typeof chunkSettings.chunk_overlap !== 'number') {
        errors.push('chunk_settings.chunk_overlap must be a number');
      } else if (chunkSettings.chunk_overlap < 0 || chunkSettings.chunk_overlap > 1000) {
        warnings.push(`Unusual chunk_overlap: ${chunkSettings.chunk_overlap}. Expected range: 0-1000`);
      }
    }

    return { errors, warnings };
  }

  private validateChunks(chunks: any, docMeta: any): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!chunks) {
      errors.push('Missing chunks array');
      return { errors, warnings };
    }

    if (!Array.isArray(chunks)) {
      errors.push('chunks must be an array');
      return { errors, warnings };
    }

    if (chunks.length === 0) {
      errors.push('chunks array cannot be empty');
      return { errors, warnings };
    }

    // Check chunk count matches metadata
    if (docMeta && docMeta.chunk_count && chunks.length !== docMeta.chunk_count) {
      warnings.push(`Chunk count mismatch: metadata says ${docMeta.chunk_count}, but found ${chunks.length} chunks`);
    }

    // Validate each chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunkValidation = this.validateChunk(chunks[i], i);
      errors.push(...chunkValidation.errors);
      warnings.push(...chunkValidation.warnings);
    }

    return { errors, warnings };
  }

  private validateChunk(chunk: any, index: number): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!chunk || typeof chunk !== 'object') {
      errors.push(`Chunk ${index} is not a valid object`);
      return { errors, warnings };
    }

    // Required fields
    const requiredFields = ['id', 'text', 'embedding', 'metadata'];
    for (const field of requiredFields) {
      if (chunk[field] === undefined || chunk[field] === null) {
        errors.push(`Chunk ${index}: Missing required field: ${field}`);
      }
    }

    // Validate id
    if (chunk.id && typeof chunk.id !== 'string') {
      errors.push(`Chunk ${index}: id must be a string`);
    }

    // Validate text
    if (chunk.text !== undefined) {
      if (typeof chunk.text !== 'string') {
        errors.push(`Chunk ${index}: text must be a string`);
      } else if (chunk.text.trim().length === 0) {
        warnings.push(`Chunk ${index}: text is empty or whitespace only`);
      } else if (chunk.text.length > 10000) {
        warnings.push(`Chunk ${index}: text is very long (${chunk.text.length} characters)`);
      }
    }

    // Validate embedding
    if (chunk.embedding !== undefined) {
      if (!Array.isArray(chunk.embedding)) {
        errors.push(`Chunk ${index}: embedding must be an array`);
      } else {
        // Check embedding dimensions
        if (chunk.embedding.length !== 768) {
          errors.push(`Chunk ${index}: embedding must have 768 dimensions, found ${chunk.embedding.length}`);
        }

        // Check for invalid values
        for (let j = 0; j < chunk.embedding.length; j++) {
          const val = chunk.embedding[j];
          if (typeof val !== 'number' || !isFinite(val)) {
            errors.push(`Chunk ${index}: embedding contains invalid value at index ${j}: ${val}`);
            break;
          }
        }
      }
    }

    // Validate metadata
    if (chunk.metadata !== undefined) {
      if (typeof chunk.metadata !== 'object') {
        errors.push(`Chunk ${index}: metadata must be an object`);
      } else {
        // Check for expected metadata fields
        if (chunk.metadata.page !== undefined && typeof chunk.metadata.page !== 'number') {
          errors.push(`Chunk ${index}: metadata.page must be a number`);
        }

        if (chunk.metadata.chunk_index !== undefined && typeof chunk.metadata.chunk_index !== 'number') {
          errors.push(`Chunk ${index}: metadata.chunk_index must be a number`);
        }

        if (chunk.metadata.source !== undefined && typeof chunk.metadata.source !== 'string') {
          errors.push(`Chunk ${index}: metadata.source must be a string`);
        }
      }
    }

    // Validate embedding_dimensions if present
    if (chunk.embedding_dimensions !== undefined) {
      if (typeof chunk.embedding_dimensions !== 'number') {
        errors.push(`Chunk ${index}: embedding_dimensions must be a number`);
      } else if (chunk.embedding && chunk.embedding.length !== chunk.embedding_dimensions) {
        errors.push(`Chunk ${index}: embedding_dimensions (${chunk.embedding_dimensions}) doesn't match actual embedding length (${chunk.embedding.length})`);
      }
    }

    return { errors, warnings };
  }

  private validateExportStats(exportStats: any): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typeof exportStats !== 'object') {
      errors.push('export_stats must be an object');
      return { errors, warnings };
    }

    // Common export stats fields (optional)
    const optionalFields = ['total_documents', 'total_chunks', 'total_tokens', 'processing_time_seconds'];
    for (const field of optionalFields) {
      if (exportStats[field] !== undefined && typeof exportStats[field] !== 'number') {
        errors.push(`export_stats.${field} must be a number`);
      }
    }

    return { errors, warnings };
  }
}

// Singleton instance
export const packageValidator = new PackageValidator();