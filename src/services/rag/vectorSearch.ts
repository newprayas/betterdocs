import type { EmbeddingChunk, VectorSearchResult } from '@/types/embedding';
import type { PageGroup } from '@/types/citation';
import { getIndexedDBServices } from '../indexedDB';
import { cosineSimilarity, calculateVectorNorm } from '@/utils/vectorUtils';
import { postProcessRetrievalResults } from './retrievalPostprocess';

export class VectorSearchService {
  private embeddingService = getIndexedDBServices().embeddingService;
  private documentService = getIndexedDBServices().documentService;

  async searchSimilar(
    queryEmbedding: Float32Array,
    sessionId: string,
    options: {
      maxResults?: number;
      similarityThreshold?: number;
      documentIds?: string[];
      allowedChunkIds?: string[];
      userId?: string;
      retrievalMode?: 'legacy_hybrid' | 'ann_rerank_v1';
      annCandidateMultiplier?: number;
    } = {}
  ): Promise<VectorSearchResult[]> {
    return new Promise((resolve, reject) => {
      const effectiveRetrievalMode = options.retrievalMode || 'ann_rerank_v1';
      // Initialize Worker
      const worker = new Worker(new URL('../../workers/vectorSearch.worker.ts', import.meta.url));

      worker.onmessage = (event) => {
        const { type, payload, error } = event.data;
        if (type === 'SEARCH_RESULT') {
          resolve(payload);
          worker.terminate(); // Clean up
        } else if (type === 'ERROR') {
          console.error('[VectorWorker] Error:', error);
          reject(new Error(error));
          worker.terminate();
        }
      };

      worker.onerror = (error) => {
        console.error('[VectorWorker] Unexpected error:', error);
        reject(error);
        worker.terminate();
      };

      // Send Request
      console.log(
        '🚀 [MAIN THREAD] Offloading search to Worker... mode=%s maxResults=%s annMultiplier=%s docsFilter=%d chunkFilter=%d',
        effectiveRetrievalMode,
        options.maxResults ?? 'default',
        options.annCandidateMultiplier ?? 'default',
        options.documentIds?.length || 0,
        options.allowedChunkIds?.length || 0
      );
      worker.postMessage({
        type: 'SEARCH',
        payload: {
          queryEmbedding,
          sessionId,
          options: {
            ...options,
            retrievalMode: effectiveRetrievalMode,
          }
        }
      });
    });
  }

  private async getEmbeddingsByDocumentIds(documentIds: string[]): Promise<EmbeddingChunk[]> {
    const embeddings: EmbeddingChunk[] = [];

    for (const documentId of documentIds) {
      const documentEmbeddings = await this.embeddingService.getEmbeddingsByDocument(documentId);
      embeddings.push(...documentEmbeddings);
    }

    return embeddings;
  }

  private async getDocumentInfo(documentId: string, userId?: string) {
    const documentService = getIndexedDBServices().documentService;
    return await documentService.getDocument(documentId, userId);
  }

  /**
   * Batch fetch all relevant documents to eliminate N+1 query pattern
   * Creates a Map for O(1) document lookups during similarity calculations
   */
  private async batchFetchDocuments(
    embeddings: EmbeddingChunk[],
    documentIds?: string[],
    sessionId?: string,
    userId?: string
  ): Promise<Map<string, any>> {
    // Collect all unique document IDs from embeddings
    const uniqueDocumentIds = new Set<string>();

    // Add document IDs from embeddings
    embeddings.forEach(embedding => {
      uniqueDocumentIds.add(embedding.documentId);
    });

    // Add specific document IDs if provided
    if (documentIds) {
      documentIds.forEach(id => uniqueDocumentIds.add(id));
    }

    // If no specific document IDs and we have a sessionId, get all enabled documents
    if (uniqueDocumentIds.size === 0 && sessionId) {
      const enabledDocuments = await this.documentService.getEnabledDocumentsBySession(sessionId, userId || '');
      enabledDocuments.forEach(doc => uniqueDocumentIds.add(doc.id));
    }

    // Fetch all documents in batch
    const documentPromises = Array.from(uniqueDocumentIds).map(async (docId) => {
      const document = await this.documentService.getDocument(docId, userId);
      return document ? [docId, document] as [string, any] : null;
    });

    const documentEntries = await Promise.all(documentPromises);

    // Create Map for O(1) lookups
    const documentMap = new Map<string, any>();
    documentEntries.forEach(entry => {
      if (entry) {
        documentMap.set(entry[0], entry[1]);
      }
    });

    return documentMap;
  }

  /**
   * Combine chunks from the same page instead of discarding them
   * This ensures all information from a page is available to the LLM
   * while maintaining clean citation display
   */
  private deduplicateByPage(results: VectorSearchResult[]): VectorSearchResult[] {
    return this.combineChunksByPage(results);
  }

  /**
   * Combine chunks from the same page while preserving all information
   * Creates a single combined chunk with all content from the same page
   */
  private combineChunksByPage(results: VectorSearchResult[]): VectorSearchResult[] {
    console.log('\n=== CHUNK COMBINATION DEBUG START ===');
    console.log('[COMBINE INPUT]', `Processing ${results.length} chunks for combination`);

    const pageMap = new Map<string, VectorSearchResult[]>();

    // Group chunks by document and page
    for (const result of results) {
      const pageNumber = this.getEffectivePageNumber(result);
      const pageKey = `${result.document.id}_${pageNumber || 'unknown'}`;

      /* console.log('[CHUNK ANALYSIS]', {
        chunkId: result.chunk.id,
        documentId: result.document.id,
        documentTitle: result.document.title,
        similarity: result.similarity,
        pageField: result.chunk.page,
        metadataPageNumber: result.chunk.metadata?.pageNumber,
        effectivePageNumber: pageNumber,
        pageKey,
        contentPreview: result.chunk.content.substring(0, 100) + '...'
      }); */

      if (!pageMap.has(pageKey)) {
        pageMap.set(pageKey, []);
      }
      pageMap.get(pageKey)!.push(result);
    }

    console.log('[PAGE GROUPING]', `Created ${pageMap.size} page groups:`);
    for (const [pageKey, chunks] of pageMap) {
      console.log('[PAGE GROUP]', {
        pageKey,
        chunkCount: chunks.length,
        chunks: chunks.map(c => ({
          id: c.chunk.id,
          similarity: c.similarity,
          page: this.getEffectivePageNumber(c),
          allPageNumbers: this.getAllPageNumbers(c)
        }))
      });
    }

    // Combine chunks for each page
    const combinedResults: VectorSearchResult[] = [];
    for (const [pageKey, chunks] of pageMap) {
      if (chunks.length === 1) {
        console.log('[SINGLE CHUNK]', `No combination needed for ${pageKey}`);
        combinedResults.push(chunks[0]);
      } else {
        console.log('[MULTI CHUNK]', `Combining ${chunks.length} chunks for ${pageKey}`);
        combinedResults.push(this.createCombinedChunk(chunks));
      }
    }

    console.log('[COMBINATION RESULT]', `Combined into ${combinedResults.length} chunks`);
    for (const result of combinedResults) {
      console.log('[FINAL CHUNK]', {
        id: result.chunk.id,
        documentTitle: result.document.title,
        similarity: result.similarity,
        finalPage: this.getEffectivePageNumber(result),
        allPages: this.getAllPageNumbers(result),
        isCombined: result.chunk.metadata?.isCombined,
        originalChunkCount: result.chunk.metadata?.originalChunkCount,
        pageNumbers: result.chunk.metadata?.pageNumbers,
        contentPreview: result.chunk.content.substring(0, 100) + '...'
      });
    }
    console.log('=== CHUNK COMBINATION DEBUG END ===\n');

    return combinedResults;
  }

  /**
   * Create a combined chunk from multiple chunks on the same page
   * Preserves the highest similarity score and combines all content
   */
  private createCombinedChunk(chunks: VectorSearchResult[]): VectorSearchResult {
    console.log('\n=== CREATE COMBINED CHUNK DEBUG START ===');
    console.log('[COMBINE INPUT]', `Combining ${chunks.length} chunks`);

    // Sort by similarity to find the highest scoring chunk
    const sortedChunks = [...chunks].sort((a, b) => b.similarity - a.similarity);
    const highestScoringChunk = sortedChunks[0];

    console.log('[SIMILARITY RANKING]', 'Chunks sorted by similarity:');
    /* sortedChunks.forEach((chunk, index) => {
      console.log(`[RANK ${index + 1}]`, {
        chunkId: chunk.chunk.id,
        similarity: chunk.similarity,
        pageField: chunk.chunk.page,
        metadataPageNumber: chunk.chunk.metadata?.pageNumber,
        effectivePage: this.getEffectivePageNumber(chunk),
        contentPreview: chunk.chunk.content.substring(0, 80) + '...'
      });
    }); */

    console.log('[HIGHEST SCORING]', {
      chunkId: highestScoringChunk.chunk.id,
      similarity: highestScoringChunk.similarity,
      pageField: highestScoringChunk.chunk.page,
      metadataPageNumber: highestScoringChunk.chunk.metadata?.pageNumber,
      effectivePage: this.getEffectivePageNumber(highestScoringChunk),
      selectedAsBase: true
    });

    // Collect all unique page numbers from the chunks
    const allPageNumbers = new Set<number>();
    chunks.forEach(chunk => {
      const effectivePage = this.getEffectivePageNumber(chunk);
      if (effectivePage !== undefined) {
        allPageNumbers.add(effectivePage);
      }
    });

    const sortedPageNumbers = Array.from(allPageNumbers).sort((a, b) => a - b);
    console.log('[PAGE COLLECTION]', {
      allUniquePages: sortedPageNumbers,
      pageCount: sortedPageNumbers.length,
      pageRange: sortedPageNumbers.length > 1 ? `${sortedPageNumbers[0]}-${sortedPageNumbers[sortedPageNumbers.length - 1]}` : `${sortedPageNumbers[0]}`
    });

    // Combine content from all chunks with clear separators
    const combinedContent = chunks
      .sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex) // Maintain original order
      .map(chunk => chunk.chunk.content)
      .join('\n---\n');

    // Create combined chunk IDs for reference
    const combinedChunkIds = chunks.map(c => c.chunk.id);

    // Create a new combined chunk with all page numbers preserved
    const combinedChunk: EmbeddingChunk = {
      ...highestScoringChunk.chunk,
      id: `combined_${highestScoringChunk.chunk.id}`, // New ID for combined chunk
      content: combinedContent,
      metadata: {
        ...highestScoringChunk.chunk.metadata,
        pageNumbers: sortedPageNumbers, // Store all page numbers
        combinedChunkIds, // Store original chunk IDs for reference
        isCombined: true,
        originalChunkCount: chunks.length,
      },
    };

    console.log('[COMBINED CHUNK CREATED]', {
      newId: combinedChunk.id,
      inheritedPage: combinedChunk.page,
      inheritedMetadataPage: combinedChunk.metadata?.pageNumber,
      storedPageNumbers: combinedChunk.metadata?.pageNumbers,
      isCombined: combinedChunk.metadata?.isCombined,
      originalChunkCount: combinedChunk.metadata?.originalChunkCount,
      allOriginalPages: chunks.map(c => this.getEffectivePageNumber(c)),
      uniquePagesPreserved: sortedPageNumbers,
      contentLength: combinedContent.length
    });
    console.log('=== CREATE COMBINED CHUNK DEBUG END ===\n');

    // Return the combined result with highest similarity
    return {
      chunk: combinedChunk,
      similarity: highestScoringChunk.similarity,
      document: highestScoringChunk.document,
    };
  }

  /**
   * Get effective page number with proper priority handling
   * For combined chunks, returns the first page number from the pageNumbers array
   * Priority: 1. metadata.pageNumbers (for combined chunks), 2. chunk.page (direct field), 3. metadata.pageNumber, 4. content extraction
   */
  private getEffectivePageNumber(result: VectorSearchResult): number | undefined {
    // Priority 1: For combined chunks, use the first page number from pageNumbers array
    if (result.chunk.metadata?.pageNumbers && result.chunk.metadata.pageNumbers.length > 0) {
      console.log('[EFFECTIVE PAGE]', `Using first page from pageNumbers array: ${result.chunk.metadata.pageNumbers[0]} for combined chunk`);
      return result.chunk.metadata.pageNumbers[0];
    }

    // Priority 2: Direct page field from chunk
    if (result.chunk.page && result.chunk.page > 0) {
      return result.chunk.page;
    }

    // Priority 3: Metadata pageNumber
    if (result.chunk.metadata?.pageNumber && result.chunk.metadata.pageNumber > 0) {
      return result.chunk.metadata.pageNumber;
    }

    // Priority 4: Try to extract from content (similar to citation service)
    const content = result.chunk.content;
    const pagePatterns = [
      /page\s+(\d+)/i,
      /p\.?\s*(\d+)/i,
      /第(\d+)页/,
      /page\s+(\d+)\s+of/i,
    ];

    for (const pattern of pagePatterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        const extractedPage = parseInt(match[1], 10);
        if (extractedPage > 0) {
          return extractedPage;
        }
      }
    }

    return undefined;
  }

  /**
   * Get all page numbers from a chunk (for combined chunks)
   * Returns an array of page numbers or undefined if no pages found
   */
  private getAllPageNumbers(result: VectorSearchResult): number[] | undefined {
    // For combined chunks, return the pageNumbers array
    if (result.chunk.metadata?.pageNumbers && result.chunk.metadata.pageNumbers.length > 0) {
      return result.chunk.metadata.pageNumbers;
    }

    // For single chunks, try to get the effective page number
    const effectivePage = this.getEffectivePageNumber(result);
    if (effectivePage !== undefined) {
      return [effectivePage];
    }

    return undefined;
  }

  async searchHybrid(
    queryEmbedding: Float32Array,
    sessionId: string,
    queryText: string,
    options: {
      maxResults?: number;
      similarityThreshold?: number;
      textWeight?: number;
      vectorWeight?: number;
      documentIds?: string[];
      allowedChunkIds?: string[];
      userId?: string;
      retrievalMode?: 'legacy_hybrid' | 'ann_rerank_v1';
    } = {}
  ): Promise<VectorSearchResult[]> {
    try {
      const {
        maxResults = 12,
        similarityThreshold = 0.7,
        textWeight = 0.3,
        vectorWeight = 0.7
      } = options;
      const retrievalMode = options.retrievalMode || 'ann_rerank_v1';
      const vectorSearchLimit = retrievalMode === 'ann_rerank_v1'
        ? Math.max(maxResults * 2, 40)
        : maxResults * 2;

      // Get vector search results
      const vectorResults = await this.searchSimilar(queryEmbedding, sessionId, {
        maxResults: vectorSearchLimit,
        similarityThreshold: similarityThreshold * 0.8, // Lower threshold for hybrid
        documentIds: options.documentIds,
        allowedChunkIds: options.allowedChunkIds,
        retrievalMode
      });

      // In ANN mode, rerank only top vector candidates to avoid full second pass.
      const textResults = retrievalMode === 'ann_rerank_v1'
        ? this.textRerankCandidates(vectorResults, queryText, Math.min(40, vectorResults.length))
        : await this.textSearch(
            queryText,
            sessionId,
            vectorSearchLimit,
            options.userId,
            options.documentIds,
            options.allowedChunkIds
          );
      console.log(
        '[RETRIEVAL HYBRID] mode=%s vectorResults=%d textResults=%d',
        retrievalMode,
        vectorResults.length,
        textResults.length
      );

      // Combine and score results
      const combinedResults = new Map<string, VectorSearchResult>();

      // Add vector results
      vectorResults.forEach(result => {
        const key = result.chunk.id;
        combinedResults.set(key, {
          ...result,
          similarity: result.similarity * vectorWeight,
        });
      });

      // Add text results
      textResults.forEach(result => {
        const key = result.chunk.id;
        const existing = combinedResults.get(key);

        if (existing) {
          // Combine scores
          existing.similarity = Math.min(1, existing.similarity + result.similarity * textWeight);
        } else {
          combinedResults.set(key, {
            ...result,
            similarity: result.similarity * textWeight,
          });
        }
      });

      // Sort and return top results
      const rankedResults = Array.from(combinedResults.values())
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, maxResults);

      const postProcessed = postProcessRetrievalResults(rankedResults, { maxResults });
      console.log('[RETRIEVAL POSTPROCESS][HYBRID]', postProcessed.telemetry);
      return postProcessed.results;
    } catch (error) {
      console.error('Error in hybrid search:', error);
      throw new Error('Failed to perform hybrid search');
    }
  }

  private async textSearch(
    query: string,
    sessionId: string,
    maxResults: number,
    userId?: string,
    documentIds?: string[],
    allowedChunkIds?: string[]
  ): Promise<VectorSearchResult[]> {
    try {
      const embeddings = documentIds && documentIds.length > 0
        ? await this.getEmbeddingsByDocumentIds(documentIds)
        : await this.embeddingService.getEnabledEmbeddingsBySession(sessionId, userId);
      const queryLower = query.toLowerCase();
      const allowedChunkSet = allowedChunkIds && allowedChunkIds.length > 0
        ? new Set(allowedChunkIds)
        : null;

      // Batch fetch all relevant documents to eliminate N+1 queries
      const documentMap = await this.batchFetchDocuments(embeddings, documentIds, sessionId, userId);

      const results: VectorSearchResult[] = [];
      const allowedDocumentIdSet = documentIds && documentIds.length > 0 ? new Set(documentIds) : null;

      for (const embedding of embeddings) {
        if (allowedDocumentIdSet && !allowedDocumentIdSet.has(embedding.documentId)) {
          continue;
        }
        if (allowedChunkSet && !allowedChunkSet.has(embedding.id)) {
          continue;
        }

        const contentLower = embedding.content.toLowerCase();

        // Advanced text scoring
        const score = this.calculateTextScore(queryLower, contentLower);

        if (score > 0) {
          // Get document info from the pre-fetched map (O(1) lookup instead of database call)
          const document = documentMap.get(embedding.documentId);

          if (document) {
            results.push({
              chunk: embedding,
              similarity: score,
              document: {
                id: document.id,
                title: document.title || document.filename,
                fileName: document.filename,
              },
            });
          }
        }
      }

      return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, maxResults);
    } catch (error) {
      console.error('Error in text search:', error);
      return [];
    }
  }

  private textRerankCandidates(
    candidates: VectorSearchResult[],
    query: string,
    maxResults: number
  ): VectorSearchResult[] {
    const queryLower = query.toLowerCase();
    const reranked = candidates
      .map((candidate) => {
        const contentLower = candidate.chunk.content.toLowerCase();
        const textScore = this.calculateTextScore(queryLower, contentLower);
        return {
          ...candidate,
          similarity: Math.min(1, candidate.similarity + (textScore * 0.3))
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, maxResults);
    console.log(
      '[RERANK] ANN candidate-only rerank active: input=%d window=%d cap=40 output=%d',
      candidates.length,
      maxResults,
      reranked.length
    );
    return reranked;
  }

  /**
   * Calculate advanced text similarity score
   */
  private calculateTextScore(query: string, content: string): number {
    const queryWords = query.split(/\s+/).filter(word => word.length > 2); // Filter out very short words
    const contentWords = content.split(/\s+/);

    let score = 0;
    let exactPhraseMatches = 0;
    let partialMatches = 0;
    let wordProximityScore = 0;

    // Exact phrase matching (highest weight)
    if (content.includes(query)) {
      exactPhraseMatches += 1;
      score += 2.0;
    }

    // Individual word matching with proximity consideration
    for (let i = 0; i < queryWords.length; i++) {
      const queryWord = queryWords[i];

      // Find all positions of this word in content
      const positions: number[] = [];
      for (let j = 0; j < contentWords.length; j++) {
        if (contentWords[j].includes(queryWord)) {
          positions.push(j);
        }
      }

      if (positions.length > 0) {
        partialMatches += 1;
        score += 0.5;

        // Bonus for word appearing multiple times
        if (positions.length > 1) {
          score += 0.2 * Math.min(positions.length - 1, 3);
        }

        // Proximity bonus for consecutive words
        if (i < queryWords.length - 1) {
          const nextQueryWord = queryWords[i + 1];
          for (const pos of positions) {
            if (pos + 1 < contentWords.length &&
              contentWords[pos + 1].includes(nextQueryWord)) {
              wordProximityScore += 0.3;
            }
          }
        }
      }
    }

    // Normalize scores
    const wordMatchRatio = partialMatches / queryWords.length;
    const normalizedScore = Math.min(1.0, score / queryWords.length);

    // Combine different scoring factors
    return Math.min(1.0, normalizedScore * 0.6 + wordProximityScore * 0.3 + wordMatchRatio * 0.1);
  }

  /**
   * Enhanced hybrid search with dynamic weighting
   */
  async searchHybridEnhanced(
    queryEmbedding: Float32Array,
    sessionId: string,
    queryText: string,
    options: {
      maxResults?: number;
      similarityThreshold?: number;
      textWeight?: number;
      vectorWeight?: number;
      useDynamicWeighting?: boolean;
      documentIds?: string[];
      allowedChunkIds?: string[];
      userId?: string;
      retrievalMode?: 'legacy_hybrid' | 'ann_rerank_v1';
      annCandidateMultiplier?: number;
    } = {}
  ): Promise<VectorSearchResult[]> {
    try {
      const {
        maxResults = 12,
        similarityThreshold = 0.7,
        textWeight = 0.3,
        vectorWeight = 0.7,
        useDynamicWeighting = true,
        retrievalMode = 'ann_rerank_v1',
        annCandidateMultiplier = 12
      } = options;
      const vectorSearchLimit = retrievalMode === 'ann_rerank_v1'
        ? Math.max(maxResults * 2, 40)
        : maxResults * 2;

      // Get vector search results
      const vectorResults = await this.searchSimilar(queryEmbedding, sessionId, {
        maxResults: vectorSearchLimit,
        similarityThreshold: similarityThreshold * 0.8,
        documentIds: options.documentIds,
        allowedChunkIds: options.allowedChunkIds,
        retrievalMode,
        annCandidateMultiplier
      });

      // In ANN mode, rerank only the vector candidates to avoid a full second pass.
      const textResults = retrievalMode === 'ann_rerank_v1'
        ? this.textRerankCandidates(vectorResults, queryText, Math.min(40, vectorResults.length))
        : await this.textSearch(
            queryText,
            sessionId,
            vectorSearchLimit,
            options.userId,
            options.documentIds,
            options.allowedChunkIds
          );
      console.log(
        '[RETRIEVAL HYBRID ENHANCED] mode=%s vectorResults=%d textResults=%d',
        retrievalMode,
        vectorResults.length,
        textResults.length
      );

      // Dynamic weighting based on query characteristics
      let finalTextWeight = textWeight;
      let finalVectorWeight = vectorWeight;

      if (useDynamicWeighting) {
        const queryAnalysis = this.analyzeQuery(queryText);

        // Adjust weights based on query type
        if (queryAnalysis.isSpecificQuery) {
          finalVectorWeight = Math.min(0.9, vectorWeight + 0.2);
          finalTextWeight = Math.max(0.1, textWeight - 0.2);
        } else if (queryAnalysis.isBroadQuery) {
          finalTextWeight = Math.min(0.6, textWeight + 0.2);
          finalVectorWeight = Math.max(0.4, vectorWeight - 0.2);
        }
      }

      // Combine and score results using reciprocal rank fusion
      const combinedResults = this.reciprocalRankFusion(
        vectorResults,
        textResults,
        finalVectorWeight,
        finalTextWeight
      );
      const postProcessed = postProcessRetrievalResults(combinedResults, { maxResults });
      console.log('[RETRIEVAL POSTPROCESS][HYBRID_ENHANCED]', postProcessed.telemetry);
      return postProcessed.results;
    } catch (error) {
      console.error('Error in enhanced hybrid search:', error);
      throw new Error('Failed to perform enhanced hybrid search');
    }
  }

  /**
   * Analyze query characteristics for dynamic weighting
   */
  private analyzeQuery(query: string): {
    isSpecificQuery: boolean;
    isBroadQuery: boolean;
    wordCount: number;
    hasQuotes: boolean;
  } {
    const words = query.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const hasQuotes = query.includes('"') || query.includes("'");

    // Specific query indicators
    const specificIndicators = [
      /\b\d+\b/, // Numbers
      /\b[A-Z]{2,}\b/, // Acronyms
      /\b\w*@\w*\.\w+\b/, // Emails
      /\bhttps?:\/\/\S+\b/, // URLs
    ];

    const isSpecificQuery = hasQuotes ||
      wordCount <= 3 ||
      specificIndicators.some(pattern => pattern.test(query));

    // Broad query indicators
    const broadWords = ['what', 'how', 'why', 'when', 'where', 'explain', 'describe', 'tell me'];
    const isBroadQuery = wordCount > 5 ||
      broadWords.some(word => query.toLowerCase().includes(word));

    return {
      isSpecificQuery,
      isBroadQuery,
      wordCount,
      hasQuotes,
    };
  }

  /**
   * Reciprocal Rank Fusion for combining search results
   */
  private reciprocalRankFusion(
    vectorResults: VectorSearchResult[],
    textResults: VectorSearchResult[],
    vectorWeight: number,
    textWeight: number
  ): VectorSearchResult[] {
    const k = 60; // Fusion parameter (typically 60)
    const resultScores = new Map<string, { result: VectorSearchResult; score: number }>();

    // Process vector results
    vectorResults.forEach((result, index) => {
      const key = result.chunk.id;
      const rrScore = 1 / (k + index + 1);
      const existingScore = resultScores.get(key);

      if (existingScore) {
        existingScore.score += rrScore * vectorWeight;
      } else {
        resultScores.set(key, {
          result: { ...result, similarity: result.similarity * vectorWeight },
          score: rrScore * vectorWeight,
        });
      }
    });

    // Process text results
    textResults.forEach((result, index) => {
      const key = result.chunk.id;
      const rrScore = 1 / (k + index + 1);
      const existingScore = resultScores.get(key);

      if (existingScore) {
        existingScore.score += rrScore * textWeight;
        // Update the result with combined similarity
        existingScore.result.similarity = Math.min(1,
          existingScore.result.similarity + result.similarity * textWeight);
      } else {
        resultScores.set(key, {
          result: { ...result, similarity: result.similarity * textWeight },
          score: rrScore * textWeight,
        });
      }
    });

    // Sort by combined score and return results
    return Array.from(resultScores.values())
      .sort((a, b) => b.score - a.score)
      .map(item => item.result);
  }

  async findSimilarChunks(
    targetChunk: EmbeddingChunk,
    maxResults: number = 12,
    userId?: string
  ): Promise<VectorSearchResult[]> {
    try {
      // First check if the document is enabled before finding similar chunks
      const document = await this.getDocumentInfo(targetChunk.documentId, userId);
      if (!document || !document.enabled) {
        return [];
      }

      const embeddings = await this.embeddingService.getEmbeddingsByDocument(targetChunk.documentId);

      // Batch fetch all documents for these embeddings to eliminate N+1 queries
      const documentMap = await this.batchFetchDocuments(embeddings, [targetChunk.documentId], undefined, userId);

      const results: VectorSearchResult[] = [];

      for (const embedding of embeddings) {
        if (embedding.id === targetChunk.id) {
          continue; // Skip the target chunk itself
        }

        const similarity = cosineSimilarity(targetChunk.embedding, embedding.embedding);

        if (similarity > 0.5) { // Threshold for similarity
          // Get document info from the pre-fetched map (O(1) lookup instead of database call)
          const document = documentMap.get(embedding.documentId);

          if (document) {
            results.push({
              chunk: embedding,
              similarity,
              document: {
                id: document.id,
                title: document.title || document.filename,
                fileName: document.filename,
              },
            });
          }
        }
      }

      return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, maxResults);
    } catch (error) {
      console.error('Error finding similar chunks:', error);
      throw new Error('Failed to find similar chunks');
    }
  }

  /**
   * NEW: Search for similar chunks and group by page for simplified citation system
   * Returns page groups instead of individual chunks
   */
  async searchSimilarGroupedByPage(
    queryEmbedding: Float32Array,
    sessionId: string,
    options: {
      maxResults?: number;
      similarityThreshold?: number;
      documentIds?: string[];
      userId?: string;
    } = {}
  ): Promise<PageGroup[]> {
    try {
      const {
        maxResults = 12, // Increased from 8 to 12 as per user request
        similarityThreshold = 0.7,
        documentIds
      } = options;

      console.log('\n=== SIMPLIFIED VECTOR SEARCH START ===');
      console.log('[SEARCH OPTIONS]', { maxResults, similarityThreshold, documentIds });

      // Get regular search results first
      const searchResults = await this.searchSimilar(queryEmbedding, sessionId, {
        maxResults,
        similarityThreshold,
        documentIds
      });

      console.log('[SEARCH RESULTS]', `Found ${searchResults.length} individual chunks`);

      // Group by page
      const pageGroups = this.groupResultsByPage(searchResults);

      console.log('[PAGE GROUPS]', `Created ${pageGroups.length} page groups`);
      pageGroups.forEach((group, index) => {
        console.log(`[PAGE GROUP ${index + 1}]`, {
          document: group.documentTitle,
          page: group.page,
          chunkCount: group.chunks.length,
          highestSimilarity: Math.max(...group.chunks.map(c => c.similarity))
        });
      });
      console.log('=== SIMPLIFIED VECTOR SEARCH END ===\n');

      return pageGroups;
    } catch (error) {
      console.error('Error in simplified vector search:', error);
      throw new Error('Failed to perform simplified vector search');
    }
  }

  /**
   * Group search results by page for simplified citation system
   */
  private groupResultsByPage(results: VectorSearchResult[]): PageGroup[] {
    const pageMap = new Map<string, PageGroup>();

    for (const result of results) {
      const pageNumber = this.getEffectivePageNumber(result);

      if (pageNumber !== undefined) {
        const pageKey = `${result.document.id}_${pageNumber}`;

        if (!pageMap.has(pageKey)) {
          pageMap.set(pageKey, {
            documentId: result.document.id,
            documentTitle: result.document.title || result.document.fileName,
            page: pageNumber,
            chunks: []
          });
        }

        const pageGroup = pageMap.get(pageKey)!;
        pageGroup.chunks.push({
          id: result.chunk.id,
          content: result.chunk.content,
          similarity: result.similarity
        });
      }
    }

    // Sort page groups by highest similarity and then by document/page
    return Array.from(pageMap.values())
      .sort((a, b) => {
        const maxSimA = Math.max(...a.chunks.map(c => c.similarity));
        const maxSimB = Math.max(...b.chunks.map(c => c.similarity));

        if (maxSimB !== maxSimA) {
          return maxSimB - maxSimA; // Higher similarity first
        }

        // Then sort by document title and page number
        const docCompare = a.documentTitle.localeCompare(b.documentTitle);
        if (docCompare !== 0) {
          return docCompare;
        }

        return a.page - b.page;
      });
  }

  /**
   * Convert page groups back to vector search results for compatibility
   * This maintains backward compatibility with existing code
   */
  pageGroupsToVectorResults(pageGroups: PageGroup[]): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const pageGroup of pageGroups) {
      // For each page group, create a combined result
      // Use the highest scoring chunk as the base
      const sortedChunks = [...pageGroup.chunks].sort((a, b) => b.similarity - a.similarity);
      const highestScoringChunk = sortedChunks[0];

      // Create a mock VectorSearchResult for the page group
      // This is a simplified representation for compatibility
      const combinedResult: VectorSearchResult = {
        chunk: {
          id: `page_${pageGroup.documentId}_${pageGroup.page}`,
          documentId: pageGroup.documentId,
          sessionId: '', // Will be filled by caller if needed
          chunkIndex: 0,
          content: pageGroup.chunks
            .sort((a, b) => a.content.localeCompare(b.content))
            .map(chunk => chunk.content)
            .join('\n---\n'),
          embedding: new Float32Array(0), // Empty embedding since this is combined
          tokenCount: 0,
          embeddingNorm: 0,
          metadata: {
            isCombined: true,
            originalChunkCount: pageGroup.chunks.length,
            combinedChunkIds: pageGroup.chunks.map(c => c.id),
            pageNumber: pageGroup.page,
            pageNumbers: [pageGroup.page],
            chunkIndex: 0,
            startPosition: 0,
            endPosition: 0,
            tokenCount: 0
          },
          createdAt: new Date()
        },
        similarity: highestScoringChunk.similarity,
        document: {
          id: pageGroup.documentId,
          title: pageGroup.documentTitle,
          fileName: pageGroup.documentTitle
        }
      };

      results.push(combinedResult);
    }

    return results;
  }
}

// Singleton instance
export const vectorSearchService = new VectorSearchService();
