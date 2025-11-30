import { calculateVectorNorm } from '@/utils/vectorUtils';
import type { Document } from '@/types/document';
import type { EmbeddingChunk, EmbeddingGenerationProgress } from '@/types/embedding';
import type { PreprocessedPackage, PreprocessedChunk } from '@/types/preprocessed';
import { embeddingService } from '../gemini';
import { getIndexedDBServices } from '../indexedDB';
import { packageValidator } from './packageValidator';
import { metadataExtractor } from './metadataExtractor';
import { ingestionErrorHandler } from './errorHandler';
import { progressTracker, createDocumentIngestionOperation, type ProgressOperation } from './progressTracker';
import { useDocumentStore } from '@/store';

export class DocumentProcessor {
  private embeddingService = getIndexedDBServices().embeddingService;

  /**
   * Check if a document with the given filename already exists in the session
   * Returns the existing document if found, undefined otherwise
   */
  async checkForDuplicateByFilename(
    sessionId: string,
    filename: string,
    userId: string
  ): Promise<Document | undefined> {
    console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Checking for duplicate filename "${filename}" in session "${sessionId}"`);
    console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Timestamp: ${new Date().toISOString()}`);
    console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: User ID: ${userId}`);
    
    if (!sessionId || !filename || !userId) {
      console.log('🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Missing required parameters');
      return undefined;
    }

    try {
      const { documentService } = getIndexedDBServices();
      
      // Check for exact filename match
      console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Checking exact filename match`);
      let existingDoc = await documentService.getDocumentByFilename(sessionId, filename, userId);
      if (existingDoc) {
        console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Found exact filename match:`, {
          id: existingDoc.id,
          filename: existingDoc.filename,
          title: existingDoc.title,
          status: existingDoc.status
        });
        return existingDoc;
      }
      
      // Get all documents in the session for manual checking
      console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: No exact match found, checking all documents in session`);
      const allDocs = await documentService.getDocumentsBySession(sessionId, userId);
      console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Found ${allDocs.length} documents in session`);
      
      // Log all documents for debugging
      console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: All documents in session:`, allDocs.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        title: doc.title,
        status: doc.status,
        enabled: doc.enabled
      })));
      
      // Check for case-insensitive filename match
      console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Checking case-insensitive filename match`);
      const caseInsensitiveMatch = allDocs.find(doc =>
        doc.filename.toLowerCase() === filename.toLowerCase()
      );
      if (caseInsensitiveMatch) {
        console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Found case-insensitive filename match:`, {
          id: caseInsensitiveMatch.id,
          filename: caseInsensitiveMatch.filename,
          title: caseInsensitiveMatch.title,
          status: caseInsensitiveMatch.status
        });
        return caseInsensitiveMatch;
      }
      
      // Check for filename match against title (in case title was set to filename)
      console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Checking filename vs title match`);
      const titleMatch = allDocs.find(doc =>
        doc.title === filename || doc.title?.toLowerCase() === filename.toLowerCase()
      );
      if (titleMatch) {
        console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: Found title match:`, {
          id: titleMatch.id,
          filename: titleMatch.filename,
          title: titleMatch.title,
          status: titleMatch.status
        });
        return titleMatch;
      }
      
      console.log(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK: No duplicate found for filename "${filename}"`);
      return undefined;
    } catch (error) {
      console.error(`🔍 DOCUMENT PROCESSOR DUPLICATE CHECK ERROR: Error checking for duplicates:`, error);
      return undefined;
    }
  }

  async processDocument(
    document: Document,
    onProgress?: (progress: EmbeddingGenerationProgress) => void
  ): Promise<void> {
    try {
      // Check if document is already processed
      const existingEmbeddings = await this.embeddingService.getEmbeddingsByDocument(document.id);
      if (existingEmbeddings.length > 0) {
        return; // Already processed
      }

      // Read and parse document content
      const content = await this.readDocumentContent(document);

      // Extract metadata from content if not already present
      if (!document.title || !document.language) {
        onProgress?.({
          totalChunks: 0,
          processedChunks: 0,
          currentChunk: 'Extracting metadata...',
          isComplete: false,
        });

        const metadataResult = await metadataExtractor.extractFromContent(content, document.filename);

        if (metadataResult.success) {
          const documentService = getIndexedDBServices().documentService;
          const metadataUpdate = metadataExtractor.applyToDocument(document, metadataResult.metadata);
          // Get session to retrieve userId for ownership verification
          const sessionService = getIndexedDBServices().sessionService;
          const session = await sessionService.getSession(document.sessionId, document.userId);
          await documentService.updateDocument(document.id, metadataUpdate, session?.userId);

          // Update document object with new metadata
          Object.assign(document, metadataUpdate);

          // Log warnings
          if (metadataResult.warnings.length > 0) {
            console.warn('Content metadata extraction warnings:', metadataResult.warnings);
          }
        }
      }

      const chunks = await this.chunkDocument(content, document);

      // Update progress
      onProgress?.({
        totalChunks: chunks.length,
        processedChunks: 0,
        currentChunk: 'Starting processing...',
        isComplete: false,
      });

      // Generate embeddings for chunks
      const embeddingChunks: EmbeddingChunk[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        onProgress?.({
          totalChunks: chunks.length,
          processedChunks: i,
          currentChunk: chunk.text.substring(0, 50) + '...',
          isComplete: false,
        });

        try {
          const embedding = await embeddingService.generateEmbedding(chunk.text);

          const embeddingChunk: EmbeddingChunk = {
            id: chunk.id,
            documentId: document.id,
            sessionId: document.sessionId,
            chunkIndex: i,
            content: chunk.text,
            source: document.filename,
            page: chunk.metadata?.pageNumber,
            embedding,
            tokenCount: this.estimateTokenCount(chunk.text),
            embeddingNorm: 0, // Will be calculated in embeddingService
            metadata: {
              pageNumber: chunk.metadata?.pageNumber,
              pageNumbers: chunk.metadata?.pageNumbers || (chunk.metadata?.pageNumber ? [chunk.metadata.pageNumber] : undefined),
              chunkIndex: i,
              startPosition: chunk.metadata?.startPosition || 0,
              endPosition: chunk.metadata?.endPosition || chunk.text.length,
              tokenCount: this.estimateTokenCount(chunk.text),
              // Add document metadata to chunk for better search context
              documentTitle: document.title,
              documentAuthor: document.author,
              documentLanguage: document.language,
            },
            createdAt: new Date(),
          };

          embeddingChunks.push(embeddingChunk);
        } catch (error) {
          console.error(`Error processing chunk ${i}:`, error);
          // Continue with next chunk
        }
      }

      // Save embeddings to database with idempotent behavior
      await this.embeddingService.createEmbeddingsIdempotent(embeddingChunks.map(chunk => ({
        documentId: chunk.documentId,
        sessionId: chunk.sessionId,
        content: chunk.content,
        embedding: chunk.embedding,
        metadata: chunk.metadata
      })));

      // Update document status
      const documentService = getIndexedDBServices().documentService;
      // Get session to retrieve userId for ownership verification
      const sessionService = getIndexedDBServices().sessionService;
      const session = await sessionService.getSession(document.sessionId, document.userId);
      await documentService.updateDocument(document.id, {
        status: 'completed',
        processedAt: new Date(),
      }, session?.userId);

      // Update the document store to reflect the status change
      const documentStore = useDocumentStore.getState();
      await documentStore.loadDocuments(document.sessionId);

      // Final progress update
      onProgress?.({
        totalChunks: chunks.length,
        processedChunks: chunks.length,
        currentChunk: 'Processing complete',
        isComplete: true,
      });
    } catch (error) {
      console.error('Error processing document:', error);

      // CRITICAL FIX: Check if embeddings were actually saved before marking as failed
      let embeddingsWereSaved = false;
      try {
        const existingEmbeddings = await this.embeddingService.getEmbeddingsByDocument(document.id);
        embeddingsWereSaved = existingEmbeddings.length > 0;

        console.log('🔍 EMBEDDING VERIFICATION DEBUG (processDocument):', {
          documentId: document.id,
          embeddingsFound: existingEmbeddings.length,
          embeddingsWereSaved
        });
      } catch (verificationError) {
        console.error('Error verifying embeddings in processDocument:', verificationError);
      }

      // Only mark as failed if core processing (embedding generation and saving) actually failed
      if (!embeddingsWereSaved) {
        console.log('🔴 MARKING AS FAILED: No embeddings were saved, marking document as failed');
        const documentService = getIndexedDBServices().documentService;
        // Get session to retrieve userId for ownership verification
        const sessionService = getIndexedDBServices().sessionService;
        const session = await sessionService.getSession(document.sessionId, document.userId);
        await documentService.updateDocument(document.id, {
          status: 'failed',
          ingestError: error instanceof Error ? error.message : 'Unknown error',
        }, session?.userId);

        throw error;
      } else {
        console.log('✅ EMBEDDINGS SAVED: Core processing succeeded, keeping document as completed despite error');
        // Don't mark as failed if embeddings were saved - the core processing succeeded
        // Just log the error but don't change the status or throw
      }
    }
  }

  async processPreprocessedPackage(
    sessionId: string,
    packageData: PreprocessedPackage,
    userId: string,
    onProgress?: (progress: EmbeddingGenerationProgress) => void
  ): Promise<string> {
    console.log('🚀 DocumentProcessor: Starting preprocessed package processing');

    // Early validation of userId
    if (!userId) {
      const errorMsg = 'User ID is required for document processing';
      console.error('❌ DocumentProcessor: userId validation failed:', errorMsg);
      throw new Error(errorMsg);
    }

    console.log('📋 DocumentProcessor: Package info:', {
      sessionId,
      userId,
      formatVersion: packageData.format_version,
      documentId: packageData.document_metadata?.id,
      filename: packageData.document_metadata?.filename,
      chunksCount: packageData.chunks?.length || 0
    });

    // Create progress tracking operation
    const operation = createDocumentIngestionOperation({
      sessionId,
      documentId: packageData.document_metadata.id,
      fileName: packageData.document_metadata.filename,
      totalChunks: packageData.chunks.length
    });

    try {
      console.log('✅ DocumentProcessor: Starting progress tracking operation:', operation.id);
      // Start operation
      progressTracker.startOperation(operation.id);

      // Add validation step
      const validationStep = progressTracker.addStep(operation.id, {
        name: 'validation',
        description: 'Validating package format and contents',
      });

      progressTracker.startStep(operation.id, validationStep.id);

      // Validate package first
      onProgress?.({
        totalChunks: 0,
        processedChunks: 0,
        currentChunk: 'Validating package...',
        isComplete: false,
      });

      console.log('🔍 DocumentProcessor: Validating package structure...');
      const validation = await packageValidator.validatePackage(packageData);
      console.log('📊 DocumentProcessor: Validation result:', {
        isValid: validation.isValid,
        errorsCount: validation.errors.length,
        warningsCount: validation.warnings.length,
        errors: validation.errors,
        warnings: validation.warnings
      });

      if (!validation.isValid) {
        console.error('❌ DocumentProcessor: Package validation failed');
        progressTracker.failStep(operation.id, validationStep.id, validation.errors.join(', '));
        const validationErrorResult = ingestionErrorHandler.handlePackageValidationError(
          new Error(validation.errors.join(', ')),
          packageData,
          { operation: 'package_validation', sessionId, filename: packageData.document_metadata.filename }
        );

        const errorMessage = ingestionErrorHandler.createUserFriendlyMessage(validationErrorResult.errors);
        console.error('❌ DocumentProcessor: Validation error message:', errorMessage);
        progressTracker.failOperation(operation.id, errorMessage);
        throw new Error(errorMessage);
      }

      console.log('✅ DocumentProcessor: Package validation passed');
      progressTracker.completeStep(operation.id, validationStep.id, { warnings: validation.warnings });

      // Log warnings if any
      if (validation.warnings.length > 0) {
        console.warn('⚠️ DocumentProcessor: Package validation warnings:', validation.warnings);
      }

      // Add metadata extraction step
      const metadataStep = progressTracker.addStep(operation.id, {
        name: 'metadata_extraction',
        description: 'Extracting comprehensive metadata from document',
      });

      progressTracker.startStep(operation.id, metadataStep.id);

      // Extract comprehensive metadata
      onProgress?.({
        totalChunks: 0,
        processedChunks: 0,
        currentChunk: 'Extracting metadata...',
        isComplete: false,
      });

      let metadataResult;
      try {
        metadataResult = await metadataExtractor.extractFromPreprocessedPackage(packageData);

        if (!metadataResult.success) {
          const metadataErrorResult = ingestionErrorHandler.handleDocumentProcessingError(
            new Error(metadataResult.errors.join(', ')),
            { id: packageData.document_metadata.id, sessionId, filename: packageData.document_metadata.filename } as Document,
            { operation: 'metadata_extraction', sessionId, documentId: packageData.document_metadata.id }
          );

          // Continue with basic metadata if extraction fails
          console.warn('Metadata extraction failed, continuing with basic metadata:', metadataErrorResult.errors);
          progressTracker.completeStep(operation.id, metadataStep.id, {
            warnings: metadataErrorResult.errors,
            fallbackUsed: true
          });
        } else {
          // Log metadata warnings
          if (metadataResult.warnings.length > 0) {
            console.warn('Metadata extraction warnings:', metadataResult.warnings);
          }

          progressTracker.completeStep(operation.id, metadataStep.id, {
            warnings: metadataResult.warnings,
            metadata: metadataResult.metadata
          });
        }
      } catch (error) {
        const metadataErrorResult = ingestionErrorHandler.handleDocumentProcessingError(
          error,
          { id: packageData.document_metadata.id, sessionId, filename: packageData.document_metadata.filename } as Document,
          { operation: 'metadata_extraction', sessionId, documentId: packageData.document_metadata.id }
        );

        // Continue with basic metadata
        console.warn('Metadata extraction failed, continuing with basic metadata:', metadataErrorResult.errors);
        metadataResult = { success: false, metadata: {}, warnings: [], errors: [] };

        progressTracker.completeStep(operation.id, metadataStep.id, {
          warnings: metadataErrorResult.errors,
          fallbackUsed: true
        });
      }

      // Add document creation/update step
      const documentStep = progressTracker.addStep(operation.id, {
        name: 'document_creation',
        description: 'Creating or updating document record',
      });

      progressTracker.startStep(operation.id, documentStep.id);

      // Create or update document with extracted metadata
      const documentService = getIndexedDBServices().documentService;
      const packageDocId = packageData.document_metadata.id;

      console.log('🔍 DOCUMENT ID DEBUG: Package document ID:', packageDocId);
      console.log('🔍 SESSION ID DEBUG: Current session ID from URL:', sessionId);
      console.log('🔍 SESSION ID DEBUG: Session ID from package metadata:', packageData.export_metadata?.session_id);
      console.log('🔍 DUPLICATE DEBUG: Starting document creation process at:', new Date().toISOString());
      console.log('🔍 DUPLICATE DEBUG: About to check for existing documents in IndexedDB');

      // Always use the current session ID, not the one from package metadata
      // This ensures documents are associated with the current session
      const currentSessionId = sessionId;

      // Get session to retrieve userId for ownership verification
      const sessionService = getIndexedDBServices().sessionService;
      const session = await sessionService.getSession(currentSessionId, userId);

      // CRITICAL FIX: Check if document exists across ALL sessions, not just the current one
      let document = await documentService.getDocument(packageDocId, session?.userId);
      let actualDocId: string;
      let needsNewId = false;

      console.log('🔍 DOCUMENT ID DEBUG: Checking for existing document in current session:', !!document);
      console.log('🔍 DUPLICATE DEBUG: Document check result at:', new Date().toISOString(), {
        documentId: packageDocId,
        foundInCurrentSession: !!document,
        sessionId: sessionId,
        userId: session?.userId
      });

      // If document doesn't exist in current session, check if it exists in any session
      if (!document) {
        const existingDocAcrossSessions = await documentService.getDocumentAcrossAllSessions(packageDocId);
        console.log('🔍 DOCUMENT ID DEBUG: Checking for existing document across all sessions:', !!existingDocAcrossSessions);

        if (existingDocAcrossSessions) {
          console.log('🔍 DOCUMENT ID DEBUG: Document exists in another session:', {
            id: existingDocAcrossSessions.id,
            filename: existingDocAcrossSessions.filename,
            existingSessionId: existingDocAcrossSessions.sessionId,
            currentSessionId: currentSessionId
          });
          needsNewId = true;
        }
      }

      if (document) {
        console.log('🔍 DOCUMENT ID DEBUG: Existing document details:', {
          id: document.id,
          filename: document.filename,
          status: document.status,
          enabled: document.enabled,
          sessionId: document.sessionId
        });

        // CRITICAL FIX: Update existing document to ensure it's associated with the current session
        // This fixes the session ID mismatch issue
        const metadataUpdate = {
          ...metadataExtractor.applyToDocument(document, metadataResult.metadata),
          sessionId: currentSessionId // Force update to current session ID
        };

        console.log('🔍 SESSION ID DEBUG: Updating existing document with session ID:', currentSessionId);
        await documentService.updateDocument(packageDocId, metadataUpdate, session?.userId);
        actualDocId = packageDocId;
        console.log('🔍 DOCUMENT ID DEBUG: Updated existing document with ID:', actualDocId);
        progressTracker.updateStepProgress(operation.id, documentStep.id, 50, {
          action: 'updated_existing_document',
          sessionIdUpdated: document.sessionId !== currentSessionId
        });
      } else {
        // Generate a new ID if the document exists in another session to avoid conflicts
        const finalDocId = needsNewId ? crypto.randomUUID() : packageDocId;

        console.log('🔍 DOCUMENT ID DEBUG: Creating new document', {
          originalPackageId: packageDocId,
          needsNewId,
          finalDocId
        });

        // Create new document with extracted metadata
        // CRITICAL FIX: Always use the current session ID, not the one from package metadata
        const documentCreate = {
          id: finalDocId, // Use new ID if needed to avoid conflicts
          sessionId: currentSessionId, // Always use the current session ID
          filename: packageData.document_metadata.filename,
          fileSize: packageData.document_metadata.file_size,
          pageCount: packageData.document_metadata.page_count,
          title: metadataResult.metadata.title,
          author: metadataResult.metadata.author,
          language: metadataResult.metadata.language,
        };

        console.log('🔍 DOCUMENT ID DEBUG: Document create data:', documentCreate);
        console.log('🔍 SESSION ID DEBUG: Session ID in documentCreate:', currentSessionId);
        console.log('🔍 SESSION ID DEBUG: Session ID from packageData (ignored):', packageData.export_metadata?.session_id);

        // Get session to retrieve userId
        const sessionService = getIndexedDBServices().sessionService;
        const session = await sessionService.getSession(currentSessionId, userId);
        if (!session) {
          throw new Error(`Session not found: ${currentSessionId}`);
        }

        // CRITICAL FIX: Check for duplicates before creating document
        console.log('🔍 DUPLICATE PREVENTION: Checking for duplicates before document creation');
        const duplicateDoc = await this.checkForDuplicateByFilename(
          currentSessionId,
          packageData.document_metadata.filename,
          session.userId
        );
        
        if (duplicateDoc) {
          console.log('🔍 DUPLICATE PREVENTION: Found duplicate document, throwing error to prevent creation');
          const duplicateError = new Error(
            `Document "${packageData.document_metadata.filename}" already exists in this library. Skipping duplicate.`
          );
          // Mark as a special duplicate error that can be handled differently
          (duplicateError as any).isDuplicate = true;
          (duplicateError as any).duplicateDocumentId = duplicateDoc.id;
          throw duplicateError;
        }

        console.log('🔍 DUPLICATE PREVENTION: No duplicates found, proceeding with document creation');
        document = await documentService.createDocument(documentCreate, session.userId);

        console.log('🔍 DOCUMENT ID DEBUG: Created document with sessionId:', document.sessionId);
        console.log('🔍 DUPLICATE DEBUG: Document created in IndexedDB at:', new Date().toISOString());
        actualDocId = document.id;
        console.log('🔍 DOCUMENT ID DEBUG: Created new document with ID:', actualDocId);
        console.log('🔍 DOCUMENT ID DEBUG: Created document details:', {
          id: document.id,
          filename: document.filename,
          status: document.status,
          enabled: document.enabled,
          sessionId: document.sessionId,
          createdAt: document.createdAt
        });
        console.log('🔍 DUPLICATE DEBUG: Document now available for duplicate checking in IndexedDB');

        // Validate the document was created with the correct session ID
        if (document.sessionId !== currentSessionId) {
          console.error('🔴 SESSION ID MISMATCH: Document created with wrong session ID!', {
            expected: currentSessionId,
            actual: document.sessionId
          });
        } else {
          console.log('✅ SESSION ID VERIFIED: Document created with correct session ID');
        }

        progressTracker.updateStepProgress(operation.id, documentStep.id, 50, {
          action: needsNewId ? 'created_new_document_with_new_id' : 'created_new_document',
          sessionIdVerified: document.sessionId === currentSessionId,
          originalPackageId: packageDocId,
          newDocumentId: finalDocId,
          idGenerated: needsNewId
        });
      }

      progressTracker.completeStep(operation.id, documentStep.id, { documentId: actualDocId });

      // Add chunk processing step
      const chunkStep = progressTracker.addStep(operation.id, {
        name: 'chunk_processing',
        description: 'Processing document chunks and embeddings',
      });

      progressTracker.startStep(operation.id, chunkStep.id);

      // Get chunks directly from package (new format)
      const chunks: PreprocessedChunk[] = packageData.chunks;

      onProgress?.({
        totalChunks: chunks.length,
        processedChunks: 0,
        currentChunk: 'Starting import...',
        isComplete: false,
      });

      // Process chunks in batches to avoid memory pressure and blocking the main thread
      const BATCH_SIZE = 200;
      let processedCount = 0;
      const totalChunks = chunks.length;

      // Initial progress update
      onProgress?.({
        totalChunks,
        processedChunks: 0,
        currentChunk: 'Starting import...',
        isComplete: false,
      });

      for (let i = 0; i < totalChunks; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddingChunks: EmbeddingChunk[] = [];

        // Process batch
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const globalIndex = i + j;

          try {
            // CRITICAL FIX: Generate new chunk ID if we generated a new document ID to avoid conflicts
            const chunkId = needsNewId ? `chunk_${actualDocId}_${globalIndex}` : chunk.id;

            // Calculate norm directly to avoid overhead later
            const embeddingVector = new Float32Array(chunk.embedding);
            const norm = calculateVectorNorm(embeddingVector);

            // Convert preprocessed chunk to embedding chunk directly
            const embeddingChunk: EmbeddingChunk = {
              id: chunkId,
              documentId: actualDocId,
              sessionId,
              chunkIndex: chunk.metadata?.chunk_index || globalIndex,
              content: chunk.text,
              source: chunk.metadata?.source || packageData.document_metadata.filename,
              page: chunk.metadata?.page || 1,
              embedding: embeddingVector,
              tokenCount: this.estimateTokenCount(chunk.text),
              embeddingNorm: norm,
              metadata: {
                pageNumber: chunk.metadata?.page || 1,
                pageNumbers: chunk.metadata?.pageNumbers || (chunk.metadata?.page ? [chunk.metadata.page] : undefined),
                chunkIndex: chunk.metadata?.chunk_index || globalIndex,
                startPosition: 0,
                endPosition: chunk.text.length,
                tokenCount: this.estimateTokenCount(chunk.text),
                documentId: actualDocId,
                sessionId: sessionId,
                source: chunk.metadata?.source || packageData.document_metadata.filename,
                // Add extracted metadata to chunk metadata for better search context
                documentTitle: metadataResult.metadata.title,
                documentAuthor: metadataResult.metadata.author,
                documentLanguage: metadataResult.metadata.language,
                embeddingModel: metadataResult.metadata.embeddingModel,
                embeddingNorm: norm, // Include norm in metadata as well
              },
              createdAt: new Date(),
            };

            embeddingChunks.push(embeddingChunk);
          } catch (error) {
            console.error(`Error processing chunk ${globalIndex}:`, error);
          }
        }

        // Save batch directly to database
        if (embeddingChunks.length > 0) {
          // CRITICAL FIX: Ensure all embeddings use the correct session ID
          const validatedBatch = embeddingChunks.map(chunk => {
            if (chunk.sessionId !== sessionId) {
              return {
                ...chunk,
                sessionId: sessionId,
                metadata: { ...chunk.metadata, sessionId: sessionId }
              };
            }
            return chunk;
          });

          // Use direct insertion to skip redundant validation/mapping
          await this.embeddingService.addEmbeddingsDirectly(validatedBatch);
        }

        processedCount += batch.length;

        // Update progress (throttled naturally by batch size)
        onProgress?.({
          totalChunks,
          processedChunks: Math.min(processedCount, totalChunks),
          currentChunk: batch[0].text.substring(0, 50) + '...',
          isComplete: false,
        });

        const progressPercent = (processedCount / totalChunks) * 100;
        progressTracker.updateStepProgress(operation.id, chunkStep.id, progressPercent, {
          processedChunks: processedCount,
          totalChunks,
          currentChunkId: batch[batch.length - 1].id
        });

        // Yield to main thread to keep UI responsive
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      progressTracker.completeStep(operation.id, chunkStep.id, {
        totalChunks: totalChunks,
        processedChunks: processedCount,
        successfulChunks: processedCount // Assuming all processed chunks were successful
      });

      console.log('🔍 EMBEDDING STORAGE DEBUG: Embeddings saved successfully with correct session ID');

      // Update document status to completed
      try {
        console.log('🔍 DOCUMENT STATUS DEBUG: 🚀 Starting document status update to completed');
        console.log('🔍 DOCUMENT STATUS DEBUG: Document ID:', actualDocId);
        console.log('🔍 SESSION ID DEBUG: Session ID for document update:', sessionId);
        console.log('🔍 TIMESTAMP DEBUG: Status update started at:', new Date().toISOString());

        const timestamp = new Date();
        console.log('🔍 TIMESTAMP DEBUG: Status update started at:', timestamp.toISOString());

        // Verify document exists before update
        const docBeforeUpdate = await documentService.getDocument(actualDocId);
        console.log('🔍 DOCUMENT STATUS DEBUG: Document before update:', docBeforeUpdate);

        if (!docBeforeUpdate) {
          throw new Error(`Document not found before status update: ${actualDocId}`);
        }

        // Verify embeddings were actually saved
        const embeddingsCount = await this.embeddingService.getEmbeddingCountByDocument(actualDocId);
        console.log('🔍 EMBEDDING VERIFICATION DEBUG: Embeddings before status update:', {
          documentId: actualDocId,
          embeddingsCount,
          hasEmbeddings: embeddingsCount > 0
        });

        if (embeddingsCount === 0) {
          throw new Error(`No embeddings found for document ${actualDocId} after processing`);
        }

        console.log('✅ EMBEDDINGS VERIFIED: Updating document status to completed');

        await documentService.updateDocumentStatus(actualDocId, 'completed');
        console.log('🔍 DOCUMENT STATUS DEBUG: Document status updated in database');

        // Verify update
        const docAfterUpdate = await documentService.getDocument(actualDocId);
        console.log('🔍 DOCUMENT STATUS DEBUG: Document after update:', docAfterUpdate);

        if (docAfterUpdate?.sessionId !== sessionId) {
          console.error('🔴 SESSION ID MISMATCH after update:', {
            expected: sessionId,
            actual: docAfterUpdate?.sessionId
          });
          // Attempt to fix
          await documentService.updateDocument(actualDocId, { sessionId });
          console.log('✅ SESSION ID FIXED: Document updated with correct session ID');
        } else {
          console.log('✅ SESSION ID VERIFIED: Document updated with correct session ID');
        }

        // Force refresh of document store
        console.log('🔍 DOCUMENT STORE DEBUG: Refreshing document store after status update');
        console.log('🔍 SESSION ID DEBUG: Session ID for document store refresh:', sessionId);

        // Use the store's loadDocuments action to refresh the list
        // We need to access the store instance directly or dispatch an event
        // Since we can't use hooks here, we'll use the store's getState() method if available
        // or rely on the UI to refresh when it detects the change

        // Try to trigger a refresh via the store
        try {
          const store = useDocumentStore.getState();
          if (store && store.loadDocuments) {
            console.log('🔍 DOCUMENT STORE DEBUG: Starting loadDocuments for session:', sessionId);
            // Pass the userId if available from the session
            // We need to get the session first to get the userId
            const sessionService = getIndexedDBServices().sessionService;
            const session = await sessionService.getSession(sessionId);

            await store.loadDocuments(sessionId);
            console.log('🔍 DOCUMENT STORE DEBUG: Document store refreshed');

            // Verify store state
            const updatedDocs = store.documents;
            console.log('🔍 DOCUMENT STORE DEBUG: Documents in store after refresh:', updatedDocs.length);
          }
        } catch (storeError) {
          console.warn('⚠️ DOCUMENT STORE DEBUG: Failed to trigger store refresh:', storeError);
        }

        const endTime = new Date();
        console.log('🔍 TIMESTAMP DEBUG: Status update completed at:', endTime.toISOString());

      } catch (error) {
        console.error('🔴 DOCUMENT STATUS DEBUG: Error updating document status:', error);
        throw error;
      }

      onProgress?.({
        totalChunks: chunks.length,
        processedChunks: chunks.length,
        currentChunk: 'Import complete',
        isComplete: true,
      });

      // Complete operation
      progressTracker.completeOperation(operation.id, {
        documentId: actualDocId,
        totalChunks: chunks.length,
        processedChunks: processedCount,
        metadata: metadataResult.metadata
      });

      console.log('🎉 DocumentProcessor: Package processing completed successfully');
      return operation.id;
    } catch (error) {
      console.error('💥 DocumentProcessor: Error processing preprocessed package:', error);
      console.error('💥 DocumentProcessor: Error details:', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : 'No stack trace',
        sessionId,
        packageId: packageData.document_metadata?.id
      });

      // CRITICAL FIX: Check if embeddings were actually saved before marking as failed
      let embeddingsWereSaved = false;
      let actualDocumentId = packageData?.document_metadata?.id;

      if (packageData?.document_metadata?.id) {
        try {
          const embeddingService = getIndexedDBServices().embeddingService;
          const documentService = getIndexedDBServices().documentService;
          const sessionService = getIndexedDBServices().sessionService;
          const session = await sessionService.getSession(sessionId, userId);

          // Check if document exists in current session or across all sessions
          let document = await documentService.getDocument(packageData.document_metadata.id, session?.userId);
          if (!document) {
            document = await documentService.getDocumentAcrossAllSessions(packageData.document_metadata.id);
          }

          if (document) {
            actualDocumentId = document.id;
            // Check if embeddings exist for this document
            const existingEmbeddings = await embeddingService.getEmbeddingsByDocument(document.id);
            embeddingsWereSaved = existingEmbeddings.length > 0;

            console.log('🔍 EMBEDDING VERIFICATION DEBUG:', {
              documentId: document.id,
              embeddingsFound: existingEmbeddings.length,
              embeddingsWereSaved,
              documentStatus: document.status
            });
          }
        } catch (verificationError) {
          console.error('Error verifying embeddings:', verificationError);
        }
      }

      // Only mark as failed if core processing (embedding generation and saving) actually failed
      if (!embeddingsWereSaved && actualDocumentId) {
        console.log('🔴 MARKING AS FAILED: No embeddings were saved, marking document as failed');
        const documentService = getIndexedDBServices().documentService;
        try {
          // Get session to retrieve userId for ownership verification
          const sessionService = getIndexedDBServices().sessionService;
          const session = await sessionService.getSession(sessionId, userId);
          await documentService.updateDocument(actualDocumentId, {
            status: 'failed',
            ingestError: error instanceof Error ? error.message : 'Unknown error',
          }, session?.userId);
        } catch (updateError) {
          const updateErrorResult = ingestionErrorHandler.handleStorageError(
            updateError,
            'updateDocument',
            { operation: 'storage', sessionId, documentId: actualDocumentId }
          );

          console.error('Failed to update document status to failed:', updateErrorResult.errors);
        }
      } else if (embeddingsWereSaved) {
        console.log('✅ EMBEDDINGS SAVED: Core processing succeeded, keeping document as completed despite error');
        // Don't mark as failed if embeddings were saved - the core processing succeeded
        // Just log the error but don't change the status
      }

      // Handle the main error with user-friendly message
      const mainErrorResult = ingestionErrorHandler.handleDocumentProcessingError(
        error,
        { id: actualDocumentId, sessionId, filename: packageData.document_metadata.filename } as Document,
        { operation: 'document_processing', sessionId, documentId: actualDocumentId }
      );

      const errorMessage = ingestionErrorHandler.createUserFriendlyMessage(mainErrorResult.errors);
      progressTracker.failOperation(operation.id, errorMessage);

      // Only throw the error if core processing failed
      if (!embeddingsWereSaved) {
        throw new Error(errorMessage);
      } else {
        // If embeddings were saved, don't throw - the document is actually processed successfully
        console.log('🎉 CORE PROCESSING SUCCEEDED: Document processed successfully despite secondary error');
        return operation.id;
      }
    }
  }

  private async readDocumentContent(document: Document): Promise<string> {
    // This is a simplified implementation
    // In a real app, you'd need to handle different file types
    try {
      if (document.storedPath) {
        // For files stored in IndexedDB or local storage
        return await this.readFileFromStorage(document.storedPath);
      } else if (document.originalPath) {
        // For uploaded files
        return await this.readFileFromUpload(document.originalPath);
      } else {
        // Return empty string or throw error based on requirements
        return '';
      }
    } catch (error) {
      console.error('Error reading document content:', error);
      throw new Error('Failed to read document content');
    }
  }

  private async readFileFromStorage(path: string): Promise<string> {
    // Implementation depends on how files are stored
    // This is a placeholder
    return 'Document content placeholder';
  }

  private async readFileFromUpload(path: string): Promise<string> {
    // Implementation for uploaded files
    // This is a placeholder
    return 'Document content placeholder';
  }

  private async chunkDocument(
    content: string,
    document: Document
  ): Promise<Array<{ id: string; text: string; metadata?: any }>> {
    const chunkSize = 1000; // Default chunk size
    const chunkOverlap = 200; // Default overlap
    const chunks: Array<{ id: string; text: string; metadata?: any }> = [];

    let currentPosition = 0;
    let chunkIndex = 0;

    while (currentPosition < content.length) {
      const endPosition = Math.min(
        currentPosition + chunkSize,
        content.length
      );

      const chunkText = content.substring(currentPosition, endPosition);

      chunks.push({
        id: `chunk_${document.id}_${chunkIndex}`,
        text: chunkText,
        metadata: {
          pageNumber: 1, // TODO: Extract actual page numbers
          startPosition: currentPosition,
          endPosition,
          chunkIndex,
        },
      });

      currentPosition = endPosition - chunkOverlap;
      chunkIndex++;
    }

    return chunks;
  }

  private estimateTokenCount(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  async validateDocument(document: Document): Promise<boolean> {
    try {
      // Check if document exists and is accessible
      const content = await this.readDocumentContent(document);

      // Basic validation
      if (!content || content.trim().length === 0) {
        return false;
      }

      // Check for reasonable size
      if (content.length > 10_000_000) { // 10MB limit
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error validating document:', error);
      return false;
    }
  }

  async extractMetadata(content: string): Promise<any> {
    // Simple metadata extraction
    const lines = content.split('\n');
    const metadata: any = {};

    // Try to extract title from first few lines
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const line = lines[i].trim();
      if (line.length > 0 && line.length < 200) {
        metadata.title = line;
        break;
      }
    }

    // Extract word count
    metadata.wordCount = content.split(/\s+/).length;

    // Extract character count
    metadata.characterCount = content.length;

    // Estimate reading time (200 words per minute)
    metadata.readingTimeMinutes = Math.ceil(metadata.wordCount / 200);

    return metadata;
  }
}

// Singleton instance
export const documentProcessor = new DocumentProcessor();