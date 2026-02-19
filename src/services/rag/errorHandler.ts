import type { Document } from '@/types/document';
import type { PreprocessedPackage } from '@/types/preprocessed';
import type { EmbeddingGenerationProgress } from '@/types/embedding';

export interface IngestionError {
  code: string;
  message: string;
  details?: any;
  timestamp: Date;
  recoverable: boolean;
  suggestedAction?: string;
}

export interface ErrorHandlingResult {
  success: boolean;
  errors: IngestionError[];
  warnings: string[];
  recovered?: boolean;
  fallbackData?: any;
}

export interface ErrorContext {
  operation: 'package_validation' | 'document_processing' | 'embedding_generation' | 'metadata_extraction' | 'storage';
  documentId?: string;
  sessionId?: string;
  filename?: string;
  step?: string;
  data?: any;
}

export class IngestionErrorHandler {
  private errorHistory: Map<string, IngestionError[]> = new Map();

  /**
   * Handle package validation errors with detailed analysis
   */
  handlePackageValidationError(
    error: any,
    packageData: PreprocessedPackage,
    context: ErrorContext
  ): ErrorHandlingResult {
    const errors: IngestionError[] = [];
    const warnings: string[] = [];

    // Analyze the error type
    if (error instanceof SyntaxError) {
      errors.push({
        code: 'INVALID_JSON',
        message: 'Package contains invalid JSON format',
        details: { originalError: error.message },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Please check the JSON file format and try again'
      });
    } else if (error.message?.includes('format_version')) {
      errors.push({
        code: 'UNSUPPORTED_VERSION',
        message: `Unsupported package format version: ${packageData.format_version}`,
        details: { supportedVersions: ['1.0', '1.1'], providedVersion: packageData.format_version },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Please use a package with format version 1.0 or 1.1'
      });
    } else if (error.message?.includes('document_metadata')) {
      errors.push({
        code: 'MISSING_METADATA',
        message: 'Required document metadata is missing',
        details: { missingFields: this.extractMissingFields(error.message) },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Add missing metadata fields to the package'
      });
    } else {
      errors.push({
        code: 'VALIDATION_FAILED',
        message: `Package validation failed: ${error.message}`,
        details: { originalError: error.message, stack: error.stack },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Please check the package format and content'
      });
    }

    // Log errors for debugging
    this.logErrors(errors, context);

    return {
      success: false,
      errors,
      warnings
    };
  }

  /**
   * Handle document processing errors with recovery options
   */
  handleDocumentProcessingError(
    error: any,
    document: Document,
    context: ErrorContext
  ): ErrorHandlingResult {
    const errors: IngestionError[] = [];
    const warnings: string[] = [];
    let recovered = false;
    let fallbackData: any;

    // Analyze error type and provide recovery options
    if (error.message?.includes('file not found') || error.message?.includes('ENOENT')) {
      errors.push({
        code: 'FILE_NOT_FOUND',
        message: `Document file not found: ${document.filename}`,
        details: { originalPath: document.originalPath, storedPath: document.storedPath },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Please re-upload the document'
      });
    } else if (error.message?.includes('permission') || error.message?.includes('access')) {
      errors.push({
        code: 'ACCESS_DENIED',
        message: `Permission denied accessing document: ${document.filename}`,
        details: { originalError: error.message },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Check file permissions or try re-uploading'
      });
    } else if (error.message?.includes('memory') || error.message?.includes('heap')) {
      errors.push({
        code: 'MEMORY_LIMIT',
        message: 'Insufficient memory to process document',
        details: { fileSize: document.fileSize },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Try processing a smaller document or close other applications'
      });
      
      // Attempt recovery with smaller chunks
      fallbackData = {
        chunkSize: 500, // Reduce from default 1000
        chunkOverlap: 100
      };
      recovered = true;
    } else if (error.message?.includes('timeout')) {
      errors.push({
        code: 'PROCESSING_TIMEOUT',
        message: 'Document processing timed out',
        details: { timeout: error.timeout, documentSize: document.fileSize },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Try processing a smaller document or increase timeout'
      });
      
      fallbackData = {
        retryWithSmallerChunks: true
      };
      recovered = true;
    } else if (error.message?.includes('embedding')) {
      errors.push({
        code: 'EMBEDDING_GENERATION_FAILED',
        message: 'Failed to generate embeddings for document chunks',
        details: { originalError: error.message },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Check API key and network connection'
      });
      
      // Try to continue with partial embeddings
      fallbackData = {
        continueWithPartial: true,
        processedChunks: error.processedChunks || 0
      };
      recovered = true;
    } else {
      errors.push({
        code: 'PROCESSING_FAILED',
        message: `Document processing failed: ${error.message}`,
        details: { originalError: error.message, stack: error.stack },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Please check the document format and try again'
      });
    }

    // Log errors for debugging
    this.logErrors(errors, context);

    return {
      success: false,
      errors,
      warnings,
      recovered,
      fallbackData
    };
  }

  /**
   * Handle embedding generation errors with retry logic
   */
  handleEmbeddingError(
    error: any,
    chunkText: string,
    context: ErrorContext
  ): ErrorHandlingResult {
    const errors: IngestionError[] = [];
    const warnings: string[] = [];
    let recovered = false;
    let fallbackData: any;

    if (error.message?.includes('API key') || error.message?.includes('authentication')) {
      errors.push({
        code: 'API_KEY_INVALID',
        message: 'Invalid or missing API key for embedding service',
        details: { service: 'gemini' },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Please check your API key configuration'
      });
    } else if (error.message?.includes('quota') || error.message?.includes('rate limit')) {
      errors.push({
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'API rate limit exceeded',
        details: { retryAfter: error.retryAfter || '60 seconds' },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Wait and retry the request'
      });
      
      fallbackData = {
        retryDelay: error.retryAfter || 60000, // 60 seconds default
        exponentialBackoff: true
      };
      recovered = true;
    } else if (error.message?.includes('network') || error.message?.includes('connection')) {
      errors.push({
        code: 'NETWORK_ERROR',
        message: 'Network connection failed',
        details: { originalError: error.message },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Check internet connection and retry'
      });
      
      fallbackData = {
        maxRetries: 3,
        retryDelay: 5000 // 5 seconds
      };
      recovered = true;
    } else if (error.message?.includes('content') || error.message?.includes('text too long')) {
      errors.push({
        code: 'CONTENT_TOO_LONG',
        message: 'Text content exceeds maximum length for embedding',
        details: { textLength: chunkText.length },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Split the text into smaller chunks'
      });
      
      warnings.push('Text chunk is too long, will be split automatically');
      fallbackData = {
        splitChunk: true,
        maxLength: 8000 // Gemini has a limit
      };
      recovered = true;
    } else {
      errors.push({
        code: 'EMBEDDING_FAILED',
        message: `Embedding generation failed: ${error.message}`,
        details: { originalError: error.message, chunkLength: chunkText.length },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Check the content and try again'
      });
    }

    // Log errors for debugging
    this.logErrors(errors, context);

    return {
      success: false,
      errors,
      warnings,
      recovered,
      fallbackData
    };
  }

  /**
   * Handle storage errors with cleanup options
   */
  handleStorageError(
    error: any,
    operation: string,
    context: ErrorContext
  ): ErrorHandlingResult {
    const errors: IngestionError[] = [];
    const warnings: string[] = [];
    let recovered = false;
    let fallbackData: any;

    if (error.name === 'QuotaExceededError') {
      errors.push({
        code: 'STORAGE_QUOTA_EXCEEDED',
        message: 'Browser storage quota exceeded',
        details: { operation },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Clear old data or use a different browser'
      });
      
      fallbackData = {
        cleanupOldSessions: true,
        clearCache: true
      };
      recovered = true;
    } else if (error.name === 'InvalidStateError') {
      errors.push({
        code: 'DATABASE_CORRUPTED',
        message: 'Database is in an invalid state',
        details: { operation, originalError: error.message },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Clear browser data and reload the page'
      });
      
      fallbackData = {
        reinitializeDatabase: true
      };
      recovered = true;
    } else if (error.name === 'TransactionInactiveError') {
      errors.push({
        code: 'TRANSACTION_FAILED',
        message: 'Database transaction failed or was inactive',
        details: { operation },
        timestamp: new Date(),
        recoverable: true,
        suggestedAction: 'Retry the operation'
      });
      
      fallbackData = {
        retryTransaction: true,
        maxRetries: 3
      };
      recovered = true;
    } else {
      errors.push({
        code: 'STORAGE_ERROR',
        message: `Storage operation failed: ${error.message}`,
        details: { operation, originalError: error.message, stack: error.stack },
        timestamp: new Date(),
        recoverable: false,
        suggestedAction: 'Please refresh the page and try again'
      });
    }

    // Log errors for debugging
    this.logErrors(errors, context);

    return {
      success: false,
      errors,
      warnings,
      recovered,
      fallbackData
    };
  }

  /**
   * Create user-friendly error message
   */
  createUserFriendlyMessage(errors: IngestionError[]): string {
    if (errors.length === 0) {
      return 'An unknown error occurred';
    }

    const primaryError = errors[0];
    
    // Create user-friendly message based on error code
    switch (primaryError.code) {
      case 'INVALID_JSON':
        return 'The uploaded file is not a valid JSON package. Please check the file format.';
      
      case 'UNSUPPORTED_VERSION':
        return 'This package format is not supported. Please use a package with format version 1.0.';
      
      case 'MISSING_METADATA':
        return 'The package is missing required information. Please ensure all metadata is included.';
      
      case 'FILE_NOT_FOUND':
        return 'The document file could not be found. Please re-upload the document.';
      
      case 'ACCESS_DENIED':
        return 'Permission to access the document was denied. Please check file permissions.';
      
      case 'MEMORY_LIMIT':
        return 'The document is too large to process. Please try a smaller document.';
      
      case 'PROCESSING_TIMEOUT':
        return 'Document processing took too long. Please try a smaller document.';
      
      case 'API_KEY_INVALID':
        return 'There is a problem with the API configuration. Please check your settings.';
      
      case 'RATE_LIMIT_EXCEEDED':
        return 'Too many requests were made. Please wait a moment and try again.';
      
      case 'NETWORK_ERROR':
        return 'Network connection failed. Please check your internet connection.';
      
      case 'STORAGE_QUOTA_EXCEEDED':
        return 'Browser storage is full. Please clear old data to continue.';
      
      case 'DATABASE_CORRUPTED':
        return 'There is a problem with the local database. Please refresh the page.';
      
      default:
        return primaryError.suggestedAction || primaryError.message;
    }
  }

  /**
   * Extract missing fields from error message
   */
  private extractMissingFields(errorMessage: string): string[] {
    const missingFields: string[] = [];
    
    // Common field patterns
    const fieldPatterns = [
      /title/gi,
      /author/gi,
      /filename/gi,
      /file_size/gi,
      /page_count/gi,
      /chunk_count/gi,
      /embedding_model/gi
    ];
    
    fieldPatterns.forEach(pattern => {
      if (pattern.test(errorMessage)) {
        const fieldName = pattern.source.replace(/[\/\\gi]/g, '');
        missingFields.push(fieldName);
      }
    });
    
    return missingFields;
  }

  /**
   * Log errors for debugging
   */
  private logErrors(errors: IngestionError[], context: ErrorContext): void {
    const sessionKey = context.sessionId || 'global';
    
    if (!this.errorHistory.has(sessionKey)) {
      this.errorHistory.set(sessionKey, []);
    }
    
    const sessionErrors = this.errorHistory.get(sessionKey)!;
    sessionErrors.push(...errors);
    
    // Keep only last 50 errors per session
    if (sessionErrors.length > 50) {
      sessionErrors.splice(0, sessionErrors.length - 50);
    }
    
    // Log to console for debugging
    console.group(`🚨 Ingestion Error [${context.operation}]`);
    console.error('Context:', context);
    errors.forEach((error, index) => {
      console.error(`Error ${index + 1}:`, error);
    });
    console.groupEnd();
  }

  /**
   * Get error history for a session
   */
  getErrorHistory(sessionId?: string): IngestionError[] {
    const sessionKey = sessionId || 'global';
    return this.errorHistory.get(sessionKey) || [];
  }

  /**
   * Clear error history for a session
   */
  clearErrorHistory(sessionId?: string): void {
    const sessionKey = sessionId || 'global';
    this.errorHistory.delete(sessionKey);
  }

  /**
   * Get error statistics
   */
  getErrorStats(sessionId?: string): {
    totalErrors: number;
    errorsByCode: Record<string, number>;
    recoverableErrors: number;
    recentErrors: IngestionError[];
  } {
    const errors = this.getErrorHistory(sessionId);
    const errorsByCode: Record<string, number> = {};
    let recoverableErrors = 0;
    
    errors.forEach(error => {
      errorsByCode[error.code] = (errorsByCode[error.code] || 0) + 1;
      if (error.recoverable) {
        recoverableErrors++;
      }
    });
    
    return {
      totalErrors: errors.length,
      errorsByCode,
      recoverableErrors,
      recentErrors: errors.slice(-10) // Last 10 errors
    };
  }
}

// Singleton instance
export const ingestionErrorHandler = new IngestionErrorHandler();
